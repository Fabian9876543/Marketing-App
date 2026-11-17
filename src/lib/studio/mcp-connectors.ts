import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DB } from "../db/client";
import { updateSettings, type AppSettings } from "../settings";
import { claudeBin } from "./claude";

/**
 * Dienste, die Claude Code selbst verbindet (eigener MCP-Eintrag oder Connector aus claude.ai):
 * Anmeldung per Browser, Abrechnung über das jeweilige Abo, kein Schlüssel in der App.
 * Die App erkennt sie mit „claude mcp list“ und gibt sie pro Studio-Auftrag frei.
 */

const execFileAsync = promisify(execFile);

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

/** Fragt Claude Code einmal nach seinen MCP-Servern und merkt sich Higgsfield und ElevenLabs. */
export async function checkConnectors(db: DB, opts: { env?: NodeJS.ProcessEnv; now?: Date } = {}): Promise<Record<ConnectorKey, ConnectorCheck>> {
  const checkedAt = (opts.now ?? new Date()).getTime();
  let result: Record<ConnectorKey, ConnectorCheck>;
  try {
    const { stdout } = await execFileAsync(claudeBin(), ["mcp", "list"], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: opts.env ?? process.env });
    const entries = parseMcpList(stdout);
    const detect = (key: ConnectorKey): ConnectorCheck => {
      const hit = findConnector(entries, key);
      return hit
        ? { server: hit.name, status: hit.status, message: `${hit.name}: ${STATUS_TEXT[hit.status]}`, checkedAt }
        : { server: "", status: "missing", message: `Claude Code kennt noch keinen ${CONNECTORS[key].label}-Zugang.`, checkedAt };
    };
    result = { higgsfield: detect("higgsfield"), elevenlabs: detect("elevenlabs") };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const message = e.code === "ENOENT" ? "Claude Code ist nicht installiert (Befehl „claude“ nicht gefunden)." : `Prüfen fehlgeschlagen: ${e.message.split("\n")[0]}`;
    const failed: ConnectorCheck = { server: "", status: "missing", message, checkedAt };
    result = { higgsfield: failed, elevenlabs: failed };
  }
  updateSettings(db, { higgsfield: { detected: result.higgsfield }, elevenlabsMcp: { detected: result.elevenlabs } });
  return result;
}

/** Trägt einen Dienst bei Claude Code ein (für alle Projekte). Anmelden muss man sich danach einmal selbst. */
export async function addConnectorToClaude(key: ConnectorKey, env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(claudeBin(), addArgs(key), { timeout: 60_000, env: env ?? process.env });
    return `${stdout}${stderr}`.trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (/already exists/i.test(`${e.stderr ?? ""}${e.message}`)) return `${CONNECTORS[key].label} ist bei Claude Code schon eingetragen.`;
    throw new Error(e.code === "ENOENT" ? "Claude Code ist nicht installiert (Befehl „claude“ nicht gefunden)." : (e.stderr || e.message).trim().split("\n")[0]);
  }
}
