import { tiktokConfig } from "../env";
import { readJson } from "../publishing/oauth";
import { toTikTokError } from "../publishing/tiktok/api";
import { num, type InsightsFetcher, type MediaStat } from "./types";

type Video = {
  id: string;
  title?: string;
  video_description?: string;
  create_time?: number;
  share_url?: string;
  duration?: number;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  share_count?: number;
};

const FIELDS = "id,title,video_description,create_time,share_url,duration,view_count,like_count,comment_count,share_count";

/** TikTok: öffentliche Videos des Kontos (Berechtigung video.list), neueste zuerst, 20 pro Seite. */
export const tiktokInsights: InsightsFetcher = {
  platform: "tiktok",
  async fetch({ token, since }) {
    const out: MediaStat[] = [];
    let cursor: number | undefined;
    for (let i = 0; i < 15; i++) {
      const res = await fetch(`${tiktokConfig().apiBase}/v2/video/list/?fields=${FIELDS}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ max_count: 20, ...(cursor ? { cursor } : {}) }),
      });
      const json = await readJson<{ data?: { videos?: Video[]; cursor?: number; has_more?: boolean }; error?: { code?: string; message?: string } }>(res);
      if (!res.ok || (json.error?.code && json.error.code !== "ok")) {
        const err = toTikTokError(res.status, json.error ?? {}, "TikTok-Zahlen");
        if (json.error?.code === "scope_not_authorized") {
          throw new Error("Für Zahlen fehlt die Berechtigung „video.list“ – TikTok neu verbinden.");
        }
        throw err;
      }
      let older = false;
      for (const v of json.data?.videos ?? []) {
        const at = new Date((v.create_time ?? 0) * 1000);
        if (at < since) {
          older = true;
          continue;
        }
        out.push({
          externalId: v.id,
          title: (v.title || v.video_description || "").split("\n")[0].slice(0, 200),
          url: v.share_url ?? null,
          publishedAt: at,
          durationSec: num(v.duration),
          views: num(v.view_count),
          likes: num(v.like_count),
          comments: num(v.comment_count),
          shares: num(v.share_count),
        });
      }
      if (older || !json.data?.has_more) break;
      cursor = json.data.cursor;
    }
    return out;
  },
};
