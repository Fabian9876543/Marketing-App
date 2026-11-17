import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getProject, updateVoices } from "@/lib/projects";
import { getSettings, updateSettings } from "@/lib/settings";
import { elevenlabsFor, addElevenLabsToClaude } from "@/lib/studio/elevenlabs-connector";
import { downloadTool } from "@/lib/studio/files";
import { checkConnectors, getCheckState, startConnectorCheck } from "@/lib/studio/mcp-connectors";
import { buildArgs, connectorsFor } from "@/lib/studio/runner";
import { speakTool, voicesTool } from "@/lib/studio/tools";
import { agentInstructions } from "@/lib/studio/workspace";
import { setElevenLabsKey } from "@/lib/voice/elevenlabs";
import { tempDir, testDb, testProject } from "./helpers";

const FAKE = path.resolve("tests/fixtures/fake-claude.mjs");

const LIST = `Checking MCP server health...

claude.ai ElevenLabs: https://api.elevenlabs.io/v1/mcp - ✓ Connected
claude.ai Higgsfield: https://mcp.higgsfield.ai/mcp - ✓ Connected
notion: https://mcp.notion.com/mcp (HTTP) - ⚠ Needs authentication`;

const ok = (server: string) => ({ server, status: "ok" as const, message: "", checkedAt: 1 });

/* ---------- Nachgebauter Server: Audio-Download (Verbindung) und ElevenLabs-API (Schlüssel) ---------- */

class FakeServer {
  server = http.createServer((req, res) => void this.handle(req, res));
  base = "";
  log: string[] = [];
  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    for await (const _ of req);
    const url = new URL(req.url!, this.base);
    this.log.push(`${req.method} ${url.pathname}`);
    const json = (b: unknown) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(b));
    if (url.pathname === "/download/take.mp3") return void res.writeHead(200, { "Content-Type": "audio/mpeg" }).end(Buffer.from("FAKE-MP3"));
    if (url.pathname === "/download/bild.png") return void res.writeHead(200, { "Content-Type": "image/png" }).end(Buffer.from("PNG"));
    if (url.pathname === "/v2/voices") return json({ voices: [{ voice_id: "v-lena", name: "Lena" }], has_more: false });
    const tts = url.pathname.match(/^\/v1\/text-to-speech\/([^/]+)\/with-timestamps$/);
    if (tts) {
      const chars = [..."Hallo"];
      return json({
        audio_base64: Buffer.from(`MP3:${tts[1]}`).toString("base64"),
        alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.1), character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1) },
      });
    }
    res.writeHead(404).end();
  }
}

const fake = new FakeServer();
beforeAll(async () => {
  await fake.start();
  process.env.ELEVENLABS_API_BASE = fake.base;
});
afterAll(() => {
  fake.server.close();
  delete process.env.ELEVENLABS_API_BASE;
});
beforeEach(() => {
  fake.log = [];
});

