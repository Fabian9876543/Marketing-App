import type { DB } from "../db/client";
import type { Account, Platform } from "../db/schema";

/** Zahlen eines Beitrags, wie sie eine Plattform liefert. Fehlende Werte = null (Plattform liefert sie nicht). */
export type MediaStat = {
  externalId: string;
  title: string;
  url?: string | null;
  publishedAt: Date;
  durationSec?: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves?: number | null;
  reach?: number | null;
};

/** Abruf der Beiträge eines Kontos seit `since`. Hinweise (z. B. fehlende Berechtigung für einzelne Werte) über `warn`. */
export interface InsightsFetcher {
  platform: Platform;
  fetch(input: { db: DB; account: Account; token: string; since: Date; now: Date; warn: (m: string) => void }): Promise<MediaStat[]>;
  /** Braucht der Abruf ein Zugangs-Token? (Test-Kanal nicht) */
  needsToken?: boolean;
}

/** Plattform liefert ohne Freigabe keine Zahlen (z. B. LinkedIn) – kein Fehler im eigentlichen Sinn. */
export class InsightsUnavailable extends Error {}

export const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
