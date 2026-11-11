import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import type { DB } from "../db/client";
import { projectReferences, projects, studioRuns, studioSessions, type Project } from "../db/schema";
import { logEvent } from "../events";
import { listLearnings } from "../learnings";
import { getProject, listProjects } from "../projects";
import { getSettings } from "../settings";
import { createSession } from "../studio/sessions";

export class ResearchError extends Error {}

export const reportsDir = (p: Pick<Project, "folder">) => path.join(p.folder, "recherche", "berichte");

/** Hat das Projekt überhaupt etwas zu recherchieren? */
export function hasResearchSources(db: DB, p: Project): boolean {
  const r = p.research;
  if (r.keywords?.length || r.instagram?.length || r.metaPages?.length) return true;
  return Boolean(
    db
      .select({ id: projectReferences.id })
      .from(projectReferences)
      .where(and(eq(projectReferences.projectId, p.id), eq(projectReferences.category, "inspiration")))
      .get(),
  );
}

export function researchPrompt(db: DB, project: Project, now: Date, tz: string): string {
  const date = DateTime.fromJSDate(now, { zone: tz }).setLocale("de").toFormat("cccc, d. LLLL yyyy");
  const file = `recherche/berichte/${DateTime.fromJSDate(now, { zone: tz }).toFormat("yyyy-LL-dd")}.md`;
  const known = listLearnings(db, project.id).filter((l) => l.status !== "proposed");
  return [
    `Recherche für ${project.name} (${date}).`,
    "",
    "Ziel: herausfinden, was bei unserer Zielgruppe in Anzeigen und Beiträgen anderer funktioniert – als Orientierung für eigene Shorts, nicht zum Kopieren.",
    "",
    "1. `recherche_quellen`: Stichwörter, Konten und Beispiele ansehen. Fehlen Stichwörter, leite 2–3 aus PROJEKT.md ab (Problem der Zielgruppe, Produktart).",
    "2. Werbebibliothek (`werbebibliothek_suchen`): je Stichwort und je Facebook-Seite. Achte auf lange laufende Anzeigen und Anzeigen mit mehreren Textvarianten.",
    "3. Instagram (`instagram_konto_ansehen`): je Konto die Beiträge, die im Verhältnis zum Konto am stärksten liefen.",
    "4. YouTube (`youtube_shorts_suchen`): je Stichwort höchstens einmal – das kostet Kontingent.",
    "5. Beispiele aus referenzen/: Videos mit `beispiel_einzelbilder` zerlegen und die Bilder mit Read ansehen, Gesprochenes mit `beispiel_transkript` (falls verfügbar). Bilder direkt mit Read ansehen.",
    "6. Muster ableiten: Hook in den ersten 2 Sekunden, Aufbau, Länge, Tonalität, Format (Demo, Vorher/Nachher, Frage, Kundenstimme …), Handlungsaufforderung. Nur Muster, die bei mehreren Beispielen vorkommen.",
    "7. Höchstens 5 Muster mit `muster_vorschlagen` vorschlagen – als konkrete Anweisung für eigene Shorts, mit Begründung (welche Beispiele, welcher Hinweis auf Erfolg).",
    `8. Bericht mit Write nach \`${file}\`: Beobachtungen je Quelle mit Links, die abgeleiteten Muster und drei Ideen für eigene Shorts in unserer Tonalität.`,
    "9. Am Ende kurz zusammenfassen.",
    "",
    "Regeln: Keine Texte, Slogans, Bilder, Musik oder Figuren anderer übernehmen – nur Prinzipien ableiten. Nichts rendern, nichts einplanen, nichts herunterladen. Fehlt eine Quelle, überspringen und im Bericht sagen, was fehlt.",
    known.length ? `\nSchon entschieden (nicht erneut vorschlagen): ${known.map((l) => `„${l.text}“`).join("; ")}` : "",
  ]
    .join("\n")
    .trimEnd();
}

export function researchBusy(db: DB, projectId: number): boolean {
  return (
    db
      .select({ id: studioRuns.id })
      .from(studioRuns)
      .innerJoin(studioSessions, eq(studioSessions.id, studioRuns.sessionId))
      .where(and(eq(studioSessions.projectId, projectId), eq(studioSessions.research, true), inArray(studioRuns.state, ["queued", "running"])))
      .all().length > 0
  );
}

export function lastResearchSession(db: DB, projectId: number) {
  return db
    .select()
    .from(studioSessions)
    .where(and(eq(studioSessions.projectId, projectId), eq(studioSessions.research, true)))
    .orderBy(desc(studioSessions.id))
    .get();
}

/** Startet die Recherche als frischen Studio-Chat. */
export function startResearch(db: DB, projectId: number, now = new Date()) {
  const project = getProject(db, projectId);
  if (!project) throw new ResearchError("Projekt nicht gefunden");
  if (researchBusy(db, projectId)) throw new ResearchError("Die Recherche läuft schon");
  if (!hasResearchSources(db, project)) {
    throw new ResearchError("Erst Quellen angeben: Stichwörter, Instagram-Konten, Facebook-Seiten oder Beispiele unter Referenzen → Inspiration.");
  }
  const tz = getSettings(db).timezone;
  const created = createSession(db, projectId, researchPrompt(db, project, now, tz), `Recherche · ${DateTime.fromJSDate(now, { zone: tz }).toFormat("dd.LL.")}`);
  db.update(studioSessions).set({ research: true }).where(eq(studioSessions.id, created.session.id)).run();
  db.update(projects).set({ researchAt: now }).where(eq(projects.id, projectId)).run();
  return created;
}

const INTERVAL_DAYS = { week: 7, month: 28 } as const;

/** Startet fällige Recherchen (wenn unter Einstellungen ein Rhythmus gewählt ist). */
export function runDueResearch(db: DB, now = new Date()): { started: number } {
  const every = getSettings(db).research.every;
  if (every === "off") return { started: 0 };
  let started = 0;
  for (const p of listProjects(db)) {
    if (p.researchAt && now.getTime() - p.researchAt.getTime() < INTERVAL_DAYS[every] * 86_400_000) continue;
    if (!hasResearchSources(db, p) || researchBusy(db, p.id)) continue;
    startResearch(db, p.id, now);
    logEvent(db, "info", "recherche", `[${p.name}] Recherche gestartet`);
    started++;
  }
  return { started };
}

/* ---------- Berichte ---------- */

export function listReports(p: Pick<Project, "folder">): string[] {
  const dir = reportsDir(p);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^[\w.-]+\.md$/.test(f))
    .sort()
    .reverse();
}

export function readReport(p: Pick<Project, "folder">, name: string): string | null {
  if (!/^[\w.-]+\.md$/.test(name)) return null;
  const file = path.join(reportsDir(p), name);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}
