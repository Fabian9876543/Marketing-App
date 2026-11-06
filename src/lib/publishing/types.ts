import type { Account, Content, Platform, Post, PostTarget, UploadSession } from "../db/schema";
import type { AppSettings } from "../settings";

/**
 * retryable:  später erneut versuchen (Netzwerk, 5xx, Rate-Limit)
 * quota:      Tageslimit erreicht – ohne Versuch zu zählen später erneut
 * processing: hochgeladen, die Plattform verarbeitet noch – gleich wieder nachsehen (zählt nicht als Versuch)
 * auth:       Konto muss neu verbunden werden
 * fatal:      ohne Änderung durch dich hat ein neuer Versuch keinen Sinn
 */
export type PublishErrorKind = "retryable" | "quota" | "processing" | "auth" | "fatal";

export class PublishError extends Error {
  constructor(
    public readonly kind: PublishErrorKind,
    message: string,
    public readonly retryAt?: Date,
  ) {
    super(message);
    this.name = "PublishError";
  }
}

export function toPublishError(err: unknown): PublishError {
  if (err instanceof PublishError) return err;
  const e = err as Error & { code?: string; cause?: { code?: string } };
  // fetch wirft TypeError bei Netzwerkproblemen
  if (e?.name === "TypeError" || e?.code || e?.cause?.code) {
    return new PublishError("retryable", `Netzwerkfehler: ${e.cause?.code ?? e.code ?? e.message}`);
  }
  return new PublishError("retryable", e?.message ?? String(err));
}

export type PublishInput = {
  target: PostTarget;
  post: Post;
  content: Content;
  account: Account;
  settings: AppSettings;
  /** Gültiges Access-Token (wird bei Bedarf erneuert). */
  accessToken: () => Promise<string>;
  /** Upload-Sitzung merken, damit ein abgebrochener Upload fortgesetzt werden kann. */
  saveSession: (session: UploadSession | null) => void;
  log: (message: string) => void;
  now: Date;
};

export type PublishOutcome = {
  /**
   * published  = jetzt online
   * scheduled  = hochgeladen, die Plattform veröffentlicht zur geplanten Zeit
   * handed_off = als Entwurf in der App der Plattform abgelegt, du veröffentlichst dort selbst
   */
  state: "published" | "scheduled" | "handed_off";
  externalId: string;
  externalUrl?: string;
};

export interface Publisher {
  platform: Platform;
  /** Längste erlaubte Videodauer in Sekunden (vor dem Upload geprüft). */
  maxDurationSec?(settings: AppSettings): number;
  /**
   * Wie weit im Voraus darf hochgeladen werden, sodass die Plattform selbst zur
   * geplanten Zeit veröffentlicht? 0 = gar nicht.
   */
  uploadAheadWindowMs?(settings: AppSettings): number;
  publish(input: PublishInput, opts: { publishAt?: Date }): Promise<PublishOutcome>;
  /** Geplante Zeit bei der Plattform ändern (nur für vorab hochgeladene Posts). */
  updateSchedule?(input: PublishInput, publishAt: Date): Promise<void>;
  /** Vorab hochgeladenen Post bei der Plattform entfernen (bei Absage). */
  remove?(input: PublishInput): Promise<void>;
  /** Uploads pro Tag (für alle Konten dieser Plattform gemeinsam). */
  dailyLimit?(settings: AppSettings): number;
  /** Beginn des aktuellen Kontingent-Tages. */
  quotaDayStart?(now: Date): Date;
}

/** Wie lange darf eine Plattform an einem hochgeladenen Video „verarbeiten“, bevor wir aufgeben? */
export const MAX_PROCESSING_MS = 6 * 60 * 60_000;

/** Kleine Wartehilfe für Statusabfragen. */
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
