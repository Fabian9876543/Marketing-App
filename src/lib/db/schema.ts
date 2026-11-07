import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const PLATFORMS = ["youtube", "instagram", "tiktok", "linkedin", "simulator"] as const;
export type Platform = (typeof PLATFORMS)[number];

const nowMs = sql`(cast(unixepoch('subsec') * 1000 as integer))`;
const createdAt = () => integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs);
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(nowMs)
    .$onUpdate(() => new Date());

/** Ein Projekt = eine Marke/App/Kunde mit eigenem Ordner, eigenen Konten, Posting-Zeiten und Referenzen. */
export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  website: text("website"),
  /** Akzentfarbe für Kalender und Listen (#rrggbb) */
  color: text("color").notNull().default("#3150c8"),
  /** Projektordner mit backlog/ und referenzen/ (absoluter Pfad) */
  folder: text("folder").notNull(),
  /** Briefing für Texte und später für Claude Code (Zielgruppe, Tonalität, …) */
  brief: text("brief", { mode: "json" }).$type<ProjectBrief>().notNull().default({}),
  /** Werden genutzt, wenn ein Short keine eigenen Hashtags hat */
  defaultHashtags: text("default_hashtags", { mode: "json" }).$type<string[]>().notNull().default([]),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type ProjectBrief = {
  /** Für wen ist das Projekt? */
  audience?: string;
  /** Wie soll es klingen? */
  tone?: string;
  /** Was soll hängen bleiben? */
  messages?: string;
  /** Was ist tabu, was muss immer rein? */
  rules?: string;
  /** Handlungsaufforderung am Ende, z. B. „Jetzt kostenlos testen auf …“ */
  cta?: string;
};

export const REFERENCE_CATEGORIES = ["logo", "branding", "screenshot", "video", "audio", "dokument", "inspiration", "sonstiges"] as const;
export type ReferenceCategory = (typeof REFERENCE_CATEGORIES)[number];

/** Referenzen eines Projekts: hochgeladene Dateien, Links und Notizen. Dateien liegen in <projektordner>/referenzen/. */
export const projectReferences = sqliteTable(
  "project_references",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["file", "link", "note"] }).notNull(),
    category: text("category", { enum: REFERENCE_CATEGORIES }).notNull().default("sonstiges"),
    title: text("title").notNull(),
    /** Wofür ist die Referenz gedacht? (z. B. „Logo immer unten rechts“) */
    note: text("note").notNull().default(""),
    /** Relativer Pfad im Projektordner (nur bei Dateien) */
    filePath: text("file_path"),
    url: text("url"),
    mime: text("mime"),
    size: integer("size"),
    createdAt: createdAt(),
  },
  (t) => [index("project_references_project").on(t.projectId)],
);

/** Verbundene Social-Media-Konten. Tokens liegen verschlüsselt in `tokens`. */
export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    platform: text("platform", { enum: PLATFORMS }).notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    handle: text("handle"),
    tokens: text("tokens"),
    status: text("status", { enum: ["active", "needs_reconnect", "disabled"] })
      .notNull()
      .default("active"),
    statusMessage: text("status_message"),
    /** Bis wann das Konto neu verbunden werden muss (z. B. LinkedIn nach 60 Tagen). null = unbegrenzt. */
    reconnectBy: integer("reconnect_by", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("accounts_project_platform_external").on(t.projectId, t.platform, t.externalId)],
);

