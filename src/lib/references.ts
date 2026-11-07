import fs from "node:fs";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { slugify } from "./backlog";
import type { DB } from "./db/client";
import { projectReferences, REFERENCE_CATEGORIES, type Project, type ProjectReference, type ReferenceCategory } from "./db/schema";
import { ProjectError, referencesFolder, writeBriefFile } from "./projects";

/** Erlaubte Dateitypen mit MIME-Typ und naheliegender Kategorie. */
const TYPES: Record<string, { mime: string; category: ReferenceCategory }> = {
  ".png": { mime: "image/png", category: "screenshot" },
  ".jpg": { mime: "image/jpeg", category: "screenshot" },
  ".jpeg": { mime: "image/jpeg", category: "screenshot" },
  ".gif": { mime: "image/gif", category: "screenshot" },
  ".webp": { mime: "image/webp", category: "screenshot" },
  ".heic": { mime: "image/heic", category: "screenshot" },
  ".svg": { mime: "image/svg+xml", category: "logo" },
  ".mp4": { mime: "video/mp4", category: "video" },
  ".mov": { mime: "video/quicktime", category: "video" },
  ".m4v": { mime: "video/x-m4v", category: "video" },
  ".webm": { mime: "video/webm", category: "video" },
  ".mp3": { mime: "audio/mpeg", category: "audio" },
  ".wav": { mime: "audio/wav", category: "audio" },
  ".m4a": { mime: "audio/mp4", category: "audio" },
  ".aac": { mime: "audio/aac", category: "audio" },
  ".ogg": { mime: "audio/ogg", category: "audio" },
  ".pdf": { mime: "application/pdf", category: "dokument" },
  ".txt": { mime: "text/plain; charset=utf-8", category: "dokument" },
  ".md": { mime: "text/markdown; charset=utf-8", category: "dokument" },
  ".docx": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", category: "dokument" },
  ".pptx": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", category: "dokument" },
  ".key": { mime: "application/x-iwork-keynote-sffkey", category: "dokument" },
  ".csv": { mime: "text/csv; charset=utf-8", category: "dokument" },
  ".json": { mime: "application/json", category: "dokument" },
  ".ttf": { mime: "font/ttf", category: "branding" },
  ".otf": { mime: "font/otf", category: "branding" },
  ".woff": { mime: "font/woff", category: "branding" },
  ".woff2": { mime: "font/woff2", category: "branding" },
  ".zip": { mime: "application/zip", category: "sonstiges" },
};

export const ACCEPTED_EXTENSIONS = Object.keys(TYPES).join(",");
export const MAX_REFERENCE_BYTES = 500 * 1024 * 1024;

export const isCategory = (v: unknown): v is ReferenceCategory => REFERENCE_CATEGORIES.includes(v as ReferenceCategory);

export function listReferences(db: DB, projectId: number): ProjectReference[] {
  return db.select().from(projectReferences).where(eq(projectReferences.projectId, projectId)).orderBy(asc(projectReferences.category), asc(projectReferences.id)).all();
}

export function getReference(db: DB, id: number): ProjectReference | undefined {
  return db.select().from(projectReferences).where(eq(projectReferences.id, id)).get();
}

/** Kategorie aus Dateiname/-typ raten, wenn „automatisch“ gewählt ist. */
export function guessCategory(fileName: string): ReferenceCategory {
  const ext = path.extname(fileName).toLowerCase();
  if (/logo/i.test(fileName) && TYPES[ext]?.mime.startsWith("image/")) return "logo";
  if (/font|schrift|farbe|color|brand/i.test(fileName) && ext !== ".mp4") return "branding";
  return TYPES[ext]?.category ?? "sonstiges";
}

