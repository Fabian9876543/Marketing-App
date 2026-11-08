import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { and, eq, inArray } from "drizzle-orm";
import { describePlan, planIntoNextSlot } from "../autoplan";
import { importBacklog } from "../backlog";
import type { DB } from "../db/client";
import { automations, contents, studioRuns, studioSessions, type Project, type StudioMessage } from "../db/schema";
import { dataDir, ensureDir } from "../env";
import { getProject } from "../projects";
import { getSettings } from "../settings";
import { claudeBin, claudeInfo, explainClaudeError, type ClaudeInfo } from "./claude";
import { addMessage } from "./sessions";
import { ALLOWED_TOOLS, DENIED_TOOLS, setupStudio } from "./workspace";

/* ---------- Aufruf zusammenbauen ---------- */

export function systemAppend(project: Project, now = new Date()): string {
  return [
    `Du läufst im Marketing Studio für das Projekt „${project.name}“, nicht interaktiv: Niemand kann Rückfragen beantworten.`,
    "Triff sinnvolle Annahmen, arbeite die Aufgabe vollständig ab und nenne deine Annahmen am Ende kurz.",
    "Halte dich an CLAUDE.md im Projektordner. Veröffentliche nichts.",
    "Dateien nur mit Write/Edit ändern. Im Terminal nur die Befehle aus CLAUDE.md, einzeln und ohne Variablen – alles andere wird automatisch abgelehnt.",
    `Heute ist ${now.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}.`,
  ].join(" ");
}

export function buildArgs(opts: {
  sessionUuid: string;
  resume: boolean;
  mcpConfigPath: string;
  model?: string;
  append: string;
  flags: Set<string>;
}): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"];
  // Neuere Versionen: alles, was nachfragen würde, automatisch ablehnen.
  if (opts.flags.has("--permission-prompts")) args.push("--permission-prompts", "none");
  args.push("--allowedTools", ...ALLOWED_TOOLS, "--disallowedTools", ...DENIED_TOOLS);
  args.push("--mcp-config", opts.mcpConfigPath);
  if (opts.flags.has("--strict-mcp-config")) args.push("--strict-mcp-config");
  args.push("--append-system-prompt", opts.append);
  if (opts.model) args.push("--model", opts.model);
  args.push(...(opts.resume ? ["--resume", opts.sessionUuid] : ["--session-id", opts.sessionUuid]));
  return args;
}

