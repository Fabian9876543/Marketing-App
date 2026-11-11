import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { eq } from "drizzle-orm";
import { listLearnings } from "@/lib/learnings";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertAccount } from "@/lib/accounts";
import { importBacklog } from "@/lib/backlog";
import { openDb } from "@/lib/db/client";
import { posts, studioRuns, studioSessions } from "@/lib/db/schema";
import { listPostViews } from "@/lib/posts";
import { updateBrief } from "@/lib/projects";
import { addSlot } from "@/lib/slots";
import { claudeInfo, explainClaudeError } from "@/lib/studio/claude";
import { blockedReason, buildArgs, childEnv, describeTool, executeRun, parseEvent, StudioQueue } from "@/lib/studio/runner";
import { cancelSession, createSession, sendMessage, sessionMessages, sessionRuns } from "@/lib/studio/sessions";
import { freeSlotsTool, proposeTool } from "@/lib/studio/tools";
import { agentInstructions, setupStudio, studioStatus } from "@/lib/studio/workspace";
import { makeShort, tempDir, testDb, testProject } from "./helpers";

const FAKE = path.resolve("tests/fixtures/fake-claude.mjs");
let argsFile = "";

beforeAll(() => {
  process.env.CLAUDE_BIN = FAKE;
  argsFile = path.join(tempDir(), "args.jsonl");
  process.env.FAKE_ARGS_FILE = argsFile;
});
afterAll(() => {
  delete process.env.CLAUDE_BIN;
  delete process.env.FAKE_ARGS_FILE;
});

const lastCall = () => JSON.parse(fs.readFileSync(argsFile, "utf8").trim().split("\n").at(-1)!) as { args: string[]; cwd: string; envKeys: string[] };

describe("Arbeitsbereich im Projektordner", () => {
  it("kopiert die Vorlage, schreibt CLAUDE.md und erlaubte Befehle – eigene Anpassungen bleiben", () => {
    const db = testDb();
    const p = testProject(db, "Studio-Test");
    expect(studioStatus(p)).toEqual({ template: false, installed: false, instructions: false });
    const s = setupStudio(p);
    expect(s).toMatchObject({ template: true, instructions: true });
    const brand = JSON.parse(fs.readFileSync(path.join(p.folder, "studio", "brand.json"), "utf8"));
    expect(brand).toMatchObject({ name: "Studio-Test", primary: p.color });
    const settings = JSON.parse(fs.readFileSync(path.join(p.folder, ".claude", "settings.json"), "utf8"));
    expect(settings.permissions.allow).toContain("Bash(npx remotion *)");
    expect(settings.permissions.allow).not.toContain("Bash(*)");
    expect(settings.permissions.deny).toContain("Bash(rm *)");
    expect(fs.readFileSync(path.join(p.folder, "CLAUDE.md"), "utf8")).toContain("Nichts veröffentlichen");

    // Eigene Änderungen: Vorlage und selbst gepflegte CLAUDE.md werden nicht überschrieben
    fs.writeFileSync(path.join(p.folder, "studio", "brand.json"), '{"primary":"#000000"}');
    fs.writeFileSync(path.join(p.folder, "CLAUDE.md"), "Meine eigene Anweisung");
    setupStudio(p);
    expect(fs.readFileSync(path.join(p.folder, "studio", "brand.json"), "utf8")).toContain("#000000");
    expect(fs.readFileSync(path.join(p.folder, "CLAUDE.md"), "utf8")).toBe("Meine eigene Anweisung");
    expect(agentInstructions(p)).toContain("backlog/<JJJJ-MM-TT>-<kurzer-slug>/");
  });
});

