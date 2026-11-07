import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";
import { dataDir, dbFile, ensureDir, legacyContentDir } from "../env";

export type DB = BetterSQLite3Database<typeof schema>;

/** Migrationen liegen im App-Ordner. Prozesse mit anderem Arbeitsordner (MCP-Server) setzen STUDIO_APP_DIR. */
const migrationsFolder = () => path.join(process.env.STUDIO_APP_DIR || process.cwd(), "drizzle");

/** Öffnet eine Datenbank und bringt das Schema auf den neuesten Stand. */
export function openDb(file: string): DB {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsFolder() });
  adoptLegacyProject(db);
  return db;
}

/**
 * Daten aus der Zeit vor den Projekten hat die Migration in ein Projekt ohne Ordner übernommen.
 * Dieses Projekt bekommt den alten Content-Ordner (Einstellung contentDir bzw. ~/Fokuspilot-Social).
 */
function adoptLegacyProject(db: DB): void {
  const orphans = db.select().from(schema.projects).where(eq(schema.projects.folder, "")).all();
  if (!orphans.length) return;
  const row = db.select().from(schema.settings).where(eq(schema.settings.key, "app")).get();
  const folder = ((row?.value as { contentDir?: string } | undefined)?.contentDir || legacyContentDir()).trim();
  for (const p of orphans) {
    db.update(schema.projects).set({ folder }).where(eq(schema.projects.id, p.id)).run();
    fs.mkdirSync(path.join(folder, "backlog"), { recursive: true });
  }
}

const globalForDb = globalThis as unknown as { __fpsDb?: DB };

/** Gemeinsame Verbindung für Web-App und Worker (je Prozess eine). */
export function getDb(): DB {
  if (!globalForDb.__fpsDb) {
    ensureDir(dataDir());
    globalForDb.__fpsDb = openDb(dbFile());
  }
  return globalForDb.__fpsDb;
}
