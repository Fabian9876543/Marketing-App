import fs from "node:fs/promises";
import { googleConfig } from "../../env";
import { PublishError } from "../types";

/** 8 MiB – muss ein Vielfaches von 256 KiB sein. */
export const CHUNK_SIZE = 8 * 1024 * 1024;

export type YtVideoMetadata = {
  snippet: {
    title: string;
    description: string;
    tags?: string[];
    categoryId: string;
    defaultLanguage?: string;
    defaultAudioLanguage?: string;
  };
  status: {
    privacyStatus: "public" | "unlisted" | "private";
    publishAt?: string;
    selfDeclaredMadeForKids: boolean;
    containsSyntheticMedia: boolean;
  };
};

export type YtVideo = { id: string; status?: { uploadStatus?: string; privacyStatus?: string } };

/** Die gespeicherte Upload-Sitzung gibt es bei YouTube nicht mehr – neu starten. */
export class SessionExpiredError extends Error {}

type ErrorBody = { error?: { code?: number; message?: string; errors?: { reason?: string }[] } };

/** HTTP-Fehler der YouTube-API in eine verständliche PublishError übersetzen. */
export async function toYoutubeError(res: Response, context: string): Promise<PublishError> {
  const body = (await res.json().catch(() => ({}))) as ErrorBody;
  const reason = body.error?.errors?.[0]?.reason ?? "";
  const msg = body.error?.message ?? res.statusText;
  const text = `${context}: ${msg}${reason ? ` (${reason})` : ""}`;

  if (res.status === 401) return new PublishError("auth", "YouTube hat die Anmeldung abgelehnt – bitte Konto neu verbinden.");
  if (["quotaExceeded", "dailyLimitExceeded", "uploadLimitExceeded"].includes(reason)) {
    return new PublishError("quota", `YouTube-Tageslimit erreicht – neuer Versuch nach dem Zurücksetzen (Mitternacht US-Westküste). ${msg}`);
  }
  if (res.status === 429 || ["rateLimitExceeded", "userRateLimitExceeded", "backendError"].includes(reason)) {
    return new PublishError("retryable", text);
  }
  if (res.status >= 500) return new PublishError("retryable", text);
  if (reason === "youtubeSignupRequired") {
    return new PublishError("fatal", "Für dieses Google-Konto gibt es noch keinen YouTube-Kanal.");
  }
  return new PublishError("fatal", text);
}

/** Startet einen fortsetzbaren Upload und liefert die Sitzungs-URL. */
export async function startUpload(opts: {
  accessToken: string;
  metadata: YtVideoMetadata;
  size: number;
  mimeType: string;
}): Promise<string> {
  const url = `${googleConfig().apiBase}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(opts.size),
      "X-Upload-Content-Type": opts.mimeType,
    },
    body: JSON.stringify(opts.metadata),
  });
  if (!res.ok) throw await toYoutubeError(res, "Upload konnte nicht gestartet werden");
  const location = res.headers.get("location");
  if (!location) throw new PublishError("retryable", "YouTube hat keine Upload-Adresse geliefert");
  return location;
}

/** Wie weit ist ein unterbrochener Upload? */
export async function queryUpload(
  sessionUrl: string,
  size: number,
  accessToken: string,
): Promise<{ done: true; video: YtVideo } | { done: false; offset: number }> {
  const res = await fetch(sessionUrl, {
    method: "PUT",
    redirect: "manual",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Length": "0", "Content-Range": `bytes */${size}` },
  });
  if (res.status === 200 || res.status === 201) return { done: true, video: (await res.json()) as YtVideo };
  if (res.status === 308) return { done: false, offset: nextOffset(res) };
  if (res.status === 404 || res.status === 410) throw new SessionExpiredError("Upload-Sitzung abgelaufen");
  throw await toYoutubeError(res, "Upload-Status konnte nicht abgefragt werden");
}

/** Lädt die Datei ab `offset` in Teilen hoch und liefert das fertige Video. */
export async function uploadFrom(opts: {
  sessionUrl: string;
  filePath: string;
  size: number;
  offset: number;
  getToken: () => Promise<string>;
  onProgress?: (sent: number, total: number) => void;
}): Promise<YtVideo> {
  const handle = await fs.open(opts.filePath, "r");
  try {
    let offset = opts.offset;
    while (true) {
      const length = Math.min(CHUNK_SIZE, opts.size - offset);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw new PublishError("fatal", "Videodatei hat sich während des Uploads verändert");
      const end = offset + length - 1;
      const res = await fetch(opts.sessionUrl, {
        method: "PUT",
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${await opts.getToken()}`,
          "Content-Length": String(length),
          "Content-Range": `bytes ${offset}-${end}/${opts.size}`,
        },
        body: buffer,
      });
      if (res.status === 200 || res.status === 201) {
        opts.onProgress?.(opts.size, opts.size);
        return (await res.json()) as YtVideo;
      }
      if (res.status === 308) {
        offset = nextOffset(res);
        opts.onProgress?.(offset, opts.size);
        continue;
      }
      if (res.status === 404 || res.status === 410) throw new SessionExpiredError("Upload-Sitzung abgelaufen");
      throw await toYoutubeError(res, "Upload fehlgeschlagen");
    }
  } finally {
    await handle.close();
  }
}

/** Aus der Range-Antwort („bytes=0-1234“) die nächste Startposition lesen. */
function nextOffset(res: Response): number {
  const range = res.headers.get("range");
  const m = range?.match(/bytes=0-(\d+)/);
  return m ? Number(m[1]) + 1 : 0;
}

export async function updateVideoStatus(accessToken: string, videoId: string, status: YtVideoMetadata["status"]): Promise<void> {
  const res = await fetch(`${googleConfig().apiBase}/youtube/v3/videos?part=status`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ id: videoId, status }),
  });
  if (!res.ok) throw await toYoutubeError(res, "Geplante Zeit konnte nicht geändert werden");
}

export async function deleteVideo(accessToken: string, videoId: string): Promise<void> {
  const res = await fetch(`${googleConfig().apiBase}/youtube/v3/videos?id=${encodeURIComponent(videoId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return; // schon weg
  if (!res.ok) throw await toYoutubeError(res, "Video konnte nicht entfernt werden");
}
