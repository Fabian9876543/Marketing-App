import { and, asc, eq, ne } from "drizzle-orm";
import { listAccounts, PLATFORM_LABEL } from "./accounts";
import type { DB } from "./db/client";
import { contents, posts, type Account, type Platform, type Project } from "./db/schema";
import { logEvent } from "./events";
import { createPost, takenTimes } from "./posts";
import { getSettings } from "./settings";
import { listSlots, nextFreeSlot, slotOccurrences } from "./slots";
import { formatDateTime } from "./time";

export type PlanResult = { ok: true; at: Date; accounts: Account[]; postId: number } | { ok: false; reason: string };

/**
 * Legt einen Short in den nächsten freien Slot seines Projekts – immer zur Freigabe (state = review).
 * Gemeinsame Grundlage für Claudes Werkzeug, Automationen und „freie Slots füllen“.
 */
export function planIntoNextSlot(
  db: DB,
  project: Project,
  contentId: number,
  opts: { createdBy: "agent" | "auto"; platforms?: Platform[]; at?: Date } = { createdBy: "auto" },
): PlanResult {
  const accounts = listAccounts(db, { projectId: project.id }).filter(
    (a) => a.status === "active" && (!opts.platforms?.length || opts.platforms.includes(a.platform)),
  );
  if (!accounts.length) return { ok: false, reason: "kein verbundenes Konto im Projekt" };
  const tz = getSettings(db).timezone;
  const at = opts.at ?? nextFreeSlot(listSlots(db, project.id), takenTimes(db, new Date(), project.id), new Date(), tz);
  if (!at) return { ok: false, reason: "keine freie Posting-Zeit" };
  const postId = createPost(db, { contentId, scheduledAt: at, accountIds: accounts.map((a) => a.id), approve: false, createdBy: opts.createdBy });
  return { ok: true, at, accounts, postId };
}

export const describePlan = (r: PlanResult, tz: string) =>
  r.ok ? `${formatDateTime(r.at, tz)} auf ${r.accounts.map((a) => PLATFORM_LABEL[a.platform]).join(", ")}` : r.reason;

/** Shorts eines Projekts, die noch nie eingeplant wurden (abgesagte Posts zählen nicht), älteste zuerst. */
export function unplannedContents(db: DB, projectId: number) {
  const planned = new Set(
    db
      .select({ contentId: posts.contentId })
      .from(posts)
      .innerJoin(contents, eq(contents.id, posts.contentId))
      .where(and(eq(contents.projectId, projectId), ne(posts.state, "cancelled")))
      .all()
      .map((r) => r.contentId),
  );
  return db
    .select()
    .from(contents)
    .where(and(eq(contents.projectId, projectId), eq(contents.available, true)))
    .orderBy(asc(contents.createdAt), asc(contents.id))
    .all()
    .filter((c) => !planned.has(c.id));
}

/**
 * „Freie Slots füllen“: Posting-Zeiten der nächsten Tage, auf denen noch nichts liegt,
 * bekommen den nächsten ungeplanten Short aus dem Backlog – zur Freigabe.
 */
export function autoFillProject(db: DB, project: Project, now = new Date()): number {
  if (!project.autoFill || project.archived) return 0;
  const accounts = listAccounts(db, { projectId: project.id }).filter((a) => a.status === "active");
  if (!accounts.length) return 0;
  const tz = getSettings(db).timezone;
  const taken = new Set(takenTimes(db, now, project.id).map((d) => Math.round(d.getTime() / 60_000)));
  const free = slotOccurrences(listSlots(db, project.id), new Date(now.getTime() + 30 * 60_000), new Date(now.getTime() + project.autoFillDays * 86_400_000), tz).filter(
    (d) => !taken.has(Math.round(d.getTime() / 60_000)),
  );
  const queue = unplannedContents(db, project.id);
  let planned = 0;
  for (const at of free) {
    const content = queue.shift();
    if (!content) break;
    const r = planIntoNextSlot(db, project, content.id, { createdBy: "auto", at });
    if (r.ok) {
      planned++;
      logEvent(db, "info", "automation", `[${project.name}] „${content.title}“ automatisch eingeplant: ${describePlan(r, tz)} – wartet auf Freigabe`);
    }
  }
  return planned;
}
