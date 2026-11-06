import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";
import { dataDir, dbFile, ensureDir } from "../env";

export type DB = BetterSQLite3Database<typeof schema>;

const migrationsFolder = () => path.join(process.cwd(), "drizzle");

/** Öffnet eine Datenbank und bringt das Schema auf den neuesten Stand. */
export function openDb(file: string): DB {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsFolder() });
  return db;
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
