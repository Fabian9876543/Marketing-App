import { and, asc, eq, gte, inArray, ne } from "drizzle-orm";
import type { DB } from "./db/client";
import {
  accounts,
  contents,
  posts,
  postTargets,
  type Account,
  type Content,
  type Post,
  type PostTarget,
} from "./db/schema";

export type TargetView = PostTarget & { account: Account };
export type DisplayState =
  | "review"
  | "planned"
  | "platform"
  | "uploading"
  | "published"
  | "partial"
  | "failed"
  | "cancelled";
export type PostView = Post & { content: Content; targets: TargetView[]; display: DisplayState };

export const DISPLAY_LABEL: Record<DisplayState, string> = {
  review: "Zur Freigabe",
  planned: "Geplant",
  platform: "Bei Plattform eingeplant",
  uploading: "Wird veröffentlicht",
  published: "Veröffentlicht",
  partial: "Teilweise veröffentlicht",
  failed: "Fehler",
  cancelled: "Abgesagt",
};

export const TARGET_LABEL: Record<PostTarget["state"], string> = {
  pending: "Wartet",
  uploading: "Wird hochgeladen",
  scheduled: "Bei Plattform eingeplant",
  published: "Veröffentlicht",
  handed_off: "Entwurf in der App",
  failed: "Fehlgeschlagen",
  missed: "Verpasst",
  cancelled: "Abgebrochen",
};

export function displayState(post: Post, targets: PostTarget[]): DisplayState {
  if (post.state === "cancelled") return "cancelled";
  const live = targets.filter((t) => t.state !== "cancelled");
  if (live.some((t) => t.state === "failed" || t.state === "missed")) return "failed";
  if (post.state === "review") return "review";
  const done = (t: PostTarget) => t.state === "published" || t.state === "handed_off";
  if (live.some((t) => t.state === "uploading")) return "uploading";
  if (live.length && live.every(done)) return "published";
  if (live.some(done)) return "partial";
  if (live.length && live.every((t) => t.state === "scheduled" || done(t))) return "platform";
  return "planned";
}

export class PostError extends Error {}

export function createPost(
  db: DB,
  input: { contentId: number; scheduledAt: Date; accountIds: number[]; approve: boolean; createdBy?: "user" | "agent" },
): number {
  const content = db.select().from(contents).where(eq(contents.id, input.contentId)).get();
  if (!content) throw new PostError("Inhalt nicht gefunden");
  if (!content.available) throw new PostError("Die Videodatei fehlt im Backlog-Ordner");
  const ids = [...new Set(input.accountIds)];
  if (!ids.length) throw new PostError("Mindestens ein Konto auswählen");
  const accs = db.select().from(accounts).where(inArray(accounts.id, ids)).all();
  if (accs.length !== ids.length || accs.some((a) => a.status === "disabled")) {
    throw new PostError("Eines der Konten ist nicht verbunden");
  }
  if (input.scheduledAt.getTime() < Date.now() - 60_000) throw new PostError("Die Zeit liegt in der Vergangenheit");

  return db.transaction((tx) => {
    const post = tx
      .insert(posts)
      .values({
        contentId: content.id,
        scheduledAt: input.scheduledAt,
        state: input.approve ? "approved" : "review",
        createdBy: input.createdBy ?? "user",
      })
      .returning()
      .get();
    for (const accountId of ids) tx.insert(postTargets).values({ postId: post.id, accountId }).run();
    return post.id;
  });
}

function requirePost(db: DB, id: number): Post {
  const post = db.select().from(posts).where(eq(posts.id, id)).get();
  if (!post) throw new PostError("Post nicht gefunden");
  return post;
}

/** Freigeben. Ist die geplante Zeit schon vorbei, wird sofort veröffentlicht. */
export function approvePost(db: DB, id: number, now = new Date()): void {
  const post = requirePost(db, id);
  if (post.state !== "review") return;
  db.transaction((tx) => {
    tx.update(posts).set({ state: "approved" }).where(eq(posts.id, id)).run();
    if (post.scheduledAt < now) {
      tx.update(postTargets)
        .set({ nextAttemptAt: now })
        .where(and(eq(postTargets.postId, id), eq(postTargets.state, "pending")))
        .run();
    }
  });
}

export function approveAll(db: DB, now = new Date()): number {
  const ids = db.select({ id: posts.id }).from(posts).where(eq(posts.state, "review")).all();
  for (const { id } of ids) approvePost(db, id, now);
  return ids.length;
}

export function reschedulePost(db: DB, id: number, at: Date): void {
  const post = requirePost(db, id);
  if (post.state === "cancelled") throw new PostError("Der Post ist abgesagt");
  const targets = db.select().from(postTargets).where(eq(postTargets.postId, id)).all();
  if (targets.some((t) => t.state === "uploading")) throw new PostError("Wird gerade hochgeladen – bitte gleich noch einmal versuchen");
  if (at.getTime() < Date.now() - 60_000) throw new PostError("Die Zeit liegt in der Vergangenheit");
  db.transaction((tx) => {
    tx.update(posts).set({ scheduledAt: at }).where(eq(posts.id, id)).run();
    for (const t of targets) {
      if (t.state === "pending" || t.state === "failed" || t.state === "missed") {
        tx.update(postTargets)
          .set({ state: "pending", attempts: 0, nextAttemptAt: null, lastError: null })
          .where(eq(postTargets.id, t.id))
          .run();
      } else if (t.state === "scheduled") {
        tx.update(postTargets).set({ syncNeeded: true }).where(eq(postTargets.id, t.id)).run();
      }
    }
  });
}

