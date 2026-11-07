import { graph } from "../publishing/instagram/graph";
import { PublishError } from "../publishing/types";
import { num, type InsightsFetcher, type MediaStat } from "./types";

type Media = {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
};

/** Reels-Kennzahlen: „views“ ersetzt seit 2025 die alten „plays“. */
const METRIC_SETS = ["views,reach,shares,saved", "reach,shares,saved"];

/**
 * Instagram: Beiträge des Kontos (Likes/Kommentare direkt) und – mit der Berechtigung
 * instagram_manage_insights – Views, Reichweite, Shares und Speicherungen.
 */
export const instagramInsights: InsightsFetcher = {
  platform: "instagram",
  async fetch({ account, token, since, warn }) {
    const media: Media[] = [];
    let after = "";
    for (let i = 0; i < 10; i++) {
      const page = await graph<{ data?: Media[]; paging?: { cursors?: { after?: string }; next?: string } }>(
        "GET",
        `${account.externalId}/media`,
        {
          fields: "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count",
          limit: "50",
          access_token: token,
          ...(after ? { after } : {}),
        },
        "Instagram-Beiträge lesen",
      );
      let older = false;
      for (const m of page.data ?? []) {
        if (m.timestamp && new Date(m.timestamp) < since) older = true;
        else media.push(m);
      }
      if (older || !page.paging?.next || !page.paging.cursors?.after) break;
      after = page.paging.cursors.after;
    }

    let insightsOk = true;
    const out: MediaStat[] = [];
    for (const m of media) {
      const stat: MediaStat = {
        externalId: m.id,
        title: (m.caption ?? "").split("\n")[0].slice(0, 200),
        url: m.permalink ?? null,
        publishedAt: new Date(m.timestamp ?? Date.now()),
        views: null,
        likes: num(m.like_count),
        comments: num(m.comments_count),
        shares: null,
        saves: null,
        reach: null,
      };
      if (insightsOk) {
        const ins = await mediaInsights(m.id, token).catch((err: unknown) => {
          if (err instanceof PublishError && err.kind === "auth") {
            insightsOk = false;
            warn("Für Views, Reichweite und Shares fehlt die Berechtigung „instagram_manage_insights“ – Instagram neu verbinden.");
          }
          return null;
        });
        if (ins) Object.assign(stat, ins);
      }
      out.push(stat);
    }
    return out;
  },
};

async function mediaInsights(id: string, token: string): Promise<Partial<MediaStat> | null> {
  for (const metric of METRIC_SETS) {
    try {
      const r = await graph<{ data?: { name: string; values?: { value?: number }[]; total_value?: { value?: number } }[] }>(
        "GET",
        `${id}/insights`,
        { metric, access_token: token },
        "Instagram-Insights",
      );
      const get = (name: string) => {
        const d = r.data?.find((x) => x.name === name);
        return num(d?.values?.[0]?.value ?? d?.total_value?.value);
      };
      return { views: get("views"), reach: get("reach"), shares: get("shares"), saves: get("saved") };
    } catch (err) {
      // Ungültige Kennzahl (ältere API-Version, Bild statt Reel) → mit kleinerem Satz erneut versuchen
      if (err instanceof PublishError && err.kind === "fatal") continue;
      throw err;
    }
  }
  return null;
}