describe("Aufruf von Claude Code", () => {
  it("erster Lauf mit --session-id, danach --resume; neuere Optionen nur, wenn vorhanden", () => {
    const base = { sessionUuid: "u-1", mcpConfigPath: "/x/mcp.json", append: "A", model: "" };
    const first = buildArgs({ ...base, resume: false, flags: new Set(["--permission-prompts", "--strict-mcp-config"]) });
    expect(first.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
    expect(first).toEqual(expect.arrayContaining(["--session-id", "u-1", "--permission-prompts", "none", "--strict-mcp-config", "--mcp-config", "/x/mcp.json"]));
    expect(first[first.indexOf("--allowedTools") + 1]).toBe("Read");
    const old = buildArgs({ ...base, resume: true, model: "sonnet", flags: new Set() });
    expect(old).toEqual(expect.arrayContaining(["--resume", "u-1", "--model", "sonnet"]));
    expect(old).not.toContain("--permission-prompts");
    expect(old).not.toContain("--session-id");
  });

  it("gibt keine Zugangsdaten der App an Claude weiter", () => {
    const env = childEnv({ PATH: "/bin", HOME: "/h", GOOGLE_CLIENT_SECRET: "x", META_APP_ID: "y", TIKTOK_CLIENT_KEY: "z", STUDIO_DATA_DIR: "/d", NODE_ENV: "test" });
    expect(Object.keys(env).sort()).toEqual(["HOME", "NODE_ENV", "PATH"]);
  });

  it("übersetzt die Ausgabe in Chat-Nachrichten", () => {
    expect(parseEvent({ type: "assistant", message: { content: [{ type: "text", text: " Hallo " }, { type: "tool_use", id: "1", name: "Bash", input: { command: "ls" } }] } })).toEqual([
      { kind: "assistant", text: "Hallo" },
      { kind: "tool", toolName: "Bash", text: "ls" },
    ]);
    expect(parseEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "2", name: "mcp__studio__freie_slots", input: { anzahl: 3 } }] } })[0]).toMatchObject({
      toolName: "studio: freie_slots",
      text: '{"anzahl":3}',
    });
    expect(parseEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "1", content: [{ type: "text", text: "ok" }], is_error: true }] } })).toEqual([
      { kind: "tool_result", text: "ok", isError: true },
    ]);
    expect(parseEvent({ type: "result", subtype: "success", duration_ms: 125000, num_turns: 7 })[0]).toEqual({ kind: "result", text: "Fertig · nach 2 Min. 5 s · 7 Schritte", isError: false });
    expect(parseEvent({ type: "result", subtype: "error_max_turns", is_error: true, result: "Please run /login" })[0].text).toContain("nicht angemeldet");
    expect(parseEvent({ type: "stream_event" })).toEqual([]);
    const denied =
      "Permission for this tool use was denied. It requires approval, and this session has no approval surface — nobody can answer a permission prompt here.\nWhat required approval: A variable in this command can't be checked before it runs";
    expect(parseEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "3", content: denied, is_error: true }] } })).toEqual([
      { kind: "info", text: "Befehl gesperrt (im Studio nicht freigegeben) – Claude macht ohne ihn weiter. Grund: A variable in this command can't be checked before it runs" },
    ]);
    expect(blockedReason("Claude requested permissions to use Bash, but you haven't granted it yet.")).toBe("");
    expect(blockedReason("Error: ENOENT")).toBeNull();
    expect(describeTool("TodoWrite", { todos: [{ content: "Rendern", status: "completed" }, { content: "Texte", status: "pending" }] })).toBe("✓ Rendern\n· Texte");
  });

  it("erkennt eine fehlende Installation und Anmeldeprobleme", async () => {
    const saved = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = "/gibt/es/nicht/claude";
    const info = await claudeInfo(true);
    expect(info).toMatchObject({ available: false });
    expect(info.error).toContain("nicht installiert");
    process.env.CLAUDE_BIN = saved;
    const ok = await claudeInfo(true);
    expect(ok).toMatchObject({ available: true, version: "9.9.9 (Claude Code, Test)" });
    expect(ok.flags.has("--permission-prompts")).toBe(true);
    expect(explainClaudeError("Error: usage limit reached")).toContain("Kontingent");
  });
});

