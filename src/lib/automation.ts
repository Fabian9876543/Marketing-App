import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { DB } from "./db/client";
import { automations, studioMessages, studioRuns, studioSessions, type Automation, type Project, type Slot } from "./db/schema";
import { logEvent } from "./events";
import { acceptedLearnings } from "./learnings";
import { getProject } from "./projects";
import { getSettings } from "./settings";
import { WEEKDAY_SHORT, slotOccurrences } from "./slots";
import { createSession } from "./studio/sessions";

/** Ein verpasster Lauf (Mac aus/schlafend) wird nur innerhalb dieses Fensters nachgeholt. */
export const CATCH_UP_MS = 6 * 3600_000;

export class AutomationError extends Error {}

export type AutomationInput = {
  name: string;
  recipe: string;
  time: string;
  weekdays: number[];
  shortsPerRun: number;
  autoSchedule: boolean;
  enabled?: boolean;
  sourceSessionId?: number | null;
};

function validate(input: AutomationInput): AutomationInput {
  const name = input.name.trim();
  if (!name) throw new AutomationError("Bitte einen Namen angeben");
  if (!input.recipe.trim()) throw new AutomationError("Das Rezept ist leer");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new AutomationError("Uhrzeit im Format HH:MM angeben");
  const weekdays = [...new Set(input.weekdays)].filter((d) => d >= 1 && d <= 7).sort();
  if (!weekdays.length) throw new AutomationError("Mindestens einen Wochentag wählen");
  const shortsPerRun = Math.round(input.shortsPerRun);
  if (!(shortsPerRun >= 1 && shortsPerRun <= 5)) throw new AutomationError("1 bis 5 Shorts pro Lauf");
  return { ...input, name, recipe: input.recipe.trim(), weekdays, shortsPerRun };
}

export function createAutomation(db: DB, projectId: number, input: AutomationInput): Automation {
  const v = validate(input);
  return db
    .insert(automations)
    .values({ projectId, ...v, enabled: v.enabled ?? true, sourceSessionId: v.sourceSessionId ?? null })
    .returning()
    .get();
}

export function updateAutomation(db: DB, id: number, input: AutomationInput): Automation {
  const v = validate(input);
  const updated = db
    .update(automations)
    .set({ name: v.name, recipe: v.recipe, time: v.time, weekdays: v.weekdays, shortsPerRun: v.shortsPerRun, autoSchedule: v.autoSchedule, enabled: v.enabled ?? true })
    .where(eq(automations.id, id))
    .returning()
    .get();
  if (!updated) throw new AutomationError("Automation nicht gefunden");
  return updated;
}

export function setAutomationEnabled(db: DB, id: number, enabled: boolean): void {
  db.update(automations).set({ enabled }).where(eq(automations.id, id)).run();
}

export function deleteAutomation(db: DB, id: number): void {
  db.delete(automations).where(eq(automations.id, id)).run(); // Chats bleiben, nur die Verknüpfung entfällt
}

export function getAutomation(db: DB, id: number): Automation | undefined {
  return db.select().from(automations).where(eq(automations.id, id)).get();
}

export function listAutomations(db: DB, projectId?: number): Automation[] {
  return db
    .select()
    .from(automations)
    .where(projectId ? eq(automations.projectId, projectId) : undefined)
    .orderBy(asc(automations.time), asc(automations.id))
    .all();
}

/* ---------- Zeitplan ---------- */

const asSlot = (a: Pick<Automation, "time" | "weekdays">): Slot => ({ id: 0, projectId: 0, time: a.time, weekdays: a.weekdays, active: true, createdAt: new Date(0) });

/** Die nächsten Läufe ab `from` (in UTC). */
export function upcomingRuns(a: Pick<Automation, "time" | "weekdays">, from: Date, tz: string, count = 5): Date[] {
  return slotOccurrences([asSlot(a)], from, new Date(from.getTime() + 15 * 86_400_000), tz).slice(0, count);
}

/** Nächster Lauf: der erste Termin nach dem letzten Lauf (bzw. nach dem Anlegen). */
export function nextRunAt(a: Pick<Automation, "time" | "weekdays" | "lastRunAt" | "createdAt">, tz: string): Date | null {
  const base = a.lastRunAt ?? a.createdAt;
  return upcomingRuns(a, new Date(base.getTime() + 60_000), tz, 1)[0] ?? null;
}

/** Läuft für diese Automation gerade ein Auftrag (wartend oder in Arbeit)? */
export function automationBusy(db: DB, automationId: number): boolean {
  return (
    db
      .select({ id: studioRuns.id })
      .from(studioRuns)
      .innerJoin(studioSessions, eq(studioSessions.id, studioRuns.sessionId))
      .where(and(eq(studioSessions.automationId, automationId), inArray(studioRuns.state, ["queued", "running"])))
      .all().length > 0
  );
}

/** Letzter Chat einer Automation (für „Letzter Lauf ansehen“). */
export function lastAutomationSession(db: DB, automationId: number) {
  return db.select().from(studioSessions).where(eq(studioSessions.automationId, automationId)).orderBy(desc(studioSessions.id)).get();
}

/* ---------- Rezept ---------- */