/** Secrets der App nicht an Claude (und dessen Shell) weitergeben. */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(base)) {
    if (/SECRET|CLIENT_ID|CLIENT_KEY|APP_ID|CONFIG_ID|^STUDIO_|^FPS_/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

/* ---------- Ausgabe von Claude Code (stream-json) übersetzen ---------- */

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

export type StreamEvent =
  | { type: "system"; subtype?: string; session_id?: string; model?: string }
  | { type: "assistant"; message: { content: Block[] } }
  | { type: "user"; message: { content: Block[] | string } }
  | {
      type: "result";
      subtype?: string;
      is_error?: boolean;
      result?: string;
      session_id?: string;
      total_cost_usd?: number;
      duration_ms?: number;
      num_turns?: number;
    }
  | { type: string; [k: string]: unknown };

export type ParsedMessage = { kind: StudioMessage["kind"]; text: string; toolName?: string; isError?: boolean };

const short = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Kurzbeschreibung eines Werkzeugaufrufs („Bash: npx remotion render …“). */
export function describeTool(name: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  switch (name) {
    case "Bash":
      return short(str("command"), 300);
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return str("file_path");
    case "Glob":
    case "Grep":
      return str("pattern");
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? (input.todos as { content?: string; status?: string }[]) : [];
      return todos.map((t) => `${t.status === "completed" ? "✓" : "·"} ${t.content ?? ""}`).join("\n");
    }
    default:
      return short(JSON.stringify(input), 300);
  }
}

/**
 * Claude Code hat einen Befehl abgelehnt, weil er im Studio nicht freigegeben ist (keine Rückfrage möglich).
 * Liefert den Grund (erste Zeile) oder null, wenn es keine solche Ablehnung ist.
 */
export function blockedReason(text: string): string | null {
  if (!/Permission for this tool use was denied|requested permissions to use|haven't granted it yet/i.test(text)) return null;
  const reason = text.match(/What required approval:\s*(.+)/)?.[1] ?? "";
  return short(reason.trim(), 160);
}

/** Ein stream-json-Ereignis in Chat-Nachrichten übersetzen. */
export function parseEvent(ev: StreamEvent): ParsedMessage[] {
  if (ev.type === "assistant") {
    const content = (ev as Extract<StreamEvent, { type: "assistant" }>).message?.content ?? [];
    return content.flatMap((b): ParsedMessage[] => {
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) return [{ kind: "assistant", text: b.text.trim() }];
      if (b.type === "tool_use") {
        const name = String(b.name).replace(/^mcp__studio__/, "studio: ");
        return [{ kind: "tool", toolName: name, text: describeTool(String(b.name), (b.input ?? {}) as Record<string, unknown>) }];
      }
      return [];
    });
  }
  if (ev.type === "user") {
    const content = (ev as Extract<StreamEvent, { type: "user" }>).message?.content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((b): ParsedMessage[] => {
      if (b.type !== "tool_result") return [];
      const raw = b.content;
      const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((c) => (c as { text?: string }).text ?? "").join("\n") : "";
      const blocked = b.is_error ? blockedReason(text) : null;
      if (blocked != null) {
        return [{ kind: "info", text: `Befehl gesperrt (im Studio nicht freigegeben) – Claude macht ohne ihn weiter.${blocked ? ` Grund: ${blocked}` : ""}` }];
      }
      return [{ kind: "tool_result", text: short(text.trim(), 2000), isError: Boolean(b.is_error) }];
    });
  }
  if (ev.type === "result") {
    const r = ev as Extract<StreamEvent, { type: "result" }>;
    const failed = Boolean(r.is_error) || (r.subtype !== undefined && r.subtype !== "success");
    const parts = [failed ? "Abgebrochen mit Fehler" : "Fertig"];
    if (r.duration_ms) parts.push(`nach ${formatDuration(r.duration_ms)}`);
    if (r.num_turns) parts.push(`${r.num_turns} Schritte`);
    const text = failed && r.result ? `${parts.join(" · ")}: ${explainClaudeError(r.result)}` : parts.join(" · ");
    return [{ kind: failed ? "error" : "result", text, isError: failed }];
  }
  return [];
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} Min. ${s % 60} s`;
}

/* ---------- Auftrag ausführen ---------- */

export type RunOptions = {
  /** Ordner der App (für MCP-Server und Vorlage) */
  appDir?: string;
  info?: ClaudeInfo;
  /** Für Tests: Prozess starten */
  spawnFn?: typeof spawn;
  /** Wie oft auf „Abbrechen“ geprüft wird */
  cancelPollMs?: number;
};

/** Führt einen Studio-Auftrag aus: Claude Code starten, Verlauf speichern, neue Shorts einlesen. */
export async function executeRun(db: DB, runId: number, opts: RunOptions = {}): Promise<void> {
  const run = db.select().from(studioRuns).where(eq(studioRuns.id, runId)).get();
  if (!run || run.state !== "queued") return;
  const session = db.select().from(studioSessions).where(eq(studioSessions.id, run.sessionId)).get()!;
  const project = getProject(db, session.projectId);
  const say = (m: ParsedMessage) => addMessage(db, session.id, runId, m.kind, m.text, { toolName: m.toolName, isError: m.isError });
  const finish = (patch: Partial<typeof studioRuns.$inferInsert>) =>
    db.update(studioRuns).set({ endedAt: new Date(), ...patch }).where(eq(studioRuns.id, runId)).run();

  if (!project) {
    finish({ state: "error", error: "Projekt nicht gefunden" });
    return;
  }
  const info = opts.info ?? (await claudeInfo());
  if (!info.available) {
    const error = `${info.error ?? "Claude Code nicht gefunden."} Installation: https://docs.claude.com/claude-code – danach im Terminal „claude“ starten und anmelden.`;
    say({ kind: "error", text: error, isError: true });
    finish({ state: "error", error });
    return;
  }

  setupStudio(project); // Vorlage und Anweisungen sicherstellen
  const appDir = opts.appDir ?? process.env.STUDIO_APP_DIR ?? process.cwd();
  const before = new Set(slugsOf(db, project.id));
  const mcpFile = path.join(ensureDir(path.join(dataDir(), "studio")), `mcp-${runId}.json`);
  fs.writeFileSync(
    mcpFile,
    JSON.stringify({
      mcpServers: {
        studio: {
          command: process.execPath,
          args: [path.join(appDir, "node_modules", "tsx", "dist", "cli.mjs"), path.join(appDir, "mcp", "studio-server.ts")],
          env: {
            STUDIO_PROJECT_ID: String(project.id),
            STUDIO_DATA_DIR: dataDir(),
            STUDIO_APP_DIR: appDir,
            TSX_TSCONFIG_PATH: path.join(appDir, "tsconfig.json"),
            ...(process.env.STUDIO_KEYSTORE || process.env.FPS_KEYSTORE ? { STUDIO_KEYSTORE: process.env.STUDIO_KEYSTORE || process.env.FPS_KEYSTORE } : {}),
          },
        },
      },
    }),
  );

  const args = buildArgs({
    sessionUuid: session.claudeSessionId,
    resume: session.started,
    mcpConfigPath: mcpFile,
    model: getSettings(db).studio.model || undefined,
    append: systemAppend(project),
    flags: info.flags,
  });

  const child: ChildProcess = (opts.spawnFn ?? spawn)(claudeBin(), args, {
    cwd: project.folder,
    env: childEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  db.update(studioRuns).set({ state: "running", startedAt: new Date(), pid: child.pid ?? null }).where(eq(studioRuns.id, runId)).run();
  db.update(studioSessions).set({ updatedAt: new Date() }).where(eq(studioSessions.id, session.id)).run();

  // Auftrag über stdin übergeben (robust bei langen, mehrzeiligen Texten)
  child.stdin?.end(run.prompt);

  let stderr = "";
  let result: Extract<StreamEvent, { type: "result" }> | null = null;
  child.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-10_000)));

  const lines = readline.createInterface({ input: child.stdout! });
  lines.on("line", (line) => {
    if (!line.trim().startsWith("{")) return;
    let ev: StreamEvent;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === "system" && (ev as { subtype?: string }).subtype === "init" && !session.started) {
      db.update(studioSessions).set({ started: true }).where(eq(studioSessions.id, session.id)).run();
      session.started = true;
    }
    if (ev.type === "result") result = ev as Extract<StreamEvent, { type: "result" }>;
    for (const m of parseEvent(ev)) say(m);
  });

  let cancelled = false;
  const poll = setInterval(() => {
    const current = db.select({ cancel: studioRuns.cancelRequested }).from(studioRuns).where(eq(studioRuns.id, runId)).get();
    if (current?.cancel && !cancelled) {
      cancelled = true;
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 5000).unref();
    }
  }, opts.cancelPollMs ?? 1000);

  const exitCode: number | null = await new Promise((resolve) => {
    child.on("error", (err) => {
      stderr += `\n${err.message}`;
      resolve(-1);
    });
    child.on("close", (code) => resolve(code));
  });
  clearInterval(poll);
  await new Promise((r) => setImmediate(r)); // restliche Zeilen verarbeiten
  fs.rmSync(mcpFile, { force: true });

  // Neue Shorts einlesen
  let newShorts: string[] = [];
  try {
    await importBacklog(db, project);
    newShorts = slugsOf(db, project.id).filter((s) => !before.has(s));
    if (newShorts.length) say({ kind: "info", text: `Neu im Backlog: ${newShorts.join(", ")}` });
  } catch (err) {
    say({ kind: "error", text: `Backlog konnte nicht eingelesen werden: ${(err as Error).message}`, isError: true });
  }

  const r = result as Extract<StreamEvent, { type: "result" }> | null;
  const base = { costUsd: r?.total_cost_usd ?? null, durationMs: r?.duration_ms ?? null, newShorts, pid: null };
  if (cancelled) {
    say({ kind: "info", text: "Abgebrochen." });
    finish({ ...base, state: "cancelled" });
  } else if (exitCode !== 0 || !r || r.is_error) {
    const error = explainClaudeError(r?.result || stderr || `Claude Code wurde mit Code ${exitCode} beendet`);
    if (!r) say({ kind: "error", text: error, isError: true });
    finish({ ...base, state: "error", error });
  } else {
    finish({ ...base, state: "done", error: null });
    if (session.automationId && newShorts.length) autoScheduleNewShorts(db, project, session.automationId, newShorts, say);
  }
}