/** Datei im Projektordner unter referenzen/<kategorie>/ ablegen und eintragen. */
export function addFileReference(
  db: DB,
  project: Project,
  input: { fileName: string; data: Buffer; category?: ReferenceCategory | "auto"; title?: string; note?: string },
): ProjectReference {
  const ext = path.extname(input.fileName).toLowerCase();
  const type = TYPES[ext];
  if (!type) throw new ProjectError(`Dateityp ${ext || "(ohne Endung)"} wird nicht unterstützt: ${input.fileName}`);
  if (input.data.length === 0) throw new ProjectError(`Datei ist leer: ${input.fileName}`);
  if (input.data.length > MAX_REFERENCE_BYTES) throw new ProjectError(`Datei ist größer als 500 MB: ${input.fileName}`);
  const category = !input.category || input.category === "auto" ? guessCategory(input.fileName) : input.category;

  const dir = path.join(referencesFolder(project), category);
  fs.mkdirSync(dir, { recursive: true });
  const base = slugify(path.basename(input.fileName, ext)) || "datei";
  let name = `${base}${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base}-${i}${ext}`;
  fs.writeFileSync(path.join(dir, name), input.data);

  const ref = db
    .insert(projectReferences)
    .values({
      projectId: project.id,
      kind: "file",
      category,
      title: input.title?.trim() || path.basename(input.fileName, ext),
      note: input.note?.trim() ?? "",
      filePath: path.posix.join("referenzen", category, name),
      mime: type.mime,
      size: input.data.length,
    })
    .returning()
    .get();
  writeBriefFile(db, project.id);
  return ref;
}

export function addLinkReference(
  db: DB,
  project: Project,
  input: { url: string; title?: string; note?: string; category?: ReferenceCategory },
): ProjectReference {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input.url.trim()) ? input.url.trim() : `https://${input.url.trim()}`);
  } catch {
    throw new ProjectError(`Ungültiger Link: ${input.url}`);
  }
  const ref = db
    .insert(projectReferences)
    .values({
      projectId: project.id,
      kind: "link",
      category: input.category ?? "inspiration",
      title: input.title?.trim() || url.hostname.replace(/^www\./, ""),
      note: input.note?.trim() ?? "",
      url: url.toString(),
    })
    .returning()
    .get();
  writeBriefFile(db, project.id);
  return ref;
}

export function addNoteReference(db: DB, project: Project, input: { title: string; note: string; category?: ReferenceCategory }): ProjectReference {
  if (!input.title.trim()) throw new ProjectError("Bitte einen Titel für die Notiz angeben");
  const ref = db
    .insert(projectReferences)
    .values({ projectId: project.id, kind: "note", category: input.category ?? "sonstiges", title: input.title.trim(), note: input.note.trim() })
    .returning()
    .get();
  writeBriefFile(db, project.id);
  return ref;
}

/** Absoluter Pfad einer Referenzdatei – nur innerhalb des Projektordners. */
export function referenceFile(project: Project, ref: ProjectReference): string | null {
  if (ref.kind !== "file" || !ref.filePath) return null;
  const abs = path.resolve(project.folder, ref.filePath);
  return abs.startsWith(path.resolve(project.folder) + path.sep) ? abs : null;
}

/** Eintrag löschen; die Datei wandert nach referenzen/_geloescht/ (nicht endgültig weg). */
export function deleteReference(db: DB, project: Project, id: number): void {
  const ref = getReference(db, id);
  if (!ref || ref.projectId !== project.id) throw new ProjectError("Referenz nicht gefunden");
  const file = referenceFile(project, ref);
  if (file && fs.existsSync(file)) {
    const trash = path.join(referencesFolder(project), "_geloescht");
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(file, path.join(trash, `${Date.now()}-${path.basename(file)}`));
  }
  db.delete(projectReferences).where(eq(projectReferences.id, id)).run();
  writeBriefFile(db, project.id);
}

export function updateReference(db: DB, project: Project, id: number, input: { title: string; note: string; category: ReferenceCategory }): void {
  const ref = getReference(db, id);
  if (!ref || ref.projectId !== project.id) throw new ProjectError("Referenz nicht gefunden");
  db.update(projectReferences)
    .set({ title: input.title.trim() || ref.title, note: input.note.trim(), category: input.category })
    .where(eq(projectReferences.id, id))
    .run();
  writeBriefFile(db, project.id);
}
