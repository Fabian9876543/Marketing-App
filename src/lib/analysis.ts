import { and, desc, eq, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import type { DB } from "./db/client";
import { mediaItems, accounts, projects, studioRuns, studioSessions, type Project } from "./db/schema";
import { logEvent } from "./events";
import { listLearnings } from "./learnings";
import { getProject, listProjects } from "./projects";
import { getSettings } from "./settings";
import { createSession } from "./studio/sessions";

/** Eine verpasste Wochenanalyse wird bis zu einem Tag später nachgeholt. */
export const ANALYSIS_CATCH_UP_MS = 24 * 3600_000;
/** Ohne genug Beiträge lohnt keine Analyse. */
export const MIN_ITEMS_FOR_ANALYSIS = 3;

export class AnalysisError extends Error {}

export function analysisPrompt(db: DB, project: Project, now: Date, tz: string): string {
  const date = DateTime.fromJSDate(now, { zone: tz }).setLocale("de").toFormat("cccc, d. LLLL yyyy");
  const accepted = listLearnings(db, project.id, ["accepted"]);
  const rejected = listLearnings(db, project.id, ["rejected"]);
  return [
    `Wochenanalyse für ${project.name} (${date}).`,
    "",
    "Werte die Zahlen der bisherigen Posts aus und finde heraus, was funktioniert und was nicht.",
    "",
    "1. Hol dir die Zahlen mit `statistik` (zuerst 7 Tage, dann 90 Tage zum Vergleich) und die bisherigen Erkenntnisse mit `erkenntnisse`.",
    "2. Schau dir die starken und die schwachen Posts genauer an: Bei eigenen Shorts steht der Ordner dabei – lies `backlog/<ordner>/meta.json` und, falls vorhanden, `studio/props/<ordner>.json` (Hook, Aufbau, Länge, Szenen).",
    "3. Suche Muster: Hook und erste Sekunden, Format, Länge, Thema, Plattform, Uhrzeit, Wochentag.",
    "4. Schlag höchstens 3 neue Erkenntnisse mit `erkenntnis_vorschlagen` vor. Jede ist eine konkrete Anweisung für künftige Shorts (z. B. „Hook in den ersten 2 Sekunden als Frage“) und beruht auf mindestens zwei Posts. Begründe sie mit den Zahlen.",
    "   Nichts vorschlagen, was schon bestätigt oder abgelehnt ist. Bei wenig Daten lieber gar nichts vorschlagen und sagen, was fehlt.",
    "5. Fasse am Ende kurz zusammen (höchstens 10 Zeilen): Wie lief die Woche, was war stark, was schwach, was schlägst du vor.",
    "",
    "Wichtig: Nichts rendern, nichts einplanen, keine Dateien ändern. Die Vorschläge gelten erst, wenn der Mensch sie in der App bestätigt.",
    accepted.length ? `\nSchon bestätigt (${accepted.length}): ${accepted.map((l) => `„${l.text}“`).join("; ")}` : "",
    rejected.length ? `Schon abgelehnt (${rejected.length}): ${rejected.map((l) => `„${l.text}“`).join("; ")}` : "",
  ]
    .filter((l, i, all) => l !== "" || all[i - 1] !== "")
    .join("\n")
    .trimEnd();
}

/** Läuft für das Projekt gerade eine Analyse (wartend oder in Arbeit)? */
export function analysisBusy(db: DB, projectId: number): boolean {
  return (
    db
      .select({ id: studioRuns.id })
      .from(studioRuns)
      .innerJoin(studioSessions, eq(studioSessions.id, studioRuns.sessionId))
      .where(and(eq(studioSessions.projectId, projectId), eq(studioSessions.analysis, true), inArray(studioRuns.state, ["queued", "running"])))
      .all().length > 0
  );
}

export function lastAnalysisSession(db: DB, projectId: number) {
  return db
    .select()
    .from(studioSessions)
    .where(and(eq(studioSessions.projectId, projectId), eq(studioSessions.analysis, true)))
    .orderBy(desc(studioSessions.id))
    .get();
}

function itemCount(db: DB, projectId: number): number {
  return db
    .select({ id: mediaItems.id })
    .from(mediaItems)
    .innerJoin(accounts, eq(accounts.id, mediaItems.accountId))
    .where(eq(accounts.projectId, projectId))
    .all().length;
}

/** Startet die Analyse als frischen Studio-Chat. */
export function startAnalysis(db: DB, projectId: number, now = new Date()) {
  const project = getProject(db, projectId);
  if (!project) throw new AnalysisError("Projekt nicht gefunden");
  if (analysisBusy(db, projectId)) throw new AnalysisError("Die Analyse läuft schon");
  if (itemCount(db, projectId) < MIN_ITEMS_FOR_ANALYSIS) {
    throw new AnalysisError(`Noch zu wenig Zahlen für eine Analyse (mindestens ${MIN_ITEMS_FOR_ANALYSIS} Beiträge). Konten verbinden und Zahlen abrufen.`);
  }
  const tz = getSettings(db).timezone;
  const label = DateTime.fromJSDate(now, { zone: tz }).toFormat("dd.LL.");
  const created = createSession(db, projectId, analysisPrompt(db, project, now, tz), `Wochenanalyse · ${label}`);
  db.update(studioSessions).set({ analysis: true }).where(eq(studioSessions.id, created.session.id)).run();
  db.update(projects).set({ analysisAt: now }).where(eq(projects.id, projectId)).run();
  return created;
}

/** Nächster regulärer Termin der Wochenanalyse nach `after` (in UTC). */
export function nextAnalysisAt(after: Date, weekday: number, time: string, tz: string): Date {
  const [h, m] = time.split(":").map(Number);
  let d = DateTime.fromJSDate(after, { zone: tz }).set({ hour: h, minute: m, second: 0, millisecond: 0 });
  d = d.plus({ days: (weekday - d.weekday + 7) % 7 });
  if (d.toMillis() <= after.getTime()) d = d.plus({ weeks: 1 });
  return d.toJSDate();
}

/**
 * Startet fällige Wochenanalysen (einmal pro Woche und Projekt, zur eingestellten Zeit).
 * Projekte ohne Zahlen werden übersprungen, bis es welche gibt.
 */
export function runDueAnalyses(db: DB, now = new Date()): { started: number } {
  const s = getSettings(db);
  if (!s.analytics.weekly) return { started: 0 };
  let started = 0;
  for (const p of listProjects(db)) {
    // Erster Termin: der letzte reguläre vor jetzt, damit ein neues Projekt nicht eine Woche warten muss
    const base = p.analysisAt ?? new Date(now.getTime() - 7 * 86_400_000);
    const due = nextAnalysisAt(base, s.analytics.weekday, s.analytics.time, s.timezone);
    if (due > now) continue;
    if (now.getTime() - due.getTime() > ANALYSIS_CATCH_UP_MS) {
      // Verpasst (Rechner aus) – nicht nachholen, nächster Termin regulär
      db.update(projects).set({ analysisAt: now }).where(eq(projects.id, p.id)).run();
      continue;
    }
    if (analysisBusy(db, p.id) || itemCount(db, p.id) < MIN_ITEMS_FOR_ANALYSIS) continue;
    startAnalysis(db, p.id, now);
    logEvent(db, "info", "analytics", `[${p.name}] Wochenanalyse gestartet`);
    started++;
  }
  return { started };
}