/** Nach einem Automations-Lauf: neue Shorts in freie Slots legen – zur Freigabe. */
function autoScheduleNewShorts(db: DB, project: Project, automationId: number, slugs: string[], say: (m: ParsedMessage) => void): void {
  const automation = db.select().from(automations).where(eq(automations.id, automationId)).get();
  if (!automation?.autoSchedule) return;
  const tz = getSettings(db).timezone;
  for (const slug of slugs) {
    const content = db
      .select()
      .from(contents)
      .where(and(eq(contents.projectId, project.id), eq(contents.slug, slug)))
      .get();
    if (!content) continue;
    const r = planIntoNextSlot(db, project, content.id, { createdBy: "auto" });
    say({
      kind: "info",
      text: r.ok ? `Zur Freigabe eingeplant: ${slug} → ${describePlan(r, tz)}` : `${slug} nicht eingeplant: ${describePlan(r, tz)}`,
    });
  }
}

function slugsOf(db: DB, projectId: number): string[] {
  return db
    .select({ slug: contents.slug })
    .from(contents)
    .where(eq(contents.projectId, projectId))
    .all()
    .map((c) => c.slug);
}

/* ---------- Warteschlange im Worker ---------- */

/** Verteilt wartende Studio-Aufträge (höchstens n gleichzeitig, pro Chat nacheinander). */
export class StudioQueue {
  private running = new Map<number, Promise<void>>();

