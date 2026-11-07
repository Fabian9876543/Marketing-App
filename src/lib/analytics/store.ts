import { and, eq, ne } from "drizzle-orm";
import type { DB } from "../db/client";
import { accounts, mediaItems, metricSnapshots, postTargets, type Account, type Platform } from "../db/schema";
import { logEvent } from "../events";
import { getAccessToken } from "../publishing/tokens";
import { toPublishError } from "../publishing/types";
import { getSettings } from "../settings";
import { instagramInsights } from "./instagram";
import { linkedinInsights, simulatorInsights } from "./others";
import { tiktokInsights } from "./tiktok";
import { InsightsUnavailable, type InsightsFetcher, type MediaStat } from "./types";
import { youtubeInsights } from "./youtube";

export const insightsFetchers: Partial<Record<Platform, InsightsFetcher>> = {
  youtube: youtubeInsights,
  instagram: instagramInsights,
  tiktok: tiktokInsights,
  linkedin: linkedinInsights,
  simulator: simulatorInsights,
};

/** Zeitraum, der abgerufen und ausgewertet wird. */
export const HISTORY_DAYS = 90;

export type RefreshResult = { account: Account; items: number; error?: string; warnings: string[] };

/** Holt die Zahlen eines Kontos und speichert sie (Beiträge, Verlauf, Verknüpfung mit eigenen Posts). */
export async function refreshAccountInsights(
  db: DB,
  account: Account,
  opts: { now?: Date; fetchers?: Partial<Record<Platform, InsightsFetcher>>; token?: (a: Account) => Promise<string> } = {},
): Promise<RefreshResult> {
  const now = opts.now ?? new Date();
  const fetcher = (opts.fetchers ?? insightsFetchers)[account.platform];
  const warnings: string[] = [];
  // insightsAt = letzter Versuch (auch bei Fehlern, sonst würde jede Minute neu versucht); der Fehler steht in insightsError
  const setStatus = (error: string | null) => db.update(accounts).set({ insightsError: error, insightsAt: now }).where(eq(accounts.id, account.id)).run();

  if (!fetcher) return { account, items: 0, warnings };
  let stats: MediaStat[];
  try {
    const token = fetcher.needsToken === false ? "" : await (opts.token ?? ((a) => getAccessToken(db, a)))(account);
    stats = await fetcher.fetch({ db, account, token, since: new Date(now.getTime() - HISTORY_DAYS * 86_400_000), now, warn: (m) => warnings.push(m) });
  } catch (err) {
    const message = err instanceof InsightsUnavailable ? err.message : toPublishError(err).message;
    setStatus(message);
    return { account, items: 0, error: message, warnings };
  }

  // Eigene Posts erkennen: gleiche externe ID auf demselben Konto
  const targets = db
    .select({ id: postTargets.id, externalId: postTargets.externalId })
    .from(postTargets)
    .where(and(eq(postTargets.accountId, account.id), ne(postTargets.state, "cancelled")))
    .all();
  const targetByExternal = new Map(targets.filter((t) => t.externalId).map((t) => [t.externalId!, t.id]));

  db.transaction((tx) => {
    for (const s of stats) {
      const values = {
        accountId: account.id,
        externalId: s.externalId,
        title: s.title,
        url: s.url ?? null,
        publishedAt: s.publishedAt,
        durationSec: s.durationSec ?? null,
        views: s.views,
        likes: s.likes,
        comments: s.comments,
        shares: s.shares,
        saves: s.saves ?? null,
        reach: s.reach ?? null,
        targetId: targetByExternal.get(s.externalId) ?? null,
        fetchedAt: now,
      };
      const item = tx
        .insert(mediaItems)
        .values(values)
        .onConflictDoUpdate({ target: [mediaItems.accountId, mediaItems.externalId], set: values })
        .returning()
        .get();
      // Verlauf: höchstens ein Eintrag pro Stunde
      const hour = new Date(Math.floor(now.getTime() / 3600_000) * 3600_000);
      const exists = tx
        .select({ id: metricSnapshots.id })
        .from(metricSnapshots)
        .where(and(eq(metricSnapshots.mediaId, item.id), eq(metricSnapshots.at, hour)))
        .get();
      const snap = { views: s.views, likes: s.likes, comments: s.comments, shares: s.shares };
      if (exists) tx.update(metricSnapshots).set(snap).where(eq(metricSnapshots.id, exists.id)).run();
      else tx.insert(metricSnapshots).values({ mediaId: item.id, at: hour, ...snap }).run();
    }
  });
  setStatus(warnings.length ? warnings.join(" ") : null);
  return { account, items: stats.length, warnings };
}

/** Konten, deren letzter Abruf älter als das eingestellte Intervall ist (oder die es ausdrücklich verlangen). */
export async function refreshDueInsights(db: DB, now = new Date(), opts: { force?: boolean; projectId?: number } = {}): Promise<RefreshResult[]> {
  const every = getSettings(db).analytics.fetchEveryHours * 3600_000;
  const conds = [eq(accounts.status, "active")];
  if (opts.projectId) conds.push(eq(accounts.projectId, opts.projectId));
  const due = db
    .select()
    .from(accounts)
    .where(and(...conds))
    .all()
    .filter((a) => opts.force || !a.insightsAt || now.getTime() - a.insightsAt.getTime() >= every);
  const results: RefreshResult[] = [];
  for (const a of due) {
    const r = await refreshAccountInsights(db, a, { now });
    results.push(r);
    // Nur neue Fehler melden, nicht bei jedem Versuch denselben
    if (r.error && r.error !== a.insightsError && a.platform !== "linkedin") logEvent(db, "warn", "analytics", `${a.name}: ${r.error}`);
  }
  return results;
}