/** Macht aus einem gelungenen Studio-Chat ein Rezept: Auftrag, gültige Rückmeldungen und das Ergebnis als Vorbild. */
export function recipeFromSession(db: DB, sessionId: number): { name: string; recipe: string; projectId: number } {
  const session = db.select().from(studioSessions).where(eq(studioSessions.id, sessionId)).get();
  if (!session) throw new AutomationError("Chat nicht gefunden");
  const userMessages = db
    .select({ text: studioMessages.text })
    .from(studioMessages)
    .where(and(eq(studioMessages.sessionId, sessionId), eq(studioMessages.kind, "user")))
    .orderBy(asc(studioMessages.id))
    .all()
    .map((m) => m.text.trim())
    .filter(Boolean);
  const shorts = db
    .select({ newShorts: studioRuns.newShorts })
    .from(studioRuns)
    .where(and(eq(studioRuns.sessionId, sessionId), eq(studioRuns.state, "done")))
    .all()
    .flatMap((r) => r.newShorts);

  const parts = [`## Auftrag\n\n${userMessages[0] ?? session.title}`];
  if (userMessages.length > 1) parts.push(`## Rückmeldungen, die immer gelten\n\n${userMessages.slice(1).map((m) => `- ${m.replace(/\n+/g, " ")}`).join("\n")}`);
  if (shorts.length) {
    const last = shorts.at(-1)!;
    parts.push(
      `## Vorbild\n\nSo hat es gepasst: \`backlog/${last}/\` (Szenen, falls vorhanden: \`studio/props/${last}.json\`).\nGleiches Format, gleiche Optik und Länge – aber jedes Mal ein neues Thema.`,
    );
  }
  return { name: session.title.replace(/^Automation: /, ""), recipe: parts.join("\n\n"), projectId: session.projectId };
}

/** Auftragstext für einen automatischen Lauf. */
export function runPrompt(a: Automation, project: Project, now: Date, tz: string, learned: string[] = []): string {
  const date = now.toLocaleDateString("de-DE", { timeZone: tz, weekday: "long", day: "numeric", month: "long" });
  const n = a.shortsPerRun;
  return [
    `Automatischer Lauf der Automation „${a.name}“ für ${project.name} (${date}).`,
    "",
    `Mach ${n === 1 ? "einen neuen Short" : `${n} neue Shorts`} nach dem Rezept unten.`,
    "- Prüf zuerst mit backlog_liste, welche Themen es schon gibt. Wähle für jeden Short einen neuen Blickwinkel und wiederhole nichts.",
    "- Rendere, schreib meta.json und lies das Backlog ein (backlog_einlesen).",
    "- Plane nichts ein – das übernimmt das Studio nach dem Lauf.",
    "- Fasse am Ende kurz zusammen: welche Shorts (Ordner), welches Thema.",
    "",
    "# Rezept",
    "",
    a.recipe,
    ...(learned.length
      ? ["", "# Erkenntnisse aus den Zahlen", "", "Vom Menschen bestätigt – gehen dem Rezept vor, wenn sie sich widersprechen:", ...learned.map((t) => `- ${t}`)]
      : []),
  ].join("\n");
}

/** Startet einen Lauf: frischer Chat (jeder Lauf beginnt neu nach demselben Rezept). */
export function startAutomationRun(db: DB, a: Automation, now = new Date()) {
  const project = getProject(db, a.projectId);
  if (!project) throw new AutomationError("Projekt nicht gefunden");
  if (automationBusy(db, a.id)) throw new AutomationError("Der letzte Lauf dieser Automation ist noch nicht fertig");
  const tz = getSettings(db).timezone;
  const label = now.toLocaleDateString("de-DE", { timeZone: tz, day: "2-digit", month: "2-digit" });
  const learned = acceptedLearnings(db, project.id).map((l) => l.text);
  const created = createSession(db, project.id, runPrompt(a, project, now, tz, learned), `${a.name} · ${label}`);
  db.update(studioSessions).set({ automationId: a.id }).where(eq(studioSessions.id, created.session.id)).run();
  db.update(automations).set({ lastRunAt: now }).where(eq(automations.id, a.id)).run();
  return created;
}

/**
 * Prüft, welche Automationen fällig sind, und startet sie.
 * Verpasste Läufe (Rechner aus) werden innerhalb von 6 Stunden nachgeholt, ältere übersprungen.
 */
export function runDueAutomations(db: DB, now = new Date()): { started: number; skipped: number } {
  const tz = getSettings(db).timezone;
  let started = 0;
  let skipped = 0;
  for (const a of listAutomations(db).filter((x) => x.enabled)) {
    const project = getProject(db, a.projectId);
    if (!project || project.archived) continue;
    const due = nextRunAt(a, tz);
    if (!due || due > now) continue;
    if (now.getTime() - due.getTime() > CATCH_UP_MS) {
      db.update(automations).set({ lastRunAt: now }).where(eq(automations.id, a.id)).run();
      logEvent(db, "warn", "automation", `[${project.name}] „${a.name}“: Lauf von ${due.toLocaleString("de-DE", { timeZone: tz })} verpasst (Rechner war aus) – nächster Termin regulär`);
      skipped++;
      continue;
    }
    if (automationBusy(db, a.id)) continue; // wartet, bis der vorige Lauf fertig ist
    startAutomationRun(db, a, now);
    logEvent(db, "info", "automation", `[${project.name}] „${a.name}“ gestartet`);
    started++;
  }
  return { started, skipped };
}

/** „Mo–Fr · 06:00 · 1 Short pro Lauf“ */
export function scheduleText(a: Pick<Automation, "time" | "weekdays" | "shortsPerRun">): string {
  const days =
    a.weekdays.length === 7
      ? "täglich"
      : a.weekdays.join(",") === "1,2,3,4,5"
        ? "Mo–Fr"
        : a.weekdays.map((d) => WEEKDAY_SHORT[d - 1]).join(", ");
  return `${days} · ${a.time} · ${a.shortsPerRun === 1 ? "1 Short" : `${a.shortsPerRun} Shorts`} pro Lauf`;
}