export function cancelPost(db: DB, id: number): void {
  requirePost(db, id);
  const targets = db.select().from(postTargets).where(eq(postTargets.postId, id)).all();
  if (targets.some((t) => t.state === "uploading")) throw new PostError("Wird gerade hochgeladen – bitte gleich noch einmal versuchen");
  db.transaction((tx) => {
    tx.update(posts).set({ state: "cancelled" }).where(eq(posts.id, id)).run();
    for (const t of targets) {
      if (t.state === "pending" || t.state === "failed" || t.state === "missed") {
        tx.update(postTargets).set({ state: "cancelled" }).where(eq(postTargets.id, t.id)).run();
      } else if (t.state === "scheduled") {
        // Bereits bei der Plattform eingeplant: Worker entfernt es dort.
        tx.update(postTargets).set({ syncNeeded: true }).where(eq(postTargets.id, t.id)).run();
      }
    }
  });
}

export function retryTarget(db: DB, targetId: number): void {
  const target = db.select().from(postTargets).where(eq(postTargets.id, targetId)).get();
  if (!target) throw new PostError("Veröffentlichung nicht gefunden");
  if (target.state !== "failed" && target.state !== "missed") return;
  const post = requirePost(db, target.postId);
  if (post.state === "cancelled") throw new PostError("Der Post ist abgesagt");
  db.transaction((tx) => {
    if (post.state === "review") tx.update(posts).set({ state: "approved" }).where(eq(posts.id, post.id)).run();
    tx.update(postTargets)
      .set({ state: "pending", attempts: 0, lastError: null, nextAttemptAt: new Date() })
      .where(eq(postTargets.id, targetId))
      .run();
  });
}

export function deletePost(db: DB, id: number): void {
  requirePost(db, id);
  const targets = db.select().from(postTargets).where(eq(postTargets.postId, id)).all();
  if (targets.some((t) => ["uploading", "scheduled", "published", "handed_off"].includes(t.state))) {
    throw new PostError("Bereits hochgeladene Posts können nur abgesagt, nicht gelöscht werden");
  }
  db.delete(posts).where(eq(posts.id, id)).run();
}

/** Belegte Zeiten (für die Slot-Suche). */
export function takenTimes(db: DB, from: Date): Date[] {
  return db
    .select({ at: posts.scheduledAt })
    .from(posts)
    .where(and(ne(posts.state, "cancelled"), gte(posts.scheduledAt, from)))
    .all()
    .map((r) => r.at);
}

/** Posts mit Inhalt, Zielen und Konten laden. */
export function listPostViews(db: DB, opts: { from?: Date; to?: Date; includeCancelled?: boolean } = {}): PostView[] {
  const conds = [];
  if (opts.from) conds.push(gte(posts.scheduledAt, opts.from));
  if (!opts.includeCancelled) conds.push(ne(posts.state, "cancelled"));
  let rows = db
    .select()
    .from(posts)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(posts.scheduledAt))
    .all();
  if (opts.to) rows = rows.filter((p) => p.scheduledAt <= opts.to!);
  return enrich(db, rows);
}

export function getPostView(db: DB, id: number): PostView | undefined {
  const post = db.select().from(posts).where(eq(posts.id, id)).get();
  return post ? enrich(db, [post])[0] : undefined;
}

function enrich(db: DB, rows: Post[]): PostView[] {
  if (!rows.length) return [];
  const contentRows = db
    .select()
    .from(contents)
    .where(inArray(contents.id, [...new Set(rows.map((p) => p.contentId))]))
    .all();
  const targetRows = db
    .select()
    .from(postTargets)
    .where(inArray(postTargets.postId, rows.map((p) => p.id)))
    .all();
  const accountRows = targetRows.length
    ? db
        .select()
        .from(accounts)
        .where(inArray(accounts.id, [...new Set(targetRows.map((t) => t.accountId))]))
        .all()
    : [];
  const contentById = new Map(contentRows.map((c) => [c.id, c]));
  const accountById = new Map(accountRows.map((a) => [a.id, a]));
  return rows.map((p) => {
    const targets = targetRows
      .filter((t) => t.postId === p.id)
      .map((t) => ({ ...t, account: accountById.get(t.accountId)! }));
    return { ...p, content: contentById.get(p.contentId)!, targets, display: displayState(p, targets) };
  });
}

/** Wie oft ist ein Inhalt eingeplant bzw. veröffentlicht? */
export function contentUsage(db: DB): Map<number, { planned: number; published: number }> {
  const views = listPostViews(db);
  const map = new Map<number, { planned: number; published: number }>();
  for (const v of views) {
    const u = map.get(v.contentId) ?? { planned: 0, published: 0 };
    if (v.display === "published" || v.display === "partial") u.published++;
    else u.planned++;
    map.set(v.contentId, u);
  }
  return map;
}