  constructor(
    private db: DB,
    private opts: RunOptions = {},
  ) {}

  /** Nach einem Neustart: Aufträge, die „laufen“, gibt es nicht mehr. */
  recover(): number {
    const stale = this.db.select().from(studioRuns).where(eq(studioRuns.state, "running")).all();
    for (const run of stale) {
      this.db.update(studioRuns).set({ state: "error", error: "Abgebrochen: Der Worker wurde neu gestartet", endedAt: new Date(), pid: null }).where(eq(studioRuns.id, run.id)).run();
      addMessage(this.db, run.sessionId, run.id, "error", "Abgebrochen: Der Worker wurde neu gestartet. Schick den Auftrag einfach noch einmal.", { isError: true });
    }
    return stale.length;
  }

  tick(): void {
    const max = getSettings(this.db).studio.maxParallel;
    if (this.running.size >= max) return;
    const queued = this.db.select().from(studioRuns).where(eq(studioRuns.state, "queued")).orderBy(studioRuns.id).all();
    const busySessions = new Set(
      this.db
        .select({ sessionId: studioRuns.sessionId })
        .from(studioRuns)
        .where(inArray(studioRuns.state, ["running"]))
        .all()
        .map((r) => r.sessionId),
    );
    for (const run of queued) {
      if (this.running.size >= max) break;
      if (this.running.has(run.id) || busySessions.has(run.sessionId)) continue;
      busySessions.add(run.sessionId);
      const p = executeRun(this.db, run.id, this.opts)
        .catch((err) => {
          addMessage(this.db, run.sessionId, run.id, "error", `Interner Fehler: ${(err as Error).message}`, { isError: true });
          this.db.update(studioRuns).set({ state: "error", error: (err as Error).message, endedAt: new Date() }).where(eq(studioRuns.id, run.id)).run();
        })
        .finally(() => this.running.delete(run.id));
      this.running.set(run.id, p);
    }
  }

  get active(): number {
    return this.running.size;
  }

  /** Für Tests: auf alle laufenden Aufträge warten. */
  async idle(): Promise<void> {
    await Promise.all([...this.running.values()]);
  }
}
