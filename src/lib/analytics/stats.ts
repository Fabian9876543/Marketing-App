import { and, eq, gte, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import { PLATFORM_LABEL } from "../accounts";
import type { DB } from "../db/client";
import { accounts, contents, mediaItems, posts, postTargets, type Account, type MediaItem, type Platform } from "../db/schema";
import { HISTORY_DAYS } from "./store";

/** Erst nach 48 Stunden wird ein Beitrag bewertet – vorher sind die Zahlen noch zu jung. */
export const MIN_AGE_MS = 48 * 3600_000;
export const STRONG_RATIO = 1.5;
export const WEAK_RATIO = 0.5;
/** So viele bewertbare Beiträge braucht ein Kanal für einen Median. */
export const MIN_POSTS = 3;

export type Rating = "stark" | "normal" | "schwach" | "frisch" | "ohne";
export const RATING_LABEL: Record<Rating, string> = { stark: "stark", normal: "normal", schwach: "schwach", frisch: "zu frisch", ohne: "zu wenig Daten" };

export type RatedItem = MediaItem & {
  account: Account;
  platform: Platform;
  projectId: number;
  rating: Rating;
  /** Median der Views des Kanals (90 Tage, ohne Beiträge unter 48 Stunden) */
  channelMedian: number | null;
  /** Views im Verhältnis zum Median des Kanals */
  ratio: number | null;
  /** (Likes + Kommentare + Shares) / Views */
  engagement: number | null;
  /** Über die App veröffentlicht: Ordnername im Backlog */
  contentSlug: string | null;
};

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Beiträge mit Bewertung gegen den Median des eigenen Kanals (letzte 90 Tage). */
export function ratedItems(db: DB, opts: { projectId?: number; days?: number; now?: Date } = {}): RatedItem[] {
  const now = opts.now ?? new Date();
  const accs = db
    .select()
    .from(accounts)
    .where(opts.projectId ? eq(accounts.projectId, opts.projectId) : undefined)
    .all();
  if (!accs.length) return [];
  const items = db
    .select()
    .from(mediaItems)
    .where(and(inArray(mediaItems.accountId, accs.map((a) => a.id)), gte(mediaItems.publishedAt, new Date(now.getTime() - HISTORY_DAYS * 86_400_000))))
    .all();

  // Ordnernamen eigener Posts
  const targetIds = items.map((i) => i.targetId).filter((x): x is number => x != null);
  const slugByTarget = new Map(
    targetIds.length
      ? db
          .select({ targetId: postTargets.id, slug: contents.slug })
          .from(postTargets)
          .innerJoin(posts, eq(posts.id, postTargets.postId))
          .innerJoin(contents, eq(contents.id, posts.contentId))
          .where(inArray(postTargets.id, targetIds))
          .all()
          .map((r) => [r.targetId, r.slug] as const)
      : [],
  );

  const accountById = new Map(accs.map((a) => [a.id, a]));
  const medianByAccount = new Map<number, number | null>();
  for (const a of accs) {
    const views = items
      .filter((i) => i.accountId === a.id && i.views != null && now.getTime() - i.publishedAt.getTime() >= MIN_AGE_MS)
      .map((i) => i.views!);
    medianByAccount.set(a.id, views.length >= MIN_POSTS ? median(views) : null);
  }

  const since = new Date(now.getTime() - (opts.days ?? HISTORY_DAYS) * 86_400_000);
  return items
    .filter((i) => i.publishedAt >= since)
    .map((i) => {
      const account = accountById.get(i.accountId)!;
      const med = medianByAccount.get(i.accountId) ?? null;
      const young = now.getTime() - i.publishedAt.getTime() < MIN_AGE_MS;
      const ratio = med && i.views != null ? i.views / med : null;
      const rating: Rating = young ? "frisch" : ratio == null ? "ohne" : ratio >= STRONG_RATIO ? "stark" : ratio <= WEAK_RATIO ? "schwach" : "normal";
      const interactions = (i.likes ?? 0) + (i.comments ?? 0) + (i.shares ?? 0);
      return {
        ...i,
        account,
        platform: account.platform,
        projectId: account.projectId,
        rating,
        channelMedian: med,
        ratio,
        engagement: i.views ? interactions / i.views : null,
        contentSlug: i.targetId ? (slugByTarget.get(i.targetId) ?? null) : null,
      };
    })
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
}

export type Summary = {
  posts: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  engagement: number | null;
  byPlatform: { platform: Platform; posts: number; views: number }[];
};

export function summarize(items: RatedItem[]): Summary {
  const sum = (k: "views" | "likes" | "comments" | "shares") => items.reduce((t, i) => t + (i[k] ?? 0), 0);
  const views = sum("views");
  const interactions = sum("likes") + sum("comments") + sum("shares");
  const platforms = [...new Set(items.map((i) => i.platform))];
  return {
    posts: items.length,
    views,
    likes: sum("likes"),
    comments: sum("comments"),
    shares: sum("shares"),
    engagement: views ? interactions / views : null,
    byPlatform: platforms
      .map((p) => ({ platform: p, posts: items.filter((i) => i.platform === p).length, views: items.filter((i) => i.platform === p).reduce((t, i) => t + (i.views ?? 0), 0) }))
      .sort((a, b) => b.views - a.views),
  };
}

/** Uhrzeiten (Ortszeit), zu denen Beiträge im Verhältnis zum Kanal am besten laufen. */
export function bestHours(items: RatedItem[], tz: string, top = 3): { hour: number; posts: number; medianRatio: number }[] {
  const byHour = new Map<number, number[]>();
  for (const i of items) {
    if (i.ratio == null || i.rating === "frisch") continue;
    const h = DateTime.fromJSDate(i.publishedAt, { zone: tz }).hour;
    byHour.set(h, [...(byHour.get(h) ?? []), i.ratio]);
  }
  return [...byHour.entries()]
    .filter(([, r]) => r.length >= 2)
    .map(([hour, r]) => ({ hour, posts: r.length, medianRatio: median(r)! }))
    .sort((a, b) => b.medianRatio - a.medianRatio)
    .slice(0, top);
}

const fmt = (n: number | null) => (n == null ? "–" : n.toLocaleString("de-DE"));
const dur = (s: number | null) => (s == null ? "" : ` · ${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

/** Übersicht als Text für Claude (Werkzeug „statistik“ und Wochenanalyse). */
export function statsText(db: DB, projectId: number, days: number, tz: string, now = new Date()): string {
  const items = ratedItems(db, { projectId, days, now });
  if (!items.length) return `Keine Zahlen aus den letzten ${days} Tagen. Sind Konten verbunden und wurden die Zahlen schon abgerufen?`;
  const s = summarize(items);
  const lines = [
    `Zahlen der letzten ${days} Tage: ${s.posts} Beiträge, ${fmt(s.views)} Views, ${fmt(s.likes)} Likes, ${fmt(s.comments)} Kommentare, ${fmt(s.shares)} Shares` +
      (s.engagement != null ? `, Interaktionsrate ${(s.engagement * 100).toFixed(1).replace(".", ",")} %` : "") +
      ".",
    `Bewertung: Views im Verhältnis zum Median des jeweiligen Kanals (90 Tage) – stark ab ×${STRONG_RATIO}, schwach bis ×${WEAK_RATIO}; jünger als 48 Stunden = zu frisch.`,
    "",
    "Datum Uhrzeit · Plattform · Bewertung · Views · Likes · Kommentare · Shares · Länge · Titel · Short im Backlog",
  ];
  for (const i of items) {
    const when = DateTime.fromJSDate(i.publishedAt, { zone: tz }).toFormat("yyyy-LL-dd HH:mm");
    const rating = i.ratio != null && i.rating !== "frisch" ? `${RATING_LABEL[i.rating]} ×${i.ratio.toFixed(1).replace(".", ",")}` : RATING_LABEL[i.rating];
    lines.push(
      `${when} · ${PLATFORM_LABEL[i.platform]} · ${rating} · ${fmt(i.views)} · ${fmt(i.likes)} · ${fmt(i.comments)} · ${fmt(i.shares)}${dur(i.durationSec)} · „${i.title || "(ohne Titel)"}“${i.contentSlug ? ` · ${i.contentSlug}` : ""}`,
    );
  }
  const hours = bestHours(items, tz);
  if (hours.length) lines.push("", `Beste Uhrzeiten: ${hours.map((h) => `${String(h.hour).padStart(2, "0")}:00 (×${h.medianRatio.toFixed(1).replace(".", ",")}, ${h.posts} Beiträge)`).join(", ")}`);
  return lines.join("\n");
}
