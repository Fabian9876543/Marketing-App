import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { DB } from "./db/client";
import {
  accounts,
  contents,
  posts,
  postTargets,
  projectReferences,
  projects,
  type Project,
  type ProjectBrief,
  type ReferenceCategory,
} from "./db/schema";
import { slugify } from "./backlog";
import { getSettings } from "./settings";

export const PROJECT_COLORS = ["#3150c8", "#0f7b6c", "#b5452b", "#8a4fbf", "#b8860b", "#2b7bb9", "#c2185b", "#4a5568"];

export const CATEGORY_LABEL: Record<ReferenceCategory, string> = {
  logo: "Logo",
  branding: "Farben & Schriften",
  screenshot: "Screenshots",
  video: "Videos & Bildschirmaufnahmen",
  audio: "Audio & Musik",
  dokument: "Dokumente",
  inspiration: "Inspiration & Beispiele",
  sonstiges: "Sonstiges",
};

export class ProjectError extends Error {}

export const expandHome = (p: string) => p.trim().replace(/^~(?=\/|$)/, os.homedir());

export function listProjects(db: DB, opts: { includeArchived?: boolean } = {}): Project[] {
  const q = db.select().from(projects);
  return (opts.includeArchived ? q : q.where(eq(projects.archived, false))).orderBy(asc(projects.name)).all();
}

export function getProject(db: DB, id: number): Project | undefined {
  return db.select().from(projects).where(eq(projects.id, id)).get();
}

export function requireProject(db: DB, id: number): Project {
  const p = getProject(db, id);
  if (!p) throw new ProjectError("Projekt nicht gefunden");
  return p;
}

/** Unterordner, die jedes Projekt hat. */
export const backlogFolder = (p: Pick<Project, "folder">) => path.join(p.folder, "backlog");
export const referencesFolder = (p: Pick<Project, "folder">) => path.join(p.folder, "referenzen");

export function ensureProjectFolders(p: Pick<Project, "folder">): void {
  fs.mkdirSync(backlogFolder(p), { recursive: true });
  fs.mkdirSync(referencesFolder(p), { recursive: true });
}

function validateFolder(folder: string): string {
  const abs = expandHome(folder);
  if (!path.isAbsolute(abs)) throw new ProjectError("Projektordner bitte als vollständigen Pfad angeben (z. B. ~/Marketing-Studio/meine-app)");
  if (abs === os.homedir() || abs === "/") throw new ProjectError("Bitte einen eigenen Ordner für das Projekt wählen, nicht den Benutzerordner");
  return path.resolve(abs);
}

function validateColor(color: string | undefined): string {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : PROJECT_COLORS[0];
}

function validateWebsite(url: string | undefined | null): string | null {
  const v = url?.trim();
  if (!v) return null;
  const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    return new URL(withScheme).toString();
  } catch {
    throw new ProjectError(`Ungültige Website-Adresse: ${v}`);
  }
}

function uniqueSlug(db: DB, base: string, exceptId?: number): string {
  const taken = new Set(
    db
      .select({ slug: projects.slug, id: projects.id })
      .from(projects)
      .all()
      .filter((r) => r.id !== exceptId)
      .map((r) => r.slug),
  );
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  return slug;
}

export type ProjectInput = {
  name: string;
  description?: string;
  website?: string | null;
  color?: string;
  folder?: string;
  defaultHashtags?: string[];
};

export function createProject(db: DB, input: ProjectInput): Project {
  const name = input.name.trim();
  if (!name) throw new ProjectError("Bitte einen Projektnamen angeben");
  const slug = uniqueSlug(db, slugify(name));
  const folder = validateFolder(input.folder?.trim() || path.join(getSettings(db).projectsDir, slug));
  const existing = listProjects(db, { includeArchived: true });
  const project = db
    .insert(projects)
    .values({
      slug,
      name,
      description: input.description?.trim() ?? "",
      website: validateWebsite(input.website),
      color: input.color ? validateColor(input.color) : PROJECT_COLORS[existing.length % PROJECT_COLORS.length],
      folder,
      defaultHashtags: input.defaultHashtags ?? [],
    })
    .returning()
    .get();
  ensureProjectFolders(project);
  writeBriefFile(db, project.id);
  return project;
}

export function updateProject(db: DB, id: number, input: ProjectInput): Project {
  requireProject(db, id);
  const name = input.name.trim();
  if (!name) throw new ProjectError("Bitte einen Projektnamen angeben");
  const updated = db
    .update(projects)
    .set({
      name,
      description: input.description?.trim() ?? "",
      website: validateWebsite(input.website),
      color: validateColor(input.color),
      ...(input.folder ? { folder: validateFolder(input.folder) } : {}),
      ...(input.defaultHashtags ? { defaultHashtags: input.defaultHashtags } : {}),
    })
    .where(eq(projects.id, id))
    .returning()
    .get();
  ensureProjectFolders(updated);
  writeBriefFile(db, id);
  return updated;
}

export function updateBrief(db: DB, id: number, brief: ProjectBrief): Project {
  requireProject(db, id);
  const clean = Object.fromEntries(Object.entries(brief).map(([k, v]) => [k, (v ?? "").trim()]).filter(([, v]) => v)) as ProjectBrief;
  const updated = db.update(projects).set({ brief: clean }).where(eq(projects.id, id)).returning().get();
  writeBriefFile(db, id);
  return updated;
}

