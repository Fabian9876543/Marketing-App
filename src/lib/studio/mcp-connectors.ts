import { spawn } from "node:child_process";
import os from "node:os";
import { eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { settings } from "../db/schema";
import { updateSettings, type AppSettings } from "../settings";
import { claudeBin } from "./claude";

/**
 * Dienste, die Claude Code selbst verbindet (eigener MCP-Eintrag oder Connector aus claude.ai):
 * Anmeldung per Browser, Abrechnung über das jeweilige Abo, kein Schlüssel in der App.
 * Die App erkennt sie mit „claude mcp list“ und gibt sie pro Studio-Auftrag frei.
 */

export type McpStatus = "ok" | "auth" | "error";
export type McpEntry = { name: string; target: string; status: McpStatus; statusText: string };
export type ConnectorCheck = AppSettings["higgsfield"]["detected"];
/** Für den Runner: welche Werkzeuge zusätzlich frei sind und was Claude dazu wissen muss */
export type ConnectorUse = { toolPrefix: string; append: string };

export const CONNECTORS = {
  higgsfield: { label: "Higgsfield", name: "higgsfield", url: "https://mcp.higgsfield.ai/mcp", pattern: /higgsfield/i },
  elevenlabs: { label: "ElevenLabs", name: "elevenlabs", url: "https://api.elevenlabs.io/v1/mcp", pattern: /elevenlabs/i },
} as const;
export type ConnectorKey = keyof typeof CONNECTORS;

export const addArgs = (key: ConnectorKey) => ["mcp", "add", "--transport", "http", "--scope", "user", CONNECTORS[key].name, CONNECTORS[key].url];

/** Zeilen wie „higgsfield: https://mcp.higgsfield.ai/mcp (HTTP) - ✓ Connected“ */
export function parseMcpList(output: string): McpEntry[] {
  const out: McpEntry[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const colon = line.indexOf(": ");
    const dash = line.lastIndexOf(" - ");
    if (colon <= 0 || dash <= colon) continue;
    const name = line.slice(0, colon).trim();
    const target = line.slice(colon + 2, dash).trim();
    const statusText = line.slice(dash + 3).replace(/^[^\p{L}]+/u, "").trim();
    if (!name || !target || !statusText) continue;
    const status: McpStatus = /auth/i.test(statusText) ? "auth" : /fail|error|not connected|disconnected/i.test(statusText) ? "error" : /connected/i.test(statusText) ? "ok" : "error";
    out.push({ name, target, status, statusText });
  }
  return out;
}

/** Der passende Eintrag: verbundene vor nicht verbundenen, eigener vor dem aus claude.ai. */
export function findConnector(entries: McpEntry[], key: ConnectorKey): McpEntry | null {
  const { pattern } = CONNECTORS[key];
  const hits = entries.filter((e) => pattern.test(e.name) || pattern.test(e.target));
  const rank = (e: McpEntry) => (e.status === "ok" ? 0 : e.status === "auth" ? 1 : 2) * 10 + (/^claude\.ai /i.test(e.name) ? 1 : 0);
  return hits.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** Name in Werkzeugnamen, wie Claude Code ihn bildet („claude.ai Higgsfield“ → „claude_ai_Higgsfield“). */
export function mcpToolPrefix(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "")}`;
}

const STATUS_TEXT: Record<McpStatus, string> = { ok: "verbunden", auth: "Anmeldung nötig", error: "nicht erreichbar" };

/* ---------- Claude Code aufrufen ---------- */

export type ClaudeResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

/**
 * Startet „claude …“ ohne Eingabe (stdin geschlossen, damit nichts auf eine Antwort wartet),
 * im Benutzerordner und mit Zeitlimit.
 */
export function runClaude(args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin(), args, { cwd: os.homedir(), env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, opts.timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** So lange darf „claude mcp list“ dauern (prüft jede Verbindung). */
export const LIST_TIMEOUT_MS = 90_000;

const notInstalled = "Claude Code wurde nicht gefunden (Befehl „claude“). Ist es installiert und im Terminal angemeldet?";

/** Fragt Claude Code einmal nach seinen MCP-Servern und merkt sich Higgsfield und ElevenLabs. */
export async function checkConnectors(
  db: DB,
  opts: { env?: NodeJS.ProcessEnv; now?: Date; timeoutMs?: number } = {},
): Promise<Record<ConnectorKey, ConnectorCheck> & { names: string[]; error: string | null }> {
  const checkedAt = (opts.now ?? new Date()).getTime();
  const failed = (message: string) => ({ server: "", status: "missing" as const, message, checkedAt });
  let result: Record<ConnectorKey, ConnectorCheck>;
  let names: string[] = [];
  /** Die Abfrage selbst ging schief (nicht „Dienst nicht gefunden“) */
  let error: string | null = null;
  try {
    const r = await runClaude(["mcp", "list"], { env: opts.env, timeoutMs: opts.timeoutMs ?? LIST_TIMEOUT_MS });
    if (r.timedOut) {
      error = `Claude Code hat nach ${Math.round((opts.timeoutMs ?? LIST_TIMEOUT_MS) / 1000)} Sekunden nicht geantwortet. Im Terminal „claude mcp list“ ausführen – hängt es dort auch?`;
      result = { higgsfield: failed(error), elevenlabs: failed(error) };
    } else if (r.code !== 0 && !r.stdout.trim()) {
      error = `Claude Code meldet einen Fehler: ${(r.stderr.trim().split("\n")[0] || `Exit-Code ${r.code}`).slice(0, 200)}`;
      result = { higgsfield: failed(error), elevenlabs: failed(error) };
    } else {
      const entries = parseMcpList(r.stdout);
      names = entries.map((e) => e.name);
      const detect = (key: ConnectorKey): ConnectorCheck => {
        const hit = findConnector(entries, key);
        return hit
          ? { server: hit.name, status: hit.status, message: `${hit.name}: ${STATUS_TEXT[hit.status]}`, checkedAt }
          : failed(`Claude Code kennt noch keinen ${CONNECTORS[key].label}-Zugang.`);
      };
      result = { higgsfield: detect("higgsfield"), elevenlabs: detect("elevenlabs") };
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    error = e.code === "ENOENT" ? notInstalled : `Prüfen fehlgeschlagen: ${e.message.split("\n")[0]}`;
    result = { higgsfield: failed(error), elevenlabs: failed(error) };
  }
  updateSettings(db, { higgsfield: { detected: result.higgsfield }, elevenlabsMcp: { detected: result.elevenlabs } });
  return { ...result, names, error };
}

/* ---------- Prüfung im Hintergrund (der Browser muss nicht warten) ---------- */

const CHECK_ROW = "mcp_check";
/** Läuft eine Prüfung länger, war der Server zwischendurch weg – dann gilt sie als abgebrochen. */
const STALE_MS = 3 * 60_000;

export type CheckState = {
  state: "idle" | "running" | "done" | "error";
  startedAt: number | null;
  finishedAt: number | null;
  /** Namen aller Verbindungen, die Claude Code kennt */
  names: string[];
  message: string;
};

const IDLE: CheckState = { state: "idle", startedAt: null, finishedAt: null, names: [], message: "" };

export function getCheckState(db: DB, now = Date.now()): CheckState {
  const row = db.select().from(settings).where(eq(settings.key, CHECK_ROW)).get();
  const s = { ...IDLE, ...((row?.value as Partial<CheckState> | undefined) ?? {}) };
  if (s.state === "running" && s.startedAt && now - s.startedAt > STALE_MS) {
    return { ...s, state: "error", message: "Die Prüfung wurde unterbrochen – bitte erneut prüfen." };
  }
  return s;
}

function setCheckState(db: DB, value: CheckState): void {
  db.insert(settings).values({ key: CHECK_ROW, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}

/**
 * Startet „claude mcp list“ im Hintergrund und kehrt sofort zurück. Das Ergebnis landet in den Einstellungen;
 * die Seite lädt sich neu, solange die Prüfung läuft. Wurde aus einer Karte heraus geprüft und der Dienst gefunden,
 * wird er eingeschaltet (ElevenLabs) – das war ja der Wunsch.
 */
export function startConnectorCheck(
  db: DB,
  opts: { env?: NodeJS.ProcessEnv; enable?: "elevenlabs"; timeoutMs?: number; now?: () => number } = {},
): { started: boolean; done: Promise<void> } {
  const now = opts.now ?? Date.now;
  const current = getCheckState(db, now());
  if (current.state === "running") return { started: false, done: Promise.resolve() };
  setCheckState(db, { state: "running", startedAt: now(), finishedAt: null, names: current.names, message: "" });
  const done = checkConnectors(db, { env: opts.env, timeoutMs: opts.timeoutMs })
    .then((r) => {
      if (opts.enable === "elevenlabs" && r.elevenlabs.status === "ok") updateSettings(db, { elevenlabsMcp: { enabled: true } });
      setCheckState(db, {
        state: r.error ? "error" : "done",
        startedAt: getCheckState(db, now()).startedAt,
        finishedAt: now(),
        names: r.names,
        message: r.error ?? "",
      });
    })
    .catch((err: unknown) => {
      setCheckState(db, { state: "error", startedAt: null, finishedAt: now(), names: [], message: `Prüfen fehlgeschlagen: ${(err as Error).message}` });
    });
  return { started: true, done };
}

/** Trägt einen Dienst bei Claude Code ein (für alle Projekte). Anmelden muss man sich danach einmal selbst. */
export async function addConnectorToClaude(key: ConnectorKey, env?: NodeJS.ProcessEnv): Promise<string> {
  let r: ClaudeResult;
  try {
    r = await runClaude(addArgs(key), { env, timeoutMs: 60_000 });
  } catch (err) {
    throw new Error((err as NodeJS.ErrnoException).code === "ENOENT" ? notInstalled : (err as Error).message);
  }
  const out = `${r.stdout}${r.stderr}`.trim();
  if (/already exists/i.test(out)) return `${CONNECTORS[key].label} ist bei Claude Code schon eingetragen.`;
  if (r.timedOut) throw new Error("Claude Code hat nicht geantwortet – im Terminal ausführen: claude " + addArgs(key).join(" "));
  if (r.code !== 0) throw new Error(out.split("\n")[0] || `Claude Code meldet Exit-Code ${r.code}`);
  return out;
}
