import fs from "node:fs";
import path from "node:path";
import { eq, notInArray } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "./db/client";
import { contents, type Content, type PlatformTexts } from "./db/schema";
import { probeVideo } from "./media";

/**
 * Backlog = ein Ordner pro Short im Content-Ordner:
 *   <contentDir>/backlog/<name>/video.mp4   (oder die erste .mp4/.mov-Datei)
 *   <contentDir>/backlog/<name>/cover.jpg   (optional)
 *   <contentDir>/backlog/<name>/meta.json   (optional, siehe metaSchema)
 */
export const metaSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    hashtags: z.array(z.string()).optional(),
    aiGenerated: z.boolean().optional(),
    platforms: z
      .object({
        youtube: z
          .object({ title: z.string().optional(), description: z.string().optional(), tags: z.array(z.string()).optional() })
          .optional(),
        instagram: z.object({ caption: z.string().optional() }).optional(),
        tiktok: z.object({ caption: z.string().optional() }).optional(),
        linkedin: z.object({ text: z.string().optional() }).optional(),
      })
      .optional(),
  })
  .passthrough();

export type ShortMeta = z.infer<typeof metaSchema>;

const VIDEO_EXT = [".mp4", ".mov", ".m4v"];
const COVER_NAMES = ["cover.jpg", "cover.jpeg", "cover.png", "thumbnail.jpg", "thumbnail.png"];

export const backlogDir = (contentDir: string) => path.join(contentDir, "backlog");

export type ImportResult = { added: number; updated: number; missing: number; errors: string[] };

/** Liest den Backlog-Ordner ein und gleicht die Datenbank ab. */
export async function importBacklog(db: DB, contentDir: string): Promise<ImportResult> {
  const dir = backlogDir(contentDir);
  fs.mkdirSync(dir, { recursive: true });
  const result: ImportResult = { added: 0, updated: 0, missing: 0, errors: [] };
  const seen: string[] = [];

  const folders = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort();

  for (const slug of folders) {
    const folder = path.join(dir, slug);
    try {
      const files = fs.readdirSync(folder);
      const videoFile =
        files.find((f) => f.toLowerCase() === "video.mp4") ??
        files.find((f) => VIDEO_EXT.includes(path.extname(f).toLowerCase()) && !f.startsWith("."));
      if (!videoFile) continue; // Ordner ohne Video (noch in Arbeit) überspringen
      seen.push(slug);

      const meta = readMeta(folder, result.errors, slug);
      const coverFile = files.find((f) => COVER_NAMES.includes(f.toLowerCase())) ?? null;
      const stat = fs.statSync(path.join(folder, videoFile));
      const existing = db.select().from(contents).where(eq(contents.slug, slug)).get();

      const needsProbe = !existing || existing.fileSize !== stat.size || existing.videoFile !== videoFile;
      const info = needsProbe
        ? await probeVideo(path.join(folder, videoFile))
        : { durationSec: existing.durationSec, width: existing.width, height: existing.height };

      const values = {
        slug,
        folder,
        videoFile,
        coverFile,
        title: meta.title?.trim() || prettifySlug(slug),
        description: meta.description ?? "",
        hashtags: normalizeHashtags(meta.hashtags ?? []),
        platformTexts: (meta.platforms ?? {}) as PlatformTexts,
        aiGenerated: meta.aiGenerated ?? false,
        durationSec: info.durationSec,
        width: info.width,
        height: info.height,
        fileSize: stat.size,
        available: true,
      };

      if (existing) {
        db.update(contents).set(values).where(eq(contents.id, existing.id)).run();
        result.updated++;
      } else {
        db.insert(contents).values(values).run();
        result.added++;
      }
    } catch (err) {
      result.errors.push(`${slug}: ${(err as Error).message}`);
    }
  }

  // Ordner, die verschwunden sind, als nicht verfügbar markieren (nicht löschen – Posts verweisen darauf).
  const gone = db
    .update(contents)
    .set({ available: false })
    .where(seen.length ? notInArray(contents.slug, seen) : undefined)
    .returning({ id: contents.id })
    .all();
  result.missing = gone.length;
  return result;
}

function readMeta(folder: string, errors: string[], slug: string): ShortMeta {
  const file = path.join(folder, "meta.json");
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = metaSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (parsed.success) return parsed.data;
    errors.push(`${slug}: meta.json ungültig (${parsed.error.issues.map((i) => i.path.join(".")).join(", ")})`);
  } catch (err) {
    errors.push(`${slug}: meta.json nicht lesbar (${(err as Error).message})`);
  }
  return {};
}

export function prettifySlug(slug: string): string {
  const s = slug.replace(/^\d{4}-\d{2}-\d{2}[-_]?/, "").replace(/[-_]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : slug;
}

export function normalizeHashtags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().replace(/^#*/, "")).filter(Boolean).map((t) => `#${t}`))];
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/ä/g, "ae")
      .replace(/ö/g, "oe")
      .replace(/ü/g, "ue")
      .replace(/ß/g, "ss")
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "short"
  );
}

/** Neuen Backlog-Ordner aus einer hochgeladenen Datei anlegen. */
export function createBacklogFolder(
  contentDir: string,
  input: { title: string; fileName: string; data: Buffer; meta?: ShortMeta; date?: Date },
): string {
  const date = (input.date ?? new Date()).toISOString().slice(0, 10);
  const base = `${date}-${slugify(input.title)}`;
  const dir = backlogDir(contentDir);
  fs.mkdirSync(dir, { recursive: true });
  let slug = base;
  for (let i = 2; fs.existsSync(path.join(dir, slug)); i++) slug = `${base}-${i}`;
  const folder = path.join(dir, slug);
  fs.mkdirSync(folder);
  const ext = path.extname(input.fileName).toLowerCase();
  fs.writeFileSync(path.join(folder, `video${VIDEO_EXT.includes(ext) ? ext : ".mp4"}`), input.data);
  fs.writeFileSync(path.join(folder, "meta.json"), JSON.stringify({ title: input.title, ...input.meta }, null, 2) + "\n");
  return slug;
}

export function contentVideoPath(content: Content): string {
  return path.join(content.folder, content.videoFile);
}
