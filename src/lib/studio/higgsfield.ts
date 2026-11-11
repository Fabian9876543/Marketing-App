import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DB } from "../db/client";
import { getSettings, updateSettings, type AppSettings } from "../settings";
import { claudeBin } from "./claude";

/**
 * Higgsfield (KI-Bilder und -Videos) läuft im Studio über den offiziellen MCP-Server von Higgsfield,
 * den Claude Code selbst verbindet (Anmeldung per Browser, Abrechnung über dein Higgsfield-Abo).
 * Die App erkennt ihn mit „claude mcp list“ und gibt ihn für Studio-Aufträge frei.
 */

const execFileAsync = promisify(execFile);

export const HIGGSFIELD_MCP_URL = "https://mcp.higgsfield.ai/mcp";
export const HIGGSFIELD_ADD_ARGS = ["mcp", "add", "--transport", "http", "--scope", "user", "higgsfield", HIGGSFIELD_MCP_URL];

export type McpStatus = "ok" | "auth" | "error";
export type McpEntry = { name: string; target: string; status: McpStatus; statusText: string };

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

/** Der Higgsfield-Eintrag: verbundene vor nicht verbundenen, eigener vor dem aus claude.ai. */
export function findHiggsfield(entries: McpEntry[]): McpEntry | null {
  const hits = entries.filter((e) => /higgsfield/i.test(e.name) || /higgsfield\.ai/i.test(e.target));
  const rank = (e: McpEntry) => (e.status === "ok" ? 0 : e.status === "auth" ? 1 : 2) * 10 + (/^claude\.ai /i.test(e.name) ? 1 : 0);
  return hits.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** Name in Werkzeugnamen, wie Claude Code ihn bildet („claude.ai Higgsfield“ → „claude_ai_Higgsfield“). */
export function mcpToolPrefix(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "")}`;
}

const STATUS_TEXT: Record<McpStatus, string> = {
  ok: "verbunden",
  auth: "Anmeldung nötig",
  error: "nicht erreichbar",
};

export type HiggsfieldCheck = AppSettings["higgsfield"]["detected"];

/** Fragt Claude Code nach seinen MCP-Servern und merkt sich, ob und wie Higgsfield verbunden ist. */
export async function checkHiggsfield(db: DB, opts: { env?: NodeJS.ProcessEnv; now?: Date } = {}): Promise<HiggsfieldCheck> {
  let detected: HiggsfieldCheck;
  try {
    const { stdout } = await execFileAsync(claudeBin(), ["mcp", "list"], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: opts.env ?? process.env });
    const hit = findHiggsfield(parseMcpList(stdout));
    detected = hit
      ? { server: hit.name, status: hit.status, message: `${hit.name}: ${STATUS_TEXT[hit.status]}`, checkedAt: (opts.now ?? new Date()).getTime() }
      : { server: "", status: "missing", message: "Claude Code kennt noch keinen Higgsfield-Zugang.", checkedAt: (opts.now ?? new Date()).getTime() };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    detected = {
      server: "",
      status: "missing",
      message: e.code === "ENOENT" ? "Claude Code ist nicht installiert (Befehl „claude“ nicht gefunden)." : `Prüfen fehlgeschlagen: ${e.message.split("\n")[0]}`,
      checkedAt: (opts.now ?? new Date()).getTime(),
    };
  }
  updateSettings(db, { higgsfield: { detected } });
  return detected;
}

/** Trägt den Higgsfield-Server bei Claude Code ein (für alle Projekte). Anmelden muss man sich danach einmal selbst. */
export async function addHiggsfieldToClaude(env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(claudeBin(), HIGGSFIELD_ADD_ARGS, { timeout: 60_000, env: env ?? process.env });
    return `${stdout}${stderr}`.trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (/already exists/i.test(`${e.stderr ?? ""}${e.message}`)) return "Higgsfield ist bei Claude Code schon eingetragen.";
    throw new Error(e.code === "ENOENT" ? "Claude Code ist nicht installiert (Befehl „claude“ nicht gefunden)." : (e.stderr || e.message).trim().split("\n")[0]);
  }
}

export type HiggsfieldUse = { toolPrefix: string; maxCredits: number; unlim: boolean } | null;

/** Darf dieser Studio-Auftrag Higgsfield nutzen? (eingeschaltet, erkannt, und bei Automationen ausdrücklich erlaubt) */
export function higgsfieldFor(db: DB, session: { automationId: number | null; analysis: boolean; research?: boolean }): HiggsfieldUse {
  const h = getSettings(db).higgsfield;
  if (!h.enabled || !h.detected.server || h.detected.status === "missing") return null;
  if (session.analysis || session.research) return null;
  if (session.automationId && !h.inAutomations) return null;
  return { toolPrefix: mcpToolPrefix(h.detected.server), maxCredits: h.maxCredits, unlim: h.unlim };
}

/** Zusatz zum Systemauftrag, wenn Higgsfield freigegeben ist. */
export function higgsfieldAppend(use: NonNullable<HiggsfieldUse>): string {
  return [
    `Higgsfield ist freigegeben (Werkzeuge ${use.toolPrefix}__…) für KI-Bilder und -Videos.`,
    `Budget: höchstens ${use.maxCredits} Credits für diesen Auftrag – vor jeder Generierung die Kosten mit get_cost:true prüfen und mitzählen.`,
    use.unlim
      ? "Setze use_unlim:true (unbegrenzte Generierungen des Abos). Wird das abgelehnt, nimm Credits (use_unlim:false), solange das Budget reicht."
      : "Setze immer use_unlim:false.",
    "Ergebnisse mit datei_laden nach studio/public/ki/ holen; eigene Dateien für Referenzen mit media_upload, datei_hochladen und media_confirm hochladen. Videos im Format 9:16.",
  ].join(" ");
}
