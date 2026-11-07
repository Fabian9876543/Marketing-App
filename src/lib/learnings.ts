import { and, asc, eq, inArray } from "drizzle-orm";
import type { DB } from "./db/client";
import { learnings, type Learning } from "./db/schema";
import { writeBriefFile } from "./projects";

export class LearningError extends Error {}

export function listLearnings(db: DB, projectId: number, status?: Learning["status"][]): Learning[] {
  return db
    .select()
    .from(learnings)
    .where(status ? and(eq(learnings.projectId, projectId), inArray(learnings.status, status)) : eq(learnings.projectId, projectId))
    .orderBy(asc(learnings.id))
    .all();
}

export const acceptedLearnings = (db: DB, projectId: number) => listLearnings(db, projectId, ["accepted"]);

const clean = (t: string) => t.trim().replace(/\s+/g, " ");

/** Vorschlag (meist von Claude). Gilt erst, wenn du ihn bestätigst. Doppelte Vorschläge werden ignoriert. */
export function proposeLearning(db: DB, projectId: number, text: string, reason = ""): Learning | null {
  const t = clean(text);
  if (t.length < 5) throw new LearningError("Die Erkenntnis ist zu kurz");
  const exists = listLearnings(db, projectId, ["proposed", "accepted"]).some((l) => l.text.toLowerCase() === t.toLowerCase());
  if (exists) return null;
  return db.insert(learnings).values({ projectId, text: t, reason: clean(reason), status: "proposed", source: "analysis" }).returning().get();
}

/** Eigene Erkenntnis – gilt sofort. */
export function addManualLearning(db: DB, projectId: number, text: string): Learning {
  const t = clean(text);
  if (t.length < 5) throw new LearningError("Die Erkenntnis ist zu kurz");
  const l = db.insert(learnings).values({ projectId, text: t, status: "accepted", source: "manual", decidedAt: new Date() }).returning().get();
  writeBriefFile(db, projectId);
  return l;
}

/** Vorschlag übernehmen (optional mit geändertem Text) oder ablehnen. */
export function decideLearning(db: DB, id: number, decision: "accepted" | "rejected", text?: string): Learning {
  const l = db.select().from(learnings).where(eq(learnings.id, id)).get();
  if (!l) throw new LearningError("Erkenntnis nicht gefunden");
  const updated = db
    .update(learnings)
    .set({ status: decision, decidedAt: new Date(), ...(text && clean(text) ? { text: clean(text) } : {}) })
    .where(eq(learnings.id, id))
    .returning()
    .get();
  writeBriefFile(db, l.projectId);
  return updated;
}

/** Bestätigte Erkenntnis wieder entfernen. */
export function removeLearning(db: DB, id: number): void {
  const l = db.select().from(learnings).where(eq(learnings.id, id)).get();
  if (!l) return;
  db.delete(learnings).where(eq(learnings.id, id)).run();
  writeBriefFile(db, l.projectId);
}