describe("Studio-Aufträge", () => {
  it("führt einen Auftrag aus, speichert den Verlauf und liest neue Shorts ein", async () => {
    const db = testDb();
    const p = testProject(db, "Lauf");
    const { session, run } = createSession(db, p.id, "Bitte einen Short render-n");
    await executeRun(db, run.id, { info: await claudeInfo(true), appDir: process.cwd() });

    const r = sessionRuns(db, session.id)[0];
    expect(r).toMatchObject({ state: "done", costUsd: 0.0123, durationMs: 61000 });
    expect(r.newShorts).toHaveLength(1);
    const kinds = sessionMessages(db, session.id).map((m) => m.kind);
    expect(kinds).toEqual(["user", "assistant", "tool", "tool_result", "tool", "tool_result", "assistant", "result", "info"]);
    expect(sessionMessages(db, session.id).at(-1)!.text).toContain("Neu im Backlog");

    const call = lastCall();
    expect(call.cwd).toBe(fs.realpathSync(p.folder));
    expect(call.args).toContain("--session-id");
    expect(call.envKeys.some((k) => /SECRET|STUDIO_/.test(k))).toBe(false);
    expect(db.select().from(studioSessions).where(eq(studioSessions.id, session.id)).get()!.started).toBe(true);

    // Folgeauftrag setzt die Sitzung fort
    const next = sendMessage(db, session.id, "Danke, und jetzt?");
    await executeRun(db, next.id, { info: await claudeInfo(true), appDir: process.cwd() });
    expect(lastCall().args).toContain("--resume");
    expect(sessionRuns(db, session.id)[1].state).toBe("done");
  });

  it("Fehler und fehlende Anmeldung werden verständlich gemeldet", async () => {
    const db = testDb();
    const p = testProject(db);
    const a = createSession(db, p.id, "bitte fehler machen");
    await executeRun(db, a.run.id, { info: await claudeInfo(true) });
    expect(sessionRuns(db, a.session.id)[0]).toMatchObject({ state: "error" });

    const b = createSession(db, p.id, "nicht angemeldet");
    await executeRun(db, b.run.id, { info: await claudeInfo(true) });
    const run = sessionRuns(db, b.session.id)[0];
    expect(run.state).toBe("error");
    expect(run.error).toContain("nicht angemeldet");
  });

  it("Abbrechen beendet den laufenden Prozess; pro Chat nur ein Auftrag gleichzeitig", async () => {
    const db = testDb();
    const p = testProject(db);
    const { session, run } = createSession(db, p.id, "bitte langsam arbeiten");
    expect(() => sendMessage(db, session.id, "noch was")).toThrow(/arbeitet noch/);
    const running = executeRun(db, run.id, { info: await claudeInfo(true), cancelPollMs: 50 });
    await new Promise((r) => setTimeout(r, 800));
    expect(cancelSession(db, session.id)).toBe(true);
    await running;
    expect(sessionRuns(db, session.id)[0].state).toBe("cancelled");
  }, 15000);

  it("Warteschlange: höchstens n gleichzeitig, nach Neustart werden hängende Läufe beendet", async () => {
    const file = path.join(tempDir(), "q.db");
    const db = openDb(file);
    const p = testProject(db, "Queue");
    const q = new StudioQueue(db, { info: await claudeInfo(true) });
    createSession(db, p.id, "eins");
    createSession(db, p.id, "zwei");
    createSession(db, p.id, "drei");
    q.tick();
    expect(q.active).toBe(2);
    await q.idle();
    q.tick();
    await q.idle();
    expect(db.select().from(studioRuns).all().map((r) => r.state)).toEqual(["done", "done", "done"]);

    const s = createSession(db, p.id, "hängt");
    db.update(studioRuns).set({ state: "running" }).where(eq(studioRuns.id, s.run.id)).run();
    expect(new StudioQueue(db).recover()).toBe(1);
    expect(sessionRuns(db, s.session.id)[0].state).toBe("error");
  }, 20000);
});

