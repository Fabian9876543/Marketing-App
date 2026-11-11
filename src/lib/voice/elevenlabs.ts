import { eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { settings } from "../db/schema";
import { elevenlabsConfig } from "../env";
import { decrypt, encrypt } from "../secrets/cipher";
import { getEncryptionKey } from "../secrets/keystore";

/**
 * ElevenLabs: Stimmen auflisten, Sprechertexte erzeugen (mit Zeitstempeln je Wort), Verbrauch abfragen.
 * Der API-Schlüssel liegt verschlüsselt in der Datenbank – Claude bekommt ihn nie zu sehen,
 * die Aufrufe macht der MCP-Server des Studios.
 */

const KEY_ROW = "elevenlabs";

export class VoiceError extends Error {}

/* ---------- Schlüssel ---------- */

export async function setElevenLabsKey(db: DB, apiKey: string | null): Promise<void> {
  const value = apiKey?.trim();
  if (!value) {
    db.delete(settings).where(eq(settings.key, KEY_ROW)).run();
    return;
  }
  const { key } = await getEncryptionKey();
  const row = { key: KEY_ROW, value: { apiKey: encrypt(value, key) } };
  db.insert(settings).values(row).onConflictDoUpdate({ target: settings.key, set: { value: row.value } }).run();
}

export function hasElevenLabsKey(db: DB): boolean {
  return Boolean(db.select().from(settings).where(eq(settings.key, KEY_ROW)).get());
}

export async function getElevenLabsKey(db: DB): Promise<string | null> {
  const row = db.select().from(settings).where(eq(settings.key, KEY_ROW)).get();
  const sealed = (row?.value as { apiKey?: string } | undefined)?.apiKey;
  if (!sealed) return null;
  const { key } = await getEncryptionKey();
  return decrypt(sealed, key);
}

/* ---------- HTTP ---------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ErrorBody = { detail?: string | { status?: string; message?: string } | { msg?: string }[] };

export async function toVoiceError(res: Response, context: string): Promise<VoiceError> {
  let body: ErrorBody = {};
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    body = {};
  }
  const d = body.detail;
  const status = typeof d === "object" && d && !Array.isArray(d) ? d.status : undefined;
  const message =
    typeof d === "string" ? d : Array.isArray(d) ? d.map((x) => x.msg).filter(Boolean).join("; ") : (d && "message" in d ? d.message : undefined) ?? `HTTP ${res.status}`;
  if (status === "quota_exceeded") return new VoiceError("ElevenLabs: Zeichen-Kontingent aufgebraucht – im ElevenLabs-Konto aufstocken oder bis zum nächsten Monat warten.");
  if (status === "voice_not_found") return new VoiceError("ElevenLabs: Diese Stimme gibt es im Konto nicht (mehr). Wähle eine aus stimmen_liste.");
  if (status === "missing_permissions") return new VoiceError(`ElevenLabs: Dem API-Schlüssel fehlt eine Berechtigung (${context}). In ElevenLabs beim Schlüssel freischalten.`);
  if (res.status === 401) return new VoiceError("ElevenLabs: API-Schlüssel ungültig – unter Einstellungen → Stimmen neu eintragen.");
  return new VoiceError(`ElevenLabs (${context}): ${message}`);
}

async function call(apiKey: string, path: string, context: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${elevenlabsConfig().apiBase}${path}`, {
      ...init,
      headers: { "xi-api-key": apiKey, ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(120_000),
    });
    // Zu viele gleichzeitige Anfragen: kurz warten und erneut versuchen
    if (res.status === 429 && attempt < 2) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw await toVoiceError(res, context);
    return res;
  }
}

/* ---------- Stimmen ---------- */

export type Voice = {
  id: string;
  name: string;
  category: string;
  description: string;
  labels: Record<string, string>;
  previewUrl: string | null;
};

type ApiVoice = { voice_id: string; name?: string; category?: string; description?: string | null; labels?: Record<string, string>; preview_url?: string | null };

export async function listVoices(apiKey: string): Promise<Voice[]> {
  const out: Voice[] = [];
  let token = "";
  for (let page = 0; page < 5; page++) {
    const res = await call(apiKey, `/v2/voices?page_size=100${token ? `&next_page_token=${encodeURIComponent(token)}` : ""}`, "Stimmen lesen");
    const json = (await res.json()) as { voices?: ApiVoice[]; has_more?: boolean; next_page_token?: string | null };
    for (const v of json.voices ?? []) {
      out.push({
        id: v.voice_id,
        name: v.name ?? v.voice_id,
        category: v.category ?? "",
        description: v.description ?? "",
        labels: v.labels ?? {},
        previewUrl: v.preview_url ?? null,
      });
    }
    if (!json.has_more || !json.next_page_token) break;
    token = json.next_page_token;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "de"));
}

const LABEL_DE: Record<string, string> = {
  female: "weiblich",
  male: "männlich",
  neutral: "neutral",
  young: "jung",
  middle_aged: "mittleres Alter",
  "middle aged": "mittleres Alter",
  old: "älter",
  german: "deutsch",
  american: "amerikanisch",
  british: "britisch",
  australian: "australisch",
  conversational: "Gespräch",
  narration: "Erzählung",
  narrative_story: "Erzählung",
  social_media: "Social Media",
  characters_animation: "Figuren",
  informative_educational: "Erklären",
  entertainment_tv: "Unterhaltung",
  advertisement: "Werbung",
  news: "Nachrichten",
  calm: "ruhig",
  warm: "warm",
  confident: "selbstbewusst",
  friendly: "freundlich",
  professional: "professionell",
};
const de = (s: string | undefined) => (s ? (LABEL_DE[s.toLowerCase()] ?? s.replace(/_/g, " ")) : "");

