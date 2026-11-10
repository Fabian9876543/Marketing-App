import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "./db/client";
import { settings } from "./db/schema";
import { defaultProjectsDir } from "./env";

export const appSettingsSchema = z.object({
  timezone: z.string().default("Europe/Berlin"),
  /** Wie lange nach der geplanten Zeit ein Post noch nachgeholt wird (z. B. nach dem Ruhezustand). */
  missedToleranceMinutes: z.number().int().min(0).max(24 * 60).default(120),
  /** Hier entstehen neue Projektordner. */
  projectsDir: z.string().default(defaultProjectsDir()),
  /** Veraltet (vor den Projekten): Content-Ordner des ersten Projekts. Nur noch für die Übernahme gelesen. */
  contentDir: z.string().optional(),
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
  tiktok: z
    .object({
      /**
       * draft          = Entwurf in deiner TikTok-App (du postest dort selbst) – geht ohne Audit
       * direct_private = direkt, aber nur für dich sichtbar (zum Testen)
       * direct_public  = direkt öffentlich (erst nach TikTok-Audit möglich)
       */
      mode: z.enum(["draft", "direct_private", "direct_public"]).default("draft"),
    })
    .default({ mode: "draft" }),
  instagram: z.object({ shareToFeed: z.boolean().default(true) }).default({ shareToFeed: true }),
  linkedin: z.object({ visibility: z.enum(["PUBLIC", "CONNECTIONS"]).default("PUBLIC") }).default({ visibility: "PUBLIC" }),
  analytics: z
    .object({
      /** Alle wie viele Stunden die Zahlen abgerufen werden */
      fetchEveryHours: z.number().int().min(1).max(48).default(6),
      /** Wochenanalyse durch Claude */
      weekly: z.boolean().default(true),
      /** 1 = Montag … 7 = Sonntag */
      weekday: z.number().int().min(1).max(7).default(1),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("07:30"),
    })
    .default({ fetchEveryHours: 6, weekly: true, weekday: 1, time: "07:30" }),
  studio: z
    .object({
      /** Modell für Claude Code („“ = Standard aus deiner Claude-Code-Einstellung) */
      model: z.string().max(60).default(""),
      /** Wie viele Studio-Aufträge gleichzeitig laufen dürfen */
      maxParallel: z.number().int().min(1).max(4).default(2),
    })
    .default({ model: "", maxParallel: 2 }),
  voice: z
    .object({
      /** ElevenLabs-Modell für Sprechertexte */
      model: z.string().max(60).default("eleven_multilingual_v2"),
    })
    .default({ model: "eleven_multilingual_v2" }),
  higgsfield: z
    .object({
      /** Claude darf im Studio Higgsfield nutzen (KI-Bilder und -Videos) */
      enabled: z.boolean().default(false),
      /** Höchstens so viele Credits pro Studio-Auftrag (Anweisung an Claude) */
      maxCredits: z.number().int().min(1).max(10000).default(60),
      /** Erst die unbegrenzten Generierungen des Abos nutzen */
      unlim: z.boolean().default(true),
      /** Auch in automatischen Läufen (sonst nur, wenn du selbst einen Auftrag gibst) */
      inAutomations: z.boolean().default(false),
      /** Ergebnis von „claude mcp list“ */
      detected: z
        .object({
          server: z.string().default(""),
          status: z.enum(["ok", "auth", "error", "missing"]).default("missing"),
          message: z.string().default(""),
          checkedAt: z.number().nullable().default(null),
        })
        .default({ server: "", status: "missing", message: "", checkedAt: null }),
    })
    .default({ enabled: false, maxCredits: 60, unlim: true, inAutomations: false, detected: { server: "", status: "missing", message: "", checkedAt: null } }),
  /** Wird an die Caption gehängt, wenn ein Video KI-Inhalte enthält und die Plattform keine eigene Kennzeichnung per API hat. */
  aiDisclosure: z.string().max(200).default("Mit KI erstellt."),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

const KEY = "app";

export function getSettings(db: DB): AppSettings {
  const row = db.select().from(settings).where(eq(settings.key, KEY)).get();
  const parsed = appSettingsSchema.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data : appSettingsSchema.parse({});
}

type SettingsPatch = { [K in keyof AppSettings]?: AppSettings[K] extends object ? Partial<AppSettings[K]> : AppSettings[K] };

export function updateSettings(db: DB, patch: SettingsPatch): AppSettings {
  const current = getSettings(db);
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const before = (current as Record<string, unknown>)[key];
    merged[key] = value && typeof value === "object" && before && typeof before === "object" ? { ...before, ...value } : value;
  }
  const next = appSettingsSchema.parse(merged);
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
