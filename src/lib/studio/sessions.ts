import crypto from "node:crypto";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import type { DB } from "../db/client";
import { studioMessages, studioRuns, studioSessions, type StudioMessage, type StudioRun, type StudioSession } from "../db/schema";

export class StudioError extends Error {}

export type SessionSummary = StudioSession & { lastRun: StudioRun | null };

/** Neuer Chat mit erstem Auftrag. */
export function createSession(db: DB, projectId: number, prompt: string, title?: string): { session: StudioSession; run: StudioRun } {
  const text = prompt.trim();
  if (!text) throw new StudioError("Bitte schreib, was Claude tun soll");
  return db.transaction((tx) => {
    const session = tx
      .insert(studioSessions)
      .values({ projectId, title: title?.trim() || titleFrom(text), claudeSessionId: crypto.randomUUID() })
      .returning()
      .get();
    const run = tx.insert(studioRuns).values({ sessionId: session.id, prompt: text }).returning().get();
    tx.insert(studioMessages).values({ sessionId: session.id, runId: run.id, kind: "user", text }).run();
    return { session, run };
  });
}

/** Folgeauftrag in einem bestehenden Chat. */
export function sendMessage(db: DB, sessionId: number, prompt: string): StudioRun {
  const text = prompt.trim();
  if (!text) throw new StudioError("Bitte schreib, was Claude tun soll");
  const session = db.select().from(studioSessions).where(eq(studioSessions.id, sessionId)).get();
  if (!session) throw new StudioError("Chat nicht gefunden");
  if (activeRun(db, sessionId)) throw new StudioError("Claude arbeitet noch – warte, bis der aktuelle Auftrag fertig ist, oder brich ihn ab");
  return db.transaction((tx) => {
    const run = tx.insert(studioRuns).values({ sessionId, prompt: text }).returning().get();
    tx.insert(studioMessages).values({ sessionId, runId: run.id, kind: "user", text }).run();
    tx.update(studioSessions).set({ updatedAt: new Date() }).where(eq(studioSessions.id, sessionId)).run();
    return run;
  });
}

export function activeRun(db: DB, sessionId: number): StudioRun | undefined {
  return db
    .select()
    .from(studioRuns)
    .where(and(eq(studioRuns.sessionId, sessionId), inArray(studioRuns.state, ["queued", "running"])))
    .get();
}

/** Abbrechen: wartende Aufträge sofort, laufende beendet der Worker. */
export function cancelSession(db: DB, sessionId: number): boolean {
  const run = activeRun(db, sessionId);
  if (!run) return false;
  if (run.state === "queued") {
    db.update(studioRuns).set({ state: "cancelled", endedAt: new Date() }).where(eq(studioRuns.id, run.id)).run();
    addMessage(db, sessionId, run.id, "info", "Abgebrochen, bevor Claude angefangen hat.");
  } else {
    db.update(studioRuns).set({ cancelRequested: true }).where(eq(studioRuns.id, run.id)).run();
  }
  return true;
}

export function deleteSession(db: DB, sessionId: number): void {
  if (activeRun(db, sessionId)) throw new StudioError("Erst abbrechen, dann löschen");
  db.delete(studioSessions).where(eq(studioSessions.id, sessionId)).run();
}

export function getSession(db: DB, sessionId: number): StudioSession | undefined {
  return db.select().from(studioSessions).where(eq(studioSessions.id, sessionId)).get();
}

export function listSessions(db: DB, projectId: number): SessionSummary[] {
  const sessions = db.select().from(studioSessions).where(eq(studioSessions.projectId, projectId)).orderBy(desc(studioSessions.updatedAt)).all();
  if (!sessions.length) return [];
  const runs = db
    .select()
    .from(studioRuns)
    .where(inArray(studioRuns.sessionId, sessions.map((s) => s.id)))
    .orderBy(desc(studioRuns.id))
    .all();
  return sessions.map((s) => ({ ...s, lastRun: runs.find((r) => r.sessionId === s.id) ?? null }));
}

export function sessionMessages(db: DB, sessionId: number, afterId = 0): StudioMessage[] {
  return db
    .select()
    .from(studioMessages)
    .where(and(eq(studioMessages.sessionId, sessionId), gt(studioMessages.id, afterId)))
    .orderBy(asc(studioMessages.id))
    .all();
}

export function sessionRuns(db: DB, sessionId: number): StudioRun[] {
  return db.select().from(studioRuns).where(eq(studioRuns.sessionId, sessionId)).orderBy(asc(studioRuns.id)).all();
}

export function addMessage(
  db: DB,
  sessionId: number,
  runId: number | null,
  kind: StudioMessage["kind"],
  text: string,
  extra: { toolName?: string; isError?: boolean } = {},
): void {
  db.insert(studioMessages)
    .values({ sessionId, runId, kind, text, toolName: extra.toolName ?? null, isError: extra.isError ?? false })
    .run();
}

function titleFrom(prompt: string): string {
  const first = prompt.split("\n")[0].trim();
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first;
}

/** Vorlagen für die Schnellaktionen im Studio. */
export const QUICK_PROMPTS: { key: string; label: string; prompt: string }[] = [
  {
    key: "short",
    label: "Neuen Short machen",
    prompt:
      "Mach einen neuen Short für dieses Projekt. Lies PROJEKT.md und schau in die Referenzen. Prüf mit backlog_liste, welche Themen es schon gibt, und wähl ein neues. Rendere das Video mit der Vorlage in studio/, schreib meta.json und lies das Backlog ein.",
  },
  {
    key: "serie",
    label: "Serie mit 3 Shorts",
    prompt:
      "Mach eine Serie aus drei Shorts mit gemeinsamem Format und je einer anderen Kernbotschaft aus PROJEKT.md. Gleicher Aufbau, gleiche Optik, damit man die Serie wiedererkennt. Rendere alle drei, schreib die meta.json-Dateien und lies das Backlog ein.",
  },
  {
    key: "ideen",
    label: "10 Ideen sammeln",
    prompt:
      "Schlag mir 10 Ideen für Shorts vor, passend zu Zielgruppe und Kernbotschaften in PROJEKT.md. Pro Idee: Hook (eine Zeile), Format (z. B. Dialog, Vorher/Nachher, Quiz), Kernbotschaft, benötigte Referenzen. Noch nichts rendern.",
  },
  {
    key: "marke",
    label: "Vorlage an Marke anpassen",
    prompt:
      "Passe die Video-Vorlage an die Marke an: Farben, Logo und Schrift aus den Referenzen in studio/brand.json übernehmen, Dateien nach studio/public/ kopieren. Rendere danach einen kurzen Markentest (5–8 Sekunden) als Short ins Backlog, damit ich die Optik prüfen kann.",
  },
  {
    key: "einplanen",
    label: "Neue Shorts zur Freigabe einplanen",
    prompt:
      "Plane alle Shorts aus dem Backlog, die noch nicht geplant oder veröffentlicht sind, mit zur_freigabe_einplanen in die nächsten freien Slots ein. Sag mir danach, was wann geplant ist.",
  },
];
