import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type DB } from "@/lib/db/client";
import { createProject } from "@/lib/projects";
import { __setTestKey } from "@/lib/secrets/keystore";

export function tempDir(prefix = "fps-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function testDb(): DB {
  process.env.FPS_DATA_DIR ??= tempDir("fps-data-");
  __setTestKey(crypto.randomBytes(32));
  return openDb(":memory:");
}

/** Legt einen Backlog-Ordner mit einer (Fake-)Videodatei an. */
export function makeShort(contentDir: string, slug: string, opts: { meta?: object; bytes?: number } = {}): string {
  const folder = path.join(contentDir, "backlog", slug);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "video.mp4"), crypto.randomBytes(opts.bytes ?? 1024));
  if (opts.meta) fs.writeFileSync(path.join(folder, "meta.json"), JSON.stringify(opts.meta));
  return folder;
}

/** Projekt mit eigenem temporärem Ordner. */
export function testProject(db: DB, name = "Testprojekt", extra: { defaultHashtags?: string[] } = {}) {
  return createProject(db, { name, folder: tempDir("fps-projekt-"), ...extra });
}
