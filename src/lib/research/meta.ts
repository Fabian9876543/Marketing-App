import { eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { settings } from "../db/schema";
import { metaConfig } from "../env";
import { decrypt, encrypt } from "../secrets/cipher";
import { getEncryptionKey } from "../secrets/keystore";

/**
 * Meta-Werbebibliothek (Ad Library API, /ads_archive). In der EU enthält sie wegen des DSA alle Anzeigen,
 * die in der EU ausgespielt wurden – mit Texten, Laufzeit, Plattformen, EU-Reichweite und Zielgruppe.
 * Bilder und Videos liefert die Schnittstelle nicht, nur einen Link zur Anzeige.
 *
 * Zugang: ein Nutzer-Token einer bei Meta identitätsbestätigten Person. Es wird beim Verbinden von Instagram
 * mitgespeichert oder von Hand hinterlegt; als letzter Versuch dient das App-Token.
 */

const KEY_ROW = "meta_research";

export class AdLibraryError extends Error {
  constructor(
    message: string,
    /** Zugang verweigert – nächstes Token versuchen */
    readonly access = false,
  ) {
    super(message);
  }
}

type StoredMetaToken = { token: string; expiresAt: number | null; source: "instagram" | "manual" };

export async function setMetaUserToken(db: DB, token: string | null, opts: { expiresAt?: number | null; source?: StoredMetaToken["source"] } = {}): Promise<void> {
  if (!token) {
    db.delete(settings).where(eq(settings.key, KEY_ROW)).run();
    return;
  }
  const { key } = await getEncryptionKey();
  const value = { sealed: encrypt(JSON.stringify({ token, expiresAt: opts.expiresAt ?? null, source: opts.source ?? "manual" }), key) };
  db.insert(settings).values({ key: KEY_ROW, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}

export async function getMetaUserToken(db: DB): Promise<StoredMetaToken | null> {
  const row = db.select().from(settings).where(eq(settings.key, KEY_ROW)).get();
  const sealed = (row?.value as { sealed?: string } | undefined)?.sealed;
  if (!sealed) return null;
  const { key } = await getEncryptionKey();
  return JSON.parse(decrypt(sealed, key)) as StoredMetaToken;
}

/** Ein kurzlebiges Nutzer-Token (z. B. aus dem Graph-API-Explorer) in ein 60-Tage-Token tauschen. */
export async function exchangeLongLived(token: string): Promise<{ token: string; expiresAt: number | null }> {
  const c = metaConfig();
  if (!c.appId || !c.appSecret) return { token, expiresAt: null };
  const url = new URL(`${c.graphBase}/${c.version}/oauth/access_token`);
  url.search = new URLSearchParams({ grant_type: "fb_exchange_token", client_id: c.appId, client_secret: c.appSecret, fb_exchange_token: token }).toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: { message?: string } };
  if (!res.ok || !body.access_token) throw new AdLibraryError(`Meta lehnt das Token ab: ${body.error?.message ?? `HTTP ${res.status}`}`);
  return { token: body.access_token, expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : null };
}

/** Tokens in der Reihenfolge, in der sie versucht werden. Werte verlassen nie den Server. */
export async function adLibraryTokens(db: DB): Promise<{ token: string; label: string }[]> {
  const out: { token: string; label: string }[] = [];
  const user = await getMetaUserToken(db).catch(() => null);
  if (user && (!user.expiresAt || user.expiresAt > Date.now())) {
    out.push({ token: user.token, label: user.source === "instagram" ? "Anmeldung von Instagram" : "hinterlegtes Token" });
  }
  const c = metaConfig();
  if (c.appId && c.appSecret) out.push({ token: `${c.appId}|${c.appSecret}`, label: "App-Zugang" });
  return out;
}

/* ---------- Abfrage ---------- */

export type Ad = {
  id: string;
  pageId: string;
  pageName: string;
  start: Date | null;
  stop: Date | null;
  bodies: string[];
  titles: string[];
  descriptions: string[];
  platforms: string[];
  languages: string[];
  euReach: number | null;
  targetAges: string[];
  targetGender: string | null;
  targetLocations: string[];
  /** Öffentlicher Link zur Anzeige in der Werbebibliothek (ohne Token) */
  link: string;
};

const FIELDS = [
  "id",
  "page_id",
  "page_name",
  "ad_delivery_start_time",
  "ad_delivery_stop_time",
  "ad_creative_bodies",
  "ad_creative_link_titles",
  "ad_creative_link_descriptions",
  "publisher_platforms",
  "languages",
  "eu_total_reach",
  "target_ages",
  "target_gender",
  "target_locations",
].join(",");

type ApiAd = {
  id: string;
  page_id?: string;
  page_name?: string;
  ad_delivery_start_time?: string;
  ad_delivery_stop_time?: string;
  ad_creative_bodies?: string[];
  ad_creative_link_titles?: string[];
  ad_creative_link_descriptions?: string[];
  publisher_platforms?: string[];
  languages?: string[];
  eu_total_reach?: number;
  target_ages?: string[];
  target_gender?: string;
  target_locations?: { name?: string; excluded?: boolean }[];
};

type GraphError = { error?: { message?: string; code?: number; error_subcode?: number; error_user_msg?: string } };

function toError(status: number, body: GraphError): AdLibraryError {
  const e = body.error ?? {};
  const msg = e.error_user_msg || e.message || `HTTP ${status}`;
  if (e.code === 190) return new AdLibraryError("Der Meta-Zugang ist abgelaufen oder ungültig – Instagram neu verbinden oder unter Einstellungen ein neues Token hinterlegen.", true);
  if (e.code === 10 || e.code === 200 || (e.code ?? 0) >= 2332000 || e.error_subcode === 2332002 || e.error_subcode === 2332004 || status === 403) {
    return new AdLibraryError(
      "Meta gibt die Werbebibliothek für diesen Zugang nicht frei. Nötig sind: Identitätsbestätigung unter facebook.com/ID, das Produkt „Ad Library API“ in deiner Meta-App und ein Nutzer-Token dieser Person (siehe Einrichtung).",
      true,
    );
  }
  if ([4, 17, 32, 613].includes(e.code ?? -1) || status === 429) return new AdLibraryError("Meta begrenzt gerade die Abfragen der Werbebibliothek – in einer Stunde erneut versuchen.");
  return new AdLibraryError(`Werbebibliothek: ${msg}`);
}

export const days = (from: Date, to: Date) => Math.max(0, Math.round((to.getTime() - from.getTime()) / 86_400_000));

export async function searchAds(
  token: string,
  q: { terms?: string; pageIds?: string[]; country?: string; activeOnly?: boolean; limit?: number },
): Promise<Ad[]> {
  if (!q.terms?.trim() && !q.pageIds?.length) throw new AdLibraryError("Suchbegriff oder Seiten-ID angeben");
  const c = metaConfig();
  const params: Record<string, string> = {
    ad_reached_countries: JSON.stringify([q.country ?? "DE"]),
    ad_active_status: q.activeOnly === false ? "ALL" : "ACTIVE",
    ad_type: "ALL",
    fields: FIELDS,
    limit: String(Math.min(100, q.limit ?? 50)),
    access_token: token,
  };
  if (q.terms?.trim()) Object.assign(params, { search_terms: q.terms.trim(), search_type: "KEYWORD_UNORDERED" });
  if (q.pageIds?.length) params.search_page_ids = JSON.stringify(q.pageIds.slice(0, 10).map((id) => id.trim()));

  const out: Ad[] = [];
  let url: URL | null = new URL(`${c.graphBase}/${c.version}/ads_archive`);
  url.search = new URLSearchParams(params).toString();
  const want = q.limit ?? 50;
  for (let page = 0; url && page < 5 && out.length < want; page++) {
    const res: Response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    const body = (await res.json().catch(() => ({}))) as { data?: ApiAd[]; paging?: { next?: string } } & GraphError;
    if (!res.ok || body.error) throw toError(res.status, body);
    for (const a of body.data ?? []) {
      out.push({
        id: a.id,
        pageId: a.page_id ?? "",
        pageName: a.page_name ?? "",
        start: a.ad_delivery_start_time ? new Date(a.ad_delivery_start_time) : null,
        stop: a.ad_delivery_stop_time ? new Date(a.ad_delivery_stop_time) : null,
        bodies: a.ad_creative_bodies ?? [],
        titles: a.ad_creative_link_titles ?? [],
        descriptions: a.ad_creative_link_descriptions ?? [],
        platforms: a.publisher_platforms ?? [],
        languages: a.languages ?? [],
        euReach: a.eu_total_reach ?? null,
        targetAges: a.target_ages ?? [],
        targetGender: a.target_gender ?? null,
        targetLocations: (a.target_locations ?? []).filter((l) => !l.excluded && l.name).map((l) => l.name!),
        link: `https://www.facebook.com/ads/library/?id=${encodeURIComponent(a.id)}`,
      });
    }
    // Die nächste Seite enthält das Token in der Adresse – nur intern verwenden
    url = body.paging?.next ? new URL(body.paging.next) : null;
  }
  return out.slice(0, want);
}

/** Probiert die vorhandenen Zugänge nacheinander. */
export async function searchAdsWithAnyToken(db: DB, q: Parameters<typeof searchAds>[1]): Promise<{ ads: Ad[]; via: string }> {
  const tokens = await adLibraryTokens(db);
  if (!tokens.length) {
    throw new AdLibraryError("Kein Meta-Zugang: Instagram verbinden oder unter Einstellungen → Recherche ein Token hinterlegen (siehe Einrichtung).");
  }
  let last: AdLibraryError | null = null;
  for (const t of tokens) {
    try {
      return { ads: await searchAds(t.token, q), via: t.label };
    } catch (err) {
      if (!(err instanceof AdLibraryError) || !err.access) throw err;
      last = err;
    }
  }
  throw last!;
}
