import { and, eq } from "drizzle-orm";
import { readTokens } from "../accounts";
import { median } from "../analytics/stats";
import type { DB } from "../db/client";
import { accounts, type Account } from "../db/schema";
import { googleConfig } from "../env";
import { graph } from "../publishing/instagram/graph";
import { PublishError } from "../publishing/types";
import { getAccessToken } from "../publishing/tokens";

/**
 * Öffentliche Beiträge anderer Konten über die offiziellen Schnittstellen:
 * Instagram Business Discovery (andere Business-/Creator-Konten) und die YouTube-Suche.
 */

export class SocialResearchError extends Error {}

/** Ein aktives Konto der Plattform – zuerst aus dem Projekt, sonst aus einem anderen Projekt. */
function anyAccount(db: DB, platform: Account["platform"], projectId: number): Account | undefined {
  const list = db
    .select()
    .from(accounts)
    .where(and(eq(accounts.platform, platform), eq(accounts.status, "active")))
    .all();
  return list.find((a) => a.projectId === projectId) ?? list[0];
}

export const researchAccount = anyAccount;

/* ---------- Instagram ---------- */

export type IgPost = {
  id: string;
  caption: string;
  type: string;
  permalink: string | null;
  timestamp: Date;
  likes: number | null;
  comments: number | null;
  views: number | null;
  /** Views (oder Likes) im Verhältnis zum Median des Kontos */
  ratio: number | null;
};
export type IgProfile = { username: string; name: string; followers: number | null; mediaCount: number | null; biography: string; posts: IgPost[] };

type BdMedia = {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
  view_count?: number;
};

export async function instagramProfile(db: DB, projectId: number, username: string, limit = 30): Promise<IgProfile> {
  const acc = anyAccount(db, "instagram", projectId);
  if (!acc) throw new SocialResearchError("Dafür muss ein Instagram-Business-Konto verbunden sein (Konten → Instagram verbinden).");
  const tokens = await readTokens(acc);
  if (!tokens) throw new SocialResearchError("Instagram-Zugang fehlt – Konto neu verbinden.");
  const user = username.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?instagram\.com\//, "").replace(/\/.*$/, "");
  if (!/^[A-Za-z0-9._]{1,30}$/.test(user)) throw new SocialResearchError(`Ungültiger Instagram-Name: ${username}`);

  const mediaFields = (withViews: boolean) =>
    `id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count${withViews ? ",view_count" : ""}`;
  const fields = (withViews: boolean) =>
    `business_discovery.username(${user}){username,name,biography,followers_count,media_count,media.limit(${Math.min(50, limit)}){${mediaFields(withViews)}}}`;
  type Bd = { business_discovery?: { username?: string; name?: string; biography?: string; followers_count?: number; media_count?: number; media?: { data?: BdMedia[] } } };
  let r: Bd;
  try {
    r = await graph<Bd>("GET", acc.externalId, { fields: fields(true), access_token: tokens.accessToken }, "Instagram-Konto ansehen");
  } catch (err) {
    // Ältere API-Versionen kennen view_count hier nicht
    if (err instanceof PublishError && err.kind === "fatal" && /view_count|field/i.test(err.message)) {
      r = await graph<Bd>("GET", acc.externalId, { fields: fields(false), access_token: tokens.accessToken }, "Instagram-Konto ansehen");
    } else if (err instanceof PublishError && err.kind === "fatal") {
      throw new SocialResearchError(`@${user} nicht gefunden – nur öffentliche Business- oder Creator-Konten lassen sich ansehen.`);
    } else throw err;
  }
  const bd = r.business_discovery;
  if (!bd) throw new SocialResearchError(`@${user} nicht gefunden – nur öffentliche Business- oder Creator-Konten lassen sich ansehen.`);
  const raw = bd.media?.data ?? [];
  const score = (m: BdMedia) => m.view_count ?? m.like_count ?? null;
  const med = median(raw.map(score).filter((x): x is number => x != null));
  return {
    username: bd.username ?? user,
    name: bd.name ?? "",
    followers: bd.followers_count ?? null,
    mediaCount: bd.media_count ?? null,
    biography: bd.biography ?? "",
    posts: raw.map((m) => ({
      id: m.id,
      caption: m.caption ?? "",
      type: m.media_product_type === "REELS" ? "Reel" : m.media_type === "CAROUSEL_ALBUM" ? "Karussell" : m.media_type === "VIDEO" ? "Video" : "Bild",
      permalink: m.permalink ?? null,
      timestamp: new Date(m.timestamp ?? Date.now()),
      likes: m.like_count ?? null,
      comments: m.comments_count ?? null,
      views: m.view_count ?? null,
      ratio: med && score(m) != null ? score(m)! / med : null,
    })),
  };
}

/* ---------- YouTube ---------- */

export type YtShort = {
  id: string;
  title: string;
  channel: string;
  publishedAt: Date;
  durationSec: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  url: string;
};

const isoSeconds = (d?: string) => {
  const m = d?.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  return m ? (Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0) : null;
};
const n = (v?: string) => (v == null ? null : Number(v));

/** Öffentliche Shorts zu einem Suchbegriff (Deutschland, Deutsch), nach Views sortiert. Kostet 101 Einheiten vom YouTube-Tageskontingent. */
export async function searchYoutubeShorts(db: DB, projectId: number, query: string, sinceDays = 90, now = new Date()): Promise<YtShort[]> {
  const acc = anyAccount(db, "youtube", projectId);
  if (!acc) throw new SocialResearchError("Dafür muss ein YouTube-Konto verbunden sein (Konten → YouTube verbinden).");
  const token = await getAccessToken(db, acc);
  const base = `${googleConfig().apiBase}/youtube/v3`;
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${base}/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; errors?: { reason?: string }[] } };
    if (!res.ok) {
      const reason = body.error?.errors?.[0]?.reason;
      if (reason === "quotaExceeded") throw new SocialResearchError("YouTube-Tageskontingent aufgebraucht – morgen erneut versuchen.");
      throw new SocialResearchError(`YouTube-Suche: ${body.error?.message ?? `HTTP ${res.status}`}`);
    }
    return body;
  };
  const after = new Date(now.getTime() - sinceDays * 86_400_000).toISOString();
  const s = await get<{ items?: { id?: { videoId?: string } }[] }>(
    `search?${new URLSearchParams({ part: "snippet", type: "video", videoDuration: "short", order: "viewCount", regionCode: "DE", relevanceLanguage: "de", publishedAfter: after, maxResults: "25", q: query }).toString()}`,
  );
  const ids = (s.items ?? []).map((i) => i.id?.videoId).filter((x): x is string => !!x);
  if (!ids.length) return [];
  const v = await get<{
    items?: { id: string; snippet?: { title?: string; channelTitle?: string; publishedAt?: string }; contentDetails?: { duration?: string }; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }[];
  }>(`videos?part=snippet,statistics,contentDetails&id=${ids.join(",")}`);
  return (v.items ?? [])
    .map((it) => ({
      id: it.id,
      title: it.snippet?.title ?? "",
      channel: it.snippet?.channelTitle ?? "",
      publishedAt: new Date(it.snippet?.publishedAt ?? now),
      durationSec: isoSeconds(it.contentDetails?.duration),
      views: n(it.statistics?.viewCount),
      likes: n(it.statistics?.likeCount),
      comments: n(it.statistics?.commentCount),
      url: `https://youtube.com/shorts/${it.id}`,
    }))
    .filter((x) => x.durationSec == null || x.durationSec <= 180)
    .sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
}
