import { and, eq } from "drizzle-orm";
import { contents, posts, postTargets } from "../db/schema";
import { InsightsUnavailable, type InsightsFetcher, type MediaStat } from "./types";

/** LinkedIn gibt Zahlen zu persönlichen Posts nur nach Freigabe heraus. */
export const linkedinInsights: InsightsFetcher = {
  platform: "linkedin",
  async fetch() {
    throw new InsightsUnavailable(
      "LinkedIn liefert Zahlen zu persönlichen Posts nur nach Freigabe der Community Management API (Berechtigung r_member_postAnalytics).",
    );
  },
};

/** Gleichmäßig verteilte Zahl 0…1 aus einer ID (immer gleich für dieselbe ID). */
function hash01(n: number): number {
  const x = Math.sin(n * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

/**
 * Test-Kanal: erfundene, aber plausible Zahlen für die über die App „veröffentlichten“ Posts,
 * damit sich Analytics ohne echte Konten ausprobieren lässt. Wachsen in den ersten Tagen und bleiben dann stabil.
 */
export const simulatorInsights: InsightsFetcher = {
  platform: "simulator",
  needsToken: false,
  async fetch({ db, account, since, now }) {
    const rows = db
      .select({ target: postTargets, title: contents.title, duration: contents.durationSec })
      .from(postTargets)
      .innerJoin(posts, eq(posts.id, postTargets.postId))
      .innerJoin(contents, eq(contents.id, posts.contentId))
      .where(and(eq(postTargets.accountId, account.id), eq(postTargets.state, "published")))
      .all();
    return rows
      .filter((r) => r.target.publishedAt && r.target.publishedAt >= since)
      .map((r): MediaStat => {
        const h = hash01(r.target.id);
        const hours = Math.max(0, (now.getTime() - r.target.publishedAt!.getTime()) / 3600_000);
        const potential = Math.round(150 + Math.pow(h, 2) * 4000);
        const views = Math.round(potential * (1 - Math.exp(-hours / 30)));
        return {
          externalId: r.target.externalId ?? `test-${r.target.id}`,
          title: r.title,
          url: null,
          publishedAt: r.target.publishedAt!,
          durationSec: r.duration,
          views,
          likes: Math.round(views * (0.02 + h * 0.05)),
          comments: Math.round(views * 0.004 * h),
          shares: Math.round(views * 0.006 * (1 - h / 2)),
        };
      });
  },
};
