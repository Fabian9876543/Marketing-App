import { googleConfig } from "../env";
import { readJson } from "../publishing/oauth";
import { toYoutubeError } from "../publishing/youtube/api";
import { num, type InsightsFetcher, type MediaStat } from "./types";

/** ISO-8601-Dauer („PT1M5S“) in Sekunden. */
export function isoDuration(d: string | undefined): number | null {
  const m = d?.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  return (Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

async function yt<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${googleConfig().apiBase}/youtube/v3/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw await toYoutubeError(res, "YouTube-Zahlen");
  return readJson<T>(res);
}

/** YouTube: Uploads des Kanals (Upload-Playlist) und deren Statistik. */
export const youtubeInsights: InsightsFetcher = {
  platform: "youtube",
  async fetch({ token, since }) {
    const ch = await yt<{ items?: { contentDetails?: { relatedPlaylists?: { uploads?: string } } }[] }>("channels?part=contentDetails&mine=true", token);
    const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return [];

    const ids: string[] = [];
    let page = "";
    for (let i = 0; i < 10; i++) {
      const pl = await yt<{ items?: { contentDetails?: { videoId?: string; videoPublishedAt?: string } }[]; nextPageToken?: string }>(
        `playlistItems?part=contentDetails&maxResults=50&playlistId=${encodeURIComponent(uploads)}${page ? `&pageToken=${page}` : ""}`,
        token,
      );
      let older = false;
      for (const it of pl.items ?? []) {
        const at = it.contentDetails?.videoPublishedAt ? new Date(it.contentDetails.videoPublishedAt) : null;
        if (at && at < since) older = true;
        else if (it.contentDetails?.videoId) ids.push(it.contentDetails.videoId);
      }
      if (older || !pl.nextPageToken) break;
      page = pl.nextPageToken;
    }

    const out: MediaStat[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const v = await yt<{
        items?: {
          id: string;
          snippet?: { title?: string; publishedAt?: string };
          contentDetails?: { duration?: string };
          statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
        }[];
      }>(`videos?part=snippet,statistics,contentDetails&id=${batch.join(",")}`, token);
      for (const it of v.items ?? []) {
        const duration = isoDuration(it.contentDetails?.duration);
        out.push({
          externalId: it.id,
          title: it.snippet?.title ?? "",
          url: duration != null && duration <= 180 ? `https://youtube.com/shorts/${it.id}` : `https://www.youtube.com/watch?v=${it.id}`,
          publishedAt: new Date(it.snippet?.publishedAt ?? Date.now()),
          durationSec: duration,
          views: num(it.statistics?.viewCount),
          likes: num(it.statistics?.likeCount),
          comments: num(it.statistics?.commentCount),
          shares: null, // liefert die Data API nicht
        });
      }
    }
    return out;
  },
};