/** „weiblich, mittleres Alter, deutsch – ruhig, erzählend“ */
export function describeVoice(v: Voice): string {
  const l = v.labels;
  const parts = [l.gender, l.age, l.accent, l.use_case ?? l["use case"], l.description].map(de).filter(Boolean);
  return [parts.join(", "), v.description].filter(Boolean).join(" – ");
}

/* ---------- Verbrauch ---------- */

export type Usage = { characterCount: number; characterLimit: number; resetAt: Date | null; tier: string };

export async function getUsage(apiKey: string): Promise<Usage> {
  const res = await call(apiKey, "/v1/user/subscription", "Verbrauch lesen");
  const j = (await res.json()) as { character_count?: number; character_limit?: number; next_character_count_reset_unix?: number; tier?: string };
  return {
    characterCount: j.character_count ?? 0,
    characterLimit: j.character_limit ?? 0,
    resetAt: j.next_character_count_reset_unix ? new Date(j.next_character_count_reset_unix * 1000) : null,
    tier: j.tier ?? "",
  };
}

/* ---------- Sprechertext ---------- */

export type Word = { word: string; start: number; end: number };
export type Speech = { audio: Buffer; words: Word[]; durationSec: number | null };

type Alignment = { characters?: string[]; character_start_times_seconds?: number[]; character_end_times_seconds?: number[] };

/** Zeitstempel je Zeichen → Zeitstempel je Wort. */
export function wordsFromAlignment(a: Alignment | null | undefined): Word[] {
  const chars = a?.characters ?? [];
  const starts = a?.character_start_times_seconds ?? [];
  const ends = a?.character_end_times_seconds ?? [];
  const words: Word[] = [];
  let current: Word | null = null;
  chars.forEach((c, i) => {
    if (/\s/.test(c)) {
      if (current) words.push(current);
      current = null;
      return;
    }
    if (!current) current = { word: "", start: starts[i] ?? 0, end: ends[i] ?? 0 };
    current.word += c;
    current.end = ends[i] ?? current.end;
  });
  if (current) words.push(current);
  return words;
}

export const MAX_CHARS = 1000;

/**
 * Erzeugt Sprache. Erst mit Zeitstempeln; kennt das Modell das nicht, ohne (dann ermittelt der Aufrufer die Dauer).
 */
export async function synthesize(apiKey: string, input: { voiceId: string; text: string; modelId: string; speed?: number }): Promise<Speech> {
  const text = input.text.trim();
  if (!text) throw new VoiceError("Kein Text zum Sprechen");
  if (text.length > MAX_CHARS) throw new VoiceError(`Höchstens ${MAX_CHARS} Zeichen pro Aufruf – teile den Text auf (eine Datei pro Szene oder Dialogzeile).`);
  const body = JSON.stringify({
    text,
    model_id: input.modelId,
    ...(input.speed ? { voice_settings: { speed: Math.min(1.2, Math.max(0.7, input.speed)) } } : {}),
  });
  const voice = encodeURIComponent(input.voiceId);
  try {
    const res = await call(apiKey, `/v1/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`, "Text zu Sprache", { method: "POST", body });
    const json = (await res.json()) as { audio_base64?: string; alignment?: Alignment; normalized_alignment?: Alignment };
    if (!json.audio_base64) throw new VoiceError("ElevenLabs hat keine Audiodaten geliefert");
    const words = wordsFromAlignment(json.alignment ?? json.normalized_alignment);
    return { audio: Buffer.from(json.audio_base64, "base64"), words, durationSec: words.length ? words[words.length - 1].end : null };
  } catch (err) {
    // Modell ohne Zeitstempel → normale Ausgabe als MP3
    if (!(err instanceof VoiceError) || !/HTTP 4|not support|unsupported|timestamps/i.test(err.message)) throw err;
    const res = await call(apiKey, `/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, "Text zu Sprache", { method: "POST", body });
    return { audio: Buffer.from(await res.arrayBuffer()), words: [], durationSec: null };
  }
}

/* ---------- Spracherkennung (Speech to Text) ---------- */

export type Transcript = { text: string; language: string | null; words: Word[] };

/** Modelle in der Reihenfolge, in der sie versucht werden (das neuere zuerst). */
export const STT_MODELS = ["scribe_v2", "scribe_v1"];

/** Schreibt mit, was in einer Audio- oder Videodatei gesprochen wird. */
export async function transcribe(apiKey: string, audio: Buffer, filename: string, mime: string): Promise<Transcript> {
  let lastError: unknown;
  for (const model of STT_MODELS) {
    const form = new FormData();
    form.append("model_id", model);
    form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), filename);
    try {
      const res = await call(apiKey, "/v1/speech-to-text", "Spracherkennung", { method: "POST", body: form });
      const j = (await res.json()) as { text?: string; language_code?: string; words?: { text?: string; start?: number; end?: number; type?: string }[] };
      const words = (j.words ?? [])
        .filter((w) => (w.type ?? "word") === "word" && w.text?.trim())
        .map((w) => ({ word: w.text!.trim(), start: w.start ?? 0, end: w.end ?? w.start ?? 0 }));
      return { text: (j.text ?? "").trim(), language: j.language_code ?? null, words };
    } catch (err) {
      lastError = err;
      // Unbekanntes Modell → nächstes versuchen; alles andere sofort melden
      if (!(err instanceof VoiceError) || !/model/i.test(err.message)) throw err;
    }
  }
  throw lastError;
}
