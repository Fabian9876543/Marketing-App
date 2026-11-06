import { tiktokConfig } from "../../env";
import { readJson } from "../oauth";
import { PublishError } from "../types";

type TikTokError = { code?: string; message?: string; log_id?: string };

/** Fehlercodes der TikTok-API in eine verständliche PublishError übersetzen. */
export function toTikTokError(status: number, error: TikTokError, context: string): PublishError {
  const code = error.code ?? `http_${status}`;
  const text = `${context}: ${error.message || code} (${code})`;
  switch (code) {
    case "access_token_invalid":
    case "scope_not_authorized":
    case "scope_permission_missed":
      return new PublishError("auth", "TikTok-Anmeldung ungültig oder Rechte fehlen – bitte unter „Konten“ neu verbinden.");
    case "rate_limit_exceeded":
      return new PublishError("retryable", "TikTok bremst gerade (zu viele Anfragen) – gleich noch einmal");
    case "spam_risk_too_many_posts":
    case "spam_risk_too_many_pending_share":
      return new PublishError(
        "quota",
        code === "spam_risk_too_many_pending_share"
          ? "Zu viele offene Entwürfe in deiner TikTok-App – poste oder lösche sie dort; neuer Versuch morgen"
          : "TikTok-Tageslimit für dieses Konto erreicht – neuer Versuch morgen",
        new Date(Date.now() + 24 * 3600_000),
      );
    case "unaudited_client_can_only_post_to_private_accounts":
      return new PublishError(
        "fatal",
        "Ohne TikTok-Audit sind direkte Posts nur auf privaten Konten möglich. Stelle unter „Einstellungen → TikTok“ den Modus „Entwurf in der App“ ein.",
      );
    case "privacy_level_option_mismatch":
      return new PublishError("fatal", "Diese Sichtbarkeit erlaubt TikTok für dein Konto nicht – Modus in den Einstellungen prüfen");
    case "spam_risk_user_banned_from_posting":
      return new PublishError("fatal", "TikTok hat das Posten für dieses Konto gesperrt");
  }
  if (status === 401) return new PublishError("auth", "TikTok-Anmeldung abgelaufen – bitte neu verbinden.");
  if (status === 429 || status >= 500 || code === "internal_error") return new PublishError("retryable", text);
  return new PublishError("fatal", text);
}

/** POST an die TikTok-API mit JSON; liefert `data` oder wirft PublishError. */
export async function ttPost<T>(path: string, token: string, body: unknown, context: string): Promise<T> {
  const res = await fetch(`${tiktokConfig().apiBase}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await readJson<{ data?: T; error?: TikTokError }>(res);
  if (!res.ok || (json.error?.code && json.error.code !== "ok")) throw toTikTokError(res.status, json.error ?? {}, context);
  return json.data as T;
}

const MiB = 1024 * 1024;

/**
 * Aufteilung nach TikToks Regeln: Teile von 5–64 MB; Anzahl = Dateigröße / Teilgröße (abgerundet);
 * der letzte Teil nimmt den Rest auf (bis 128 MB). Kleine Dateien gehen als ein einziger Teil.
 */
export function chunkPlan(size: number, preferred = 10 * MiB): { chunkSize: number; count: number; ranges: [number, number][] } {
  if (size <= 0) throw new PublishError("fatal", "Videodatei ist leer");
  if (size <= preferred) return { chunkSize: size, count: 1, ranges: [[0, size - 1]] };
  const count = Math.floor(size / preferred);
  if (count > 1000) throw new PublishError("fatal", "Video ist zu groß für TikTok");
  const ranges: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const start = i * preferred;
    ranges.push([start, i === count - 1 ? size - 1 : start + preferred - 1]);
  }
  return { chunkSize: preferred, count, ranges };
}

/** Lädt die Datei in Teilen an die von TikTok vergebene Adresse (gültig 1 Stunde). */
export async function uploadChunks(uploadUrl: string, data: Buffer<ArrayBuffer>, mime: string): Promise<void> {
  const { ranges } = chunkPlan(data.length);
  for (const [start, end] of ranges) {
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": mime,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${data.length}`,
      },
      body: data.subarray(start, end + 1),
    });
    if (res.status !== 201 && res.status !== 206 && !res.ok) {
      throw new PublishError(res.status >= 500 || res.status === 429 ? "retryable" : "fatal", `Upload zu TikTok fehlgeschlagen (HTTP ${res.status})`);
    }
  }
}