export function setArchived(db: DB, id: number, archived: boolean): void {
  requireProject(db, id);
  db.update(projects).set({ archived }).where(eq(projects.id, id)).run();
}

/** Offene Veröffentlichungen eines Projekts (geplant, im Upload, bei der Plattform eingeplant). */
function openTargets(db: DB, projectId: number): number {
  return db
    .select({ id: postTargets.id })
    .from(postTargets)
    .innerJoin(posts, eq(posts.id, postTargets.postId))
    .innerJoin(contents, eq(contents.id, posts.contentId))
    .where(and(eq(contents.projectId, projectId), inArray(postTargets.state, ["pending", "uploading", "scheduled"]), ne(posts.state, "cancelled")))
    .all().length;
}

/**
 * Projekt aus der App löschen (Posts, Konten, Referenz-Einträge). Der Ordner auf der Festplatte bleibt erhalten.
 * Nur für archivierte Projekte ohne offene Veröffentlichungen.
 */
export function deleteProject(db: DB, id: number): void {
  const p = requireProject(db, id);
  if (!p.archived) throw new ProjectError("Bitte das Projekt zuerst archivieren");
  if (openTargets(db, id)) throw new ProjectError("Das Projekt hat noch geplante Posts – bitte erst absagen");
  db.transaction((tx) => {
    const contentIds = tx.select({ id: contents.id }).from(contents).where(eq(contents.projectId, id)).all().map((r) => r.id);
    if (contentIds.length) tx.delete(posts).where(inArray(posts.contentId, contentIds)).run(); // Ziele werden mitgelöscht
    tx.delete(contents).where(eq(contents.projectId, id)).run();
    tx.delete(accounts).where(eq(accounts.projectId, id)).run();
    tx.delete(projects).where(eq(projects.id, id)).run(); // Slots und Referenzen werden mitgelöscht
  });
}

export type ProjectStats = { shorts: number; accounts: number; planned: number; published: number };

export function projectStats(db: DB): Map<number, ProjectStats> {
  const map = new Map<number, ProjectStats>();
  const get = (id: number) => map.get(id) ?? (map.set(id, { shorts: 0, accounts: 0, planned: 0, published: 0 }), map.get(id)!);
  for (const c of db.select({ projectId: contents.projectId }).from(contents).where(eq(contents.available, true)).all()) get(c.projectId).shorts++;
  for (const a of db.select({ projectId: accounts.projectId }).from(accounts).where(ne(accounts.status, "disabled")).all()) get(a.projectId).accounts++;
  const rows = db
    .select({ projectId: contents.projectId, state: postTargets.state, postState: posts.state })
    .from(postTargets)
    .innerJoin(posts, eq(posts.id, postTargets.postId))
    .innerJoin(contents, eq(contents.id, posts.contentId))
    .all();
  for (const r of rows) {
    if (r.postState === "cancelled") continue;
    if (r.state === "published" || r.state === "handed_off") get(r.projectId).published++;
    else if (r.state === "pending" || r.state === "scheduled" || r.state === "uploading") get(r.projectId).planned++;
  }
  return map;
}

/**
 * Schreibt PROJEKT.md in den Projektordner: Briefing und Referenzen in einer Datei.
 * Daraus arbeitet später Claude Code (Phase 2), wenn es Shorts für das Projekt baut.
 */
export function writeBriefFile(db: DB, id: number): string {
  const p = requireProject(db, id);
  const refs = db.select().from(projectReferences).where(eq(projectReferences.projectId, id)).orderBy(asc(projectReferences.id)).all();
  const b = p.brief;
  const section = (title: string, text?: string) => (text?.trim() ? `## ${title}\n\n${text.trim()}\n` : "");
  const lines: string[] = [
    `# ${p.name}`,
    "",
    "> Diese Datei erzeugt Marketing Studio automatisch aus dem Projekt-Briefing und den Referenzen.",
    "> Änderungen bitte in der App vornehmen – hier gehen sie beim nächsten Speichern verloren.",
    "",
  ];
  if (p.description) lines.push(p.description, "");
  if (p.website) lines.push(`Website: ${p.website}`, "");
  lines.push(
    section("Zielgruppe", b.audience),
    section("Tonalität", b.tone),
    section("Kernbotschaften", b.messages),
    section("Regeln (Do's & Don'ts)", b.rules),
    section("Handlungsaufforderung", b.cta),
  );
  if (p.defaultHashtags.length) lines.push(`## Standard-Hashtags\n\n${p.defaultHashtags.join(" ")}\n`);

  if (refs.length) {
    lines.push("## Referenzen\n");
    const byCat = new Map<ReferenceCategory, typeof refs>();
    for (const r of refs) byCat.set(r.category, [...(byCat.get(r.category) ?? []), r]);
    for (const [cat, list] of byCat) {
      lines.push(`### ${CATEGORY_LABEL[cat]}\n`);
      for (const r of list) {
        const where = r.kind === "file" ? `\`${r.filePath}\`` : r.kind === "link" ? r.url : "";
        lines.push(`- **${r.title}**${where ? ` – ${where}` : ""}${r.note ? ` – ${r.note.replace(/\n+/g, " ")}` : ""}`);
      }
      lines.push("");
    }
  }
  const file = path.join(p.folder, "PROJEKT.md");
  try {
    fs.mkdirSync(p.folder, { recursive: true });
    fs.writeFileSync(file, lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
  } catch {
    // Ordner nicht beschreibbar – die App funktioniert trotzdem, nur ohne PROJEKT.md.
  }
  return file;
}
