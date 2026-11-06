import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "./db/client";
import { settings } from "./db/schema";
import { defaultContentDir } from "./env";

export const appSettingsSchema = z.object({
  timezone: z.string().default("Europe/Berlin"),
  /** Wie lange nach der geplanten Zeit ein Post noch nachgeholt wird (z. B. nach dem Ruhezustand). */
  missedToleranceMinutes: z.number().int().min(0).max(24 * 60).default(120),
  contentDir: z.string().default(defaultContentDir()),
  youtube: z
    .object({
      privacy: z.enum(["public", "unlisted", "private"]).default("public"),
      /** Öffentliche Videos so viele Tage vorab hochladen; YouTube veröffentlicht sie dann selbst. 0 = aus. */
      uploadAheadDays: z.number().int().min(0).max(30).default(14),
      dailyUploadLimit: z.number().int().min(1).max(10000).default(100),
      categoryId: z.string().default("28"),
      addShortsTag: z.boolean().default(true),
    })
    .default({ privacy: "public", uploadAheadDays: 14, dailyUploadLimit: 100, categoryId: "28", addShortsTag: true }),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

const KEY = "app";

export function getSettings(db: DB): AppSettings {
  const row = db.select().from(settings).where(eq(settings.key, KEY)).get();
  const parsed = appSettingsSchema.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data : appSettingsSchema.parse({});
}

export function updateSettings(db: DB, patch: Partial<AppSettings>): AppSettings {
  const current = getSettings(db);
  const next = appSettingsSchema.parse({
    ...current,
    ...patch,
    youtube: { ...current.youtube, ...(patch.youtube ?? {}) },
  });
  db.insert(settings)
    .values({ key: KEY, value: next })
    .onConflictDoUpdate({ target: settings.key, set: { value: next } })
    .run();
  return next;
}

export type Heartbeat = { at: number; pid: number; startedAt: number };

export function writeHeartbeat(db: DB, hb: Heartbeat): void {
  db.insert(settings)
    .values({ key: "worker.heartbeat", value: hb })
    .onConflictDoUpdate({ target: settings.key, set: { value: hb } })
    .run();
}

export function readHeartbeat(db: DB): Heartbeat | null {
  const row = db.select().from(settings).where(eq(settings.key, "worker.heartbeat")).get();
  return (row?.value as Heartbeat | undefined) ?? null;
}

/** Läuft der Worker? (Lebenszeichen jünger als 90 Sekunden) */
export function workerAlive(db: DB, now = Date.now()): boolean {
  const hb = readHeartbeat(db);
  return Boolean(hb && now - hb.at < 90_000);
}
