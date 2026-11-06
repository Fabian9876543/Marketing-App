import { desc, lt } from "drizzle-orm";
import type { DB } from "./db/client";
import { events, type EventRow } from "./db/schema";

type Level = "info" | "warn" | "error";

/** Schreibt ein Ereignis ins Protokoll (Datenbank + Konsole/Logdatei). */
export function logEvent(db: DB, level: Level, source: string, message: string, targetId?: number): void {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${source}: ${message}`;
  if (level === "error") console.error(line);
  else console.log(line);
  try {
    db.insert(events).values({ level, source, message, targetId: targetId ?? null }).run();
  } catch (err) {
    console.error("Protokoll konnte nicht gespeichert werden:", err);
  }
}

export function recentEvents(db: DB, limit = 50): EventRow[] {
  return db.select().from(events).orderBy(desc(events.at), desc(events.id)).limit(limit).all();
}

/** Ereignisse älter als `days` Tage löschen. */
export function pruneEvents(db: DB, days = 30, now = Date.now()): void {
  db.delete(events)
    .where(lt(events.at, new Date(now - days * 86_400_000)))
    .run();
}