describe("Werkzeuge für Claude (MCP)", () => {
  it("zur Freigabe einplanen erzeugt einen Post, der auf Freigabe wartet", async () => {
    const db = testDb();
    const p = testProject(db);
    makeShort(p.folder, "2026-11-07-demo");
    await importBacklog(db, p);
    await upsertAccount(db, { projectId: p.id, platform: "simulator", externalId: "t", name: "T" });
    expect(freeSlotsTool(db, p)).toContain("keine Posting-Zeiten");
    addSlot(db, p.id, "09:00", [1, 2, 3, 4, 5, 6, 7]);
    expect(freeSlotsTool(db, p, 2).split("\n")).toHaveLength(2);

    const msg = await proposeTool(db, p, { slug: "2026-11-07-demo" });
    expect(msg).toContain("erst nach Freigabe");
    const [v] = listPostViews(db, { projectId: p.id });
    expect(v).toMatchObject({ state: "review", createdBy: "agent" });
    await expect(proposeTool(db, p, { slug: "gibt-es-nicht" })).rejects.toThrow(/Kein Short/);
    await expect(proposeTool(db, p, { slug: "2026-11-07-demo", zeit: "morgen" })).rejects.toThrow(/Ungültige Zeit/);
    expect(db.select().from(posts).all()).toHaveLength(1);
  });

  it("MCP-Server antwortet über das echte Protokoll", async () => {
    const dataDir = tempDir("fps-mcp-data-");
    process.env.FPS_DATA_DIR = dataDir;
    const db = openDb(path.join(dataDir, "studio.db"));
    const p = testProject(db, "MCP-Projekt");
    updateBrief(db, p.id, { audience: "Testzielgruppe" });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("mcp/studio-server.ts")],
      env: { ...(process.env as Record<string, string>), STUDIO_PROJECT_ID: String(p.id), STUDIO_DATA_DIR: dataDir, STUDIO_APP_DIR: process.cwd() },
      cwd: p.folder,
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      "backlog_einlesen",
      "backlog_liste",
      "beispiel_einzelbilder",
      "beispiel_transkript",
      "datei_hochladen",
      "datei_laden",
      "erkenntnis_vorschlagen",
      "erkenntnisse",
      "freie_slots",
      "instagram_konto_ansehen",
      "konten_liste",
      "muster_vorschlagen",
      "projekt_briefing",
      "recherche_quellen",
      "statistik",
      "stimme_erzeugen",
      "stimmen_liste",
      "werbebibliothek_suchen",
      "youtube_shorts_suchen",
      "zur_freigabe_einplanen",
    ]);
    const stats = await client.callTool({ name: "statistik", arguments: { tage: 7 } });
    expect(JSON.stringify(stats.content)).toContain("Keine Zahlen");
    const proposal = await client.callTool({ name: "erkenntnis_vorschlagen", arguments: { text: "Hook als Frage formulieren", begruendung: "Test" } });
    expect(JSON.stringify(proposal.content)).toContain("Vorgeschlagen");
    expect(listLearnings(db, p.id)).toMatchObject([{ text: "Hook als Frage formulieren", status: "proposed" }]);
    const brief = await client.callTool({ name: "projekt_briefing", arguments: {} });
    expect(JSON.stringify(brief.content)).toContain("Testzielgruppe");
    const bad = await client.callTool({ name: "zur_freigabe_einplanen", arguments: { slug: "nix" } });
    expect(bad.isError).toBe(true);
    await client.close();
  }, 30000);
});

describe("Schnellaktionen", () => {
  it("Chat-Titel: eigener Titel oder gekürzter Auftrag", () => {
    const db = testDb();
    const p = testProject(db);
    expect(createSession(db, p.id, "x".repeat(100)).session.title).toHaveLength(58);
    expect(createSession(db, p.id, "langer Auftrag", "Neuen Short machen").session.title).toBe("Neuen Short machen");
    expect(() => createSession(db, p.id, "  ")).toThrow(/was Claude tun soll/);
  });
});