/** Ein fertiger Short aus dem Backlog-Ordner (ein Unterordner = ein Inhalt). */
export const contents = sqliteTable(
  "contents",
  {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  slug: text("slug").notNull(),
  folder: text("folder").notNull(),
  videoFile: text("video_file").notNull(),
  coverFile: text("cover_file"),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  hashtags: text("hashtags", { mode: "json" }).$type<string[]>().notNull().default([]),
  platformTexts: text("platform_texts", { mode: "json" }).$type<PlatformTexts>().notNull().default({}),
  aiGenerated: integer("ai_generated", { mode: "boolean" }).notNull().default(false),
  durationSec: real("duration_sec"),
  width: integer("width"),
  height: integer("height"),
  fileSize: integer("file_size"),
  available: integer("available", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("contents_project_slug").on(t.projectId, t.slug)],
);

export type PlatformTexts = {
  youtube?: { title?: string; description?: string; tags?: string[] };
  instagram?: { caption?: string };
  tiktok?: { caption?: string };
  linkedin?: { text?: string };
};

/** Ein geplanter Post: ein Inhalt zu einer Zeit auf einem oder mehreren Konten. */
export const posts = sqliteTable(
  "posts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contentId: integer("content_id")
      .notNull()
      .references(() => contents.id),
    scheduledAt: integer("scheduled_at", { mode: "timestamp_ms" }).notNull(),
    state: text("state", { enum: ["review", "approved", "cancelled"] }).notNull().default("review"),
    createdBy: text("created_by", { enum: ["user", "agent"] }).notNull().default("user"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("posts_scheduled").on(t.scheduledAt)],
);

export const TARGET_STATES = [
  "pending",
  "uploading",
  "scheduled",
  "published",
  /** Als Entwurf an die App übergeben (TikTok) – du veröffentlichst dort selbst. */
  "handed_off",
  "failed",
  "missed",
  "cancelled",
] as const;
export type TargetState = (typeof TARGET_STATES)[number];

/** Veröffentlichung eines Posts auf genau einem Konto. Damit arbeitet der Worker. */
export const postTargets = sqliteTable(
  "post_targets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    postId: integer("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    state: text("state", { enum: TARGET_STATES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    uploadSession: text("upload_session", { mode: "json" }).$type<UploadSession | null>(),
    /** Änderung (Zeit/Absage) muss noch an die Plattform übertragen werden. */
    syncNeeded: integer("sync_needed", { mode: "boolean" }).notNull().default(false),
    lockedAt: integer("locked_at", { mode: "timestamp_ms" }),
    uploadedAt: integer("uploaded_at", { mode: "timestamp_ms" }),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("post_targets_post_account").on(t.postId, t.accountId), index("post_targets_state").on(t.state)],
);

/**
 * Zwischenstand eines Uploads, damit ein neuer Versuch dort weitermacht, wo der letzte aufgehört hat.
 * url/total: fortsetzbarer Upload (YouTube). remoteId: Datei ist schon bei der Plattform
 * (Instagram-Container, TikTok publish_id, LinkedIn-Video), es fehlt nur Verarbeitung/Veröffentlichung.
 */
export type UploadSession = { createdAt: number; url?: string; total?: number; remoteId?: string };

/** Wiederkehrende Posting-Zeiten (Ortszeit laut Einstellungen). */
export const slots = sqliteTable("slots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  time: text("time").notNull(),
  /** Wochentage 1 = Montag … 7 = Sonntag */
  weekdays: text("weekdays", { mode: "json" }).$type<number[]>().notNull().default([1, 2, 3, 4, 5, 6, 7]),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
});

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: createdAt(),
    level: text("level", { enum: ["info", "warn", "error"] }).notNull(),
    source: text("source").notNull(),
    message: text("message").notNull(),
    targetId: integer("target_id"),
  },
  (t) => [index("events_at").on(t.at)],
);

export const oauthStates = sqliteTable("oauth_states", {
  state: text("state").primaryKey(),
  platform: text("platform", { enum: PLATFORMS }).notNull(),
  codeVerifier: text("code_verifier").notNull(),
  /** Für welches Projekt das Konto verbunden wird */
  projectId: integer("project_id"),
  createdAt: createdAt(),
});

export type Project = typeof projects.$inferSelect;
export type ProjectReference = typeof projectReferences.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Content = typeof contents.$inferSelect;
export type Post = typeof posts.$inferSelect;
export type PostTarget = typeof postTargets.$inferSelect;
export type Slot = typeof slots.$inferSelect;
export type EventRow = typeof events.$inferSelect;