describe("ElevenLabs über die Verbindung von Claude", () => {
  it("erkennt Higgsfield und ElevenLabs mit einer Abfrage und trägt ElevenLabs bei Claude Code ein", async () => {
    const db = testDb();
    const log = path.join(tempDir("fps-el-"), "log.txt");
    const env = { ...process.env, CLAUDE_BIN: FAKE, FAKE_MCP_LOG: log, FAKE_MCP_LIST: LIST };
    process.env.CLAUDE_BIN = FAKE;
    try {
      const r = await checkConnectors(db, { env });
      expect(r.elevenlabs).toMatchObject({ server: "claude.ai ElevenLabs", status: "ok" });
      expect(r.higgsfield).toMatchObject({ server: "claude.ai Higgsfield", status: "ok" });
      expect(getSettings(db).elevenlabsMcp.detected.server).toBe("claude.ai ElevenLabs");
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual(["mcp list"]); // nur eine Abfrage für beide

      expect(await addElevenLabsToClaude(env)).toContain("Added HTTP MCP server elevenlabs");
      expect(fs.readFileSync(log, "utf8")).toContain("mcp add --transport http --scope user elevenlabs https://api.elevenlabs.io/v1/mcp");
    } finally {
      delete process.env.CLAUDE_BIN;
    }
  });

  it("prüft im Hintergrund: sofort zurück, danach Ergebnis samt aller bekannten Verbindungen; ElevenLabs wird eingeschaltet", async () => {
    const db = testDb();
    const env = { ...process.env, CLAUDE_BIN: FAKE, FAKE_MCP_LIST: LIST, FAKE_MCP_SLEEP: "300" };
    process.env.CLAUDE_BIN = FAKE;
    try {
      const run = startConnectorCheck(db, { env, enable: "elevenlabs" });
      expect(run.started).toBe(true);
      expect(getCheckState(db).state).toBe("running");
      expect(startConnectorCheck(db, { env }).started).toBe(false); // läuft schon
      await run.done;
      const st = getCheckState(db);
      expect(st).toMatchObject({ state: "done", message: "" });
      expect(st.names).toEqual(["claude.ai ElevenLabs", "claude.ai Higgsfield", "notion"]);
      expect(getSettings(db).elevenlabsMcp).toMatchObject({ enabled: true, detected: { server: "claude.ai ElevenLabs", status: "ok" } });
      expect(getSettings(db).higgsfield.enabled).toBe(false); // Higgsfield nur von Hand einschalten
    } finally {
      delete process.env.CLAUDE_BIN;
    }
  });

  it("meldet, wenn Claude Code hängt oder fehlt – statt endlos zu warten", async () => {
    const db = testDb();
    process.env.CLAUDE_BIN = FAKE;
    try {
      const slow = startConnectorCheck(db, { env: { ...process.env, CLAUDE_BIN: FAKE, FAKE_MCP_SLEEP: "5000" }, timeoutMs: 300 });
      await slow.done;
      expect(getCheckState(db)).toMatchObject({ state: "error", message: expect.stringMatching(/nicht geantwortet/) });
      expect(getSettings(db).elevenlabsMcp.enabled).toBe(false);
    } finally {
      delete process.env.CLAUDE_BIN;
    }
    process.env.CLAUDE_BIN = "/gibt/es/nicht/claude";
    try {
      await startConnectorCheck(db, {}).done;
      expect(getCheckState(db)).toMatchObject({ state: "error", message: expect.stringMatching(/nicht gefunden/) });
    } finally {
      delete process.env.CLAUDE_BIN;
    }
    // Eine hängengebliebene Prüfung (Server neu gestartet) gilt nach 3 Minuten als abgebrochen
    expect(getCheckState(db, Date.now() + 10 * 60_000).state).not.toBe("running");
  });

  it("gibt die Verbindung nur frei, wenn eingeschaltet, erkannt und kein Schlüssel hinterlegt ist", async () => {
    const db = testDb();
    const p = testProject(db);
    const chat = { automationId: null, analysis: false };
    expect(elevenlabsFor(db, p, chat)).toBeNull();
    updateSettings(db, { elevenlabsMcp: { enabled: true } });
    expect(elevenlabsFor(db, p, chat)).toBeNull(); // noch nicht erkannt
    updateSettings(db, { elevenlabsMcp: { detected: ok("claude.ai ElevenLabs") }, voice: { model: "eleven_v3" } });

    const use = elevenlabsFor(db, getProject(db, p.id)!, chat)!;
    expect(use.toolPrefix).toBe("mcp__claude_ai_ElevenLabs");
    expect(use.append).toContain("creative_generate_speech");
    expect(use.append).toContain('model_id "eleven_v3" und generations_count 1');
    expect(use.append).toContain('datei_laden (ordner "stimme")');

    expect(elevenlabsFor(db, p, { automationId: 4, analysis: false })).not.toBeNull(); // Standard: auch in Automationen
    updateSettings(db, { elevenlabsMcp: { inAutomations: false } });
    expect(elevenlabsFor(db, p, { automationId: 4, analysis: false })).toBeNull();
    expect(elevenlabsFor(db, p, { automationId: null, analysis: true })).toBeNull();
    expect(elevenlabsFor(db, p, { automationId: null, analysis: false, research: true })).toBeNull();

    await setElevenLabsKey(db, "sk_test"); // mit Schlüssel: direkter Weg über stimme_erzeugen
    expect(elevenlabsFor(db, p, chat)).toBeNull();
  });

  it("Studio-Auftrag: beide Dienste freigegeben, ohne strikte MCP-Liste, Projektstimmen im Auftrag", () => {
    const db = testDb();
    let p = testProject(db);
    p = updateVoices(db, p.id, { main: { id: "", name: "Lena" }, second: { id: "", name: "Tom" } });
    updateSettings(db, {
      higgsfield: { enabled: true, detected: ok("claude.ai Higgsfield") },
      elevenlabsMcp: { enabled: true, detected: ok("claude.ai ElevenLabs") },
    });
    const connectors = connectorsFor(db, p, { automationId: null, analysis: false });
    expect(connectors.map((c) => c.toolPrefix)).toEqual(["mcp__claude_ai_Higgsfield", "mcp__claude_ai_ElevenLabs"]);
    expect(connectors[1].append).toContain("Hauptstimme „Lena“, zweite Stimme „Tom“ aus PROJEKT.md");

    const args = buildArgs({ sessionUuid: "u", resume: false, mcpConfigPath: "/m.json", append: "Basis.", flags: new Set(["--strict-mcp-config"]), connectors });
    expect(args).not.toContain("--strict-mcp-config");
    const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
    expect(allowed).toEqual(expect.arrayContaining(["mcp__claude_ai_Higgsfield", "mcp__claude_ai_ElevenLabs"]));
    const append = args[args.indexOf("--append-system-prompt") + 1];
    expect(append).toMatch(/^Basis\. Higgsfield ist freigegeben.* ElevenLabs ist über die Verbindung freigegeben/);
  });

  it("holt Sprachdateien nach studio/public/stimme/ und nennt die Dauer bzw. den Pfad für die Szene", async () => {
    const db = testDb();
    const p = testProject(db);
    const msg = await downloadTool(p, { url: `${fake.base}/download/take.mp3`, datei: "Termin Hook", ordner: "stimme" }, { allowPrivate: true });
    expect(msg).toContain('"voice": "stimme/termin-hook.mp3"');
    expect(msg).toContain("aiGenerated");
    expect(fs.readFileSync(path.join(p.folder, "studio", "public", "stimme", "termin-hook.mp3"), "utf8")).toBe("FAKE-MP3");
    await expect(downloadTool(p, { url: `${fake.base}/download/bild.png`, datei: "x", ordner: "stimme" }, { allowPrivate: true })).rejects.toThrow(/nur Audiodateien/);
  });

  it("ohne Schlüssel erklären die Studio-Werkzeuge den Weg über die Verbindung", async () => {
    const db = testDb();
    let p = testProject(db);
    expect(await voicesTool(db, p)).toMatch(/ElevenLabs-Verbindung von Claude einschalten oder einen API-Schlüssel/);
    updateSettings(db, { elevenlabsMcp: { enabled: true, detected: ok("claude.ai ElevenLabs") } });
    p = updateVoices(db, p.id, { main: { id: "", name: "Lena" } });
    const hint = await voicesTool(db, p);
    expect(hint).toContain("mcp__claude_ai_ElevenLabs__");
    expect(hint).toContain("creative_generate_speech (generations_count 1)");
    expect(hint).toContain("Hauptstimme „Lena“");
    await expect(speakTool(db, p, { text: "Hallo", datei: "x" })).rejects.toThrow(/creative_list_voices/);
  });

  it("Projektstimmen nur mit Namen: PROJEKT.md nennt sie, mit Schlüssel sucht stimme_erzeugen sie im Konto", async () => {
    const db = testDb();
    let p = testProject(db);
    p = updateVoices(db, p.id, { main: { id: "", name: " Lena " }, second: { id: "", name: "" } });
    expect(p.voices).toEqual({ main: { id: "", name: "Lena" } });
    expect(fs.readFileSync(path.join(p.folder, "PROJEKT.md"), "utf8")).toContain("- Hauptstimme (Erzähler, Assistent): Lena");

    await setElevenLabsKey(db, "sk_test");
    expect(await speakTool(db, p, { text: "Hallo", datei: "gruss" })).toContain('"voice": "stimme/gruss.mp3"');
    expect(fake.log).toContain("POST /v1/text-to-speech/v-lena/with-timestamps");
  });

  it("Arbeitsanweisung beschreibt beide Wege", () => {
    const db = testDb();
    const md = agentInstructions(testProject(db));
    expect(md).toContain("**Mit Schlüssel in der App:** `stimme_erzeugen`");
    expect(md).toContain("**Über die ElevenLabs-Verbindung**");
  });
});
