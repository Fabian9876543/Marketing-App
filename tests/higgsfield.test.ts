import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getSettings, updateSettings } from "@/lib/settings";
import { checkRemoteUrl, downloadTool, safeName, uploadTool } from "@/lib/studio/files";
import { addHiggsfieldToClaude, checkHiggsfield, findHiggsfield, higgsfieldFor, mcpToolPrefix, parseMcpList } from "@/lib/studio/higgsfield";
import { buildArgs } from "@/lib/studio/runner";
import { agentInstructions } from "@/lib/studio/workspace";
import { tempDir, testDb, testProject } from "./helpers";

const FAKE = path.resolve("tests/fixtures/fake-claude.mjs");

const LIST = `Checking MCP server health...

notion: https://mcp.notion.com/mcp (HTTP) - ⚠ Needs authentication
claude.ai Higgsfield: https://mcp.higgsfield.ai/mcp - ✓ Connected
higgsfield: https://mcp.higgsfield.ai/mcp (HTTP) - ⚠ Needs authentication
lokal: node /pfad/server.js - ✗ Failed to connect`;

describe("Higgsfield erkennen", () => {
  it("liest „claude mcp list“ und wählt den verbundenen Eintrag", () => {
    const entries = parseMcpList(LIST);
    expect(entries.map((e) => [e.name, e.status])).toEqual([
      ["notion", "auth"],
      ["claude.ai Higgsfield", "ok"],
      ["higgsfield", "auth"],
      ["lokal", "error"],
    ]);
    expect(findHiggsfield(entries)?.name).toBe("claude.ai Higgsfield");
    // Ist keiner verbunden, gewinnt der eigene Eintrag vor dem aus claude.ai
    expect(findHiggsfield(parseMcpList("higgsfield: https://mcp.higgsfield.ai/mcp (HTTP) - ⚠ Needs authentication"))?.name).toBe("higgsfield");
    expect(findHiggsfield(parseMcpList("No MCP servers configured."))).toBeNull();
    expect(mcpToolPrefix("claude.ai Higgsfield")).toBe("mcp__claude_ai_Higgsfield");
    expect(mcpToolPrefix("higgsfield")).toBe("mcp__higgsfield");
  });

  it("prüft über Claude Code, trägt Higgsfield ein und merkt sich das Ergebnis", async () => {
    const db = testDb();
    const log = path.join(tempDir("fps-mcp-"), "log.txt");
    const env = { ...process.env, CLAUDE_BIN: FAKE, FAKE_MCP_LOG: log };
    process.env.CLAUDE_BIN = FAKE;
    try {
      let d = await checkHiggsfield(db, { env });
      expect(d).toMatchObject({ server: "", status: "missing" });

      expect(await addHiggsfieldToClaude(env)).toContain("Added HTTP MCP server higgsfield");
      expect(fs.readFileSync(log, "utf8")).toContain("mcp add --transport http --scope user higgsfield https://mcp.higgsfield.ai/mcp");

      d = await checkHiggsfield(db, { env: { ...env, FAKE_MCP_LIST: LIST } });
      expect(d).toMatchObject({ server: "claude.ai Higgsfield", status: "ok", message: "claude.ai Higgsfield: verbunden" });
      expect(getSettings(db).higgsfield.detected.server).toBe("claude.ai Higgsfield");
    } finally {
      delete process.env.CLAUDE_BIN;
    }
  });
});

describe("Higgsfield in Studio-Aufträgen", () => {
  const ok = { server: "higgsfield", status: "ok" as const, message: "", checkedAt: 1 };

  it("nur wenn eingeschaltet, erkannt und – bei Automationen – ausdrücklich erlaubt", () => {
    const db = testDb();
    const chat = { automationId: null, analysis: false };
    expect(higgsfieldFor(db, chat)).toBeNull();
    updateSettings(db, { higgsfield: { enabled: true } });
    expect(higgsfieldFor(db, chat)).toBeNull(); // noch nicht erkannt
    updateSettings(db, { higgsfield: { detected: ok, maxCredits: 25 } });
    expect(higgsfieldFor(db, chat)).toEqual({ toolPrefix: "mcp__higgsfield", maxCredits: 25, unlim: true });
    expect(higgsfieldFor(db, { automationId: 3, analysis: false })).toBeNull();
    expect(higgsfieldFor(db, { automationId: null, analysis: true })).toBeNull();
    updateSettings(db, { higgsfield: { inAutomations: true } });
    expect(higgsfieldFor(db, { automationId: 3, analysis: false })).not.toBeNull();
  });

  it("Aufruf: ohne Higgsfield nur der Studio-Server, mit Higgsfield freigegeben samt Budget", () => {
    const base = { sessionUuid: "u", resume: false, mcpConfigPath: "/m.json", append: "Basis.", flags: new Set(["--strict-mcp-config"]) };
    const plain = buildArgs(base);
    expect(plain).toContain("--strict-mcp-config");
    expect(plain.join(" ")).not.toContain("higgsfield");

    const hf = buildArgs({ ...base, higgsfield: { toolPrefix: "mcp__claude_ai_Higgsfield", maxCredits: 40, unlim: false } });
    expect(hf).not.toContain("--strict-mcp-config");
    const allowed = hf.slice(hf.indexOf("--allowedTools") + 1, hf.indexOf("--disallowedTools"));
    expect(allowed).toContain("mcp__claude_ai_Higgsfield");
    const append = hf[hf.indexOf("--append-system-prompt") + 1];
    expect(append).toMatch(/^Basis\. Higgsfield ist freigegeben/);
    expect(append).toContain("höchstens 40 Credits");
    expect(append).toContain("use_unlim:false");
  });

  it("Anweisung für Claude erklärt den Ablauf", () => {
    const db = testDb();
    const md = agentInstructions(testProject(db));
    expect(md).toContain("## KI-Bilder und -Videos (Higgsfield)");
    expect(md).toContain("`media_upload` (Higgsfield) → `datei_hochladen` (studio) → `media_confirm` (Higgsfield)");
  });
});

/* ---------- Dateien laden und hochladen ---------- */

class FakeCdn {
  server = http.createServer((req, res) => void this.handle(req, res));
  base = "";
  uploads: { type: string | undefined; length: string | undefined; body: Buffer }[] = [];
  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url!, this.base);
    if (req.method === "PUT" && url.pathname === "/upload") {
      this.uploads.push({ type: req.headers["content-type"], length: req.headers["content-length"], body: Buffer.concat(chunks) });
      return void res.writeHead(200).end();
    }
    if (req.method === "PUT") return void res.writeHead(403).end("Signature expired");
    if (url.pathname === "/clip") return void res.writeHead(200, { "Content-Type": "video/mp4" }).end(Buffer.from("FAKE-MP4"));
    if (url.pathname === "/weiter") return void res.writeHead(302, { Location: "/bilder/start.png?sig=1" }).end();
    if (url.pathname === "/bilder/start.png") return void res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(Buffer.from("PNG"));
    if (url.pathname === "/seite") return void res.writeHead(200, { "Content-Type": "text/html" }).end("<html>");
    res.writeHead(404).end();
  }
}

const cdn = new FakeCdn();
beforeAll(() => cdn.start());
afterAll(() => cdn.server.close());
beforeEach(() => {
  cdn.uploads = [];
});

describe("Dateien für KI-Dienste", () => {
  it("nur https und keine Adressen im eigenen Netz", () => {
    expect(checkRemoteUrl("https://cdn.higgsfield.ai/a/b.mp4").hostname).toBe("cdn.higgsfield.ai");
    for (const bad of [
      "http://example.com/x.mp4",
      "https://localhost/x",
      "https://127.0.0.1:4321/api/media/1",
      "https://192.168.178.1/",
      "https://10.0.0.5/x",
      "https://[::1]/x",
      "https://fritz.box.local/x",
      "https://router/x",
      "https://user:pw@example.com/x",
      "file:///etc/passwd",
      "kein link",
    ]) {
      expect(() => checkRemoteUrl(bad), bad).toThrow();
    }
    expect(safeName("../../Praxis Intro.MP4")).toBe("praxis-intro");
  });

  it("lädt Videos und Bilder nach studio/public/ki/, folgt Weiterleitungen, lehnt anderes ab", async () => {
    const db = testDb();
    const p = testProject(db);
    const opts = { allowPrivate: true };
    const msg = await downloadTool(p, { url: `${cdn.base}/clip`, datei: "../Praxis Intro" }, opts);
    expect(msg).toContain('"src": "ki/praxis-intro.mp4"');
    expect(msg).toContain("aiGenerated");
    expect(fs.readFileSync(path.join(p.folder, "studio", "public", "ki", "praxis-intro.mp4"), "utf8")).toBe("FAKE-MP4");

    expect(await downloadTool(p, { url: `${cdn.base}/weiter`, datei: "start" }, opts)).toContain('"src": "ki/start.png"');
    await expect(downloadTool(p, { url: `${cdn.base}/seite`, datei: "x" }, opts)).rejects.toThrow(/Keine Bild-, Video- oder Audiodatei/);
    await expect(downloadTool(p, { url: `${cdn.base}/fehlt`, datei: "x" }, opts)).rejects.toThrow(/HTTP 404/);
    await expect(downloadTool(p, { url: `${cdn.base}/clip`, datei: "x" })).rejects.toThrow(/Nur https/);
    expect(fs.readdirSync(path.join(p.folder, "studio", "public", "ki")).sort()).toEqual(["praxis-intro.mp4", "start.png"]);
  });

  it("lädt nur Medien aus referenzen/, backlog/ und studio/public/ hoch", async () => {
    const db = testDb();
    const p = testProject(db);
    fs.mkdirSync(path.join(p.folder, "referenzen", "screenshot"), { recursive: true });
    fs.writeFileSync(path.join(p.folder, "referenzen", "screenshot", "start.png"), "PNGDATA");
    fs.writeFileSync(path.join(p.folder, "referenzen", "notiz.pdf"), "PDF");
    const opts = { allowPrivate: true };

    expect(await uploadTool(p, { datei: "referenzen/screenshot/start.png", upload_url: `${cdn.base}/upload` }, opts)).toContain("media_confirm");
    expect(cdn.uploads[0]).toMatchObject({ type: "image/png", length: "7" });
    expect(cdn.uploads[0].body.toString()).toBe("PNGDATA");

    for (const datei of ["../geheim.png", "PROJEKT.md", ".claude/settings.json", "studio/src/Short.tsx", "referenzen/notiz.pdf", "referenzen/fehlt.png"]) {
      await expect(uploadTool(p, { datei, upload_url: `${cdn.base}/upload` }, opts), datei).rejects.toThrow();
    }
    await expect(uploadTool(p, { datei: "referenzen/screenshot/start.png", upload_url: `${cdn.base}/abgelaufen` }, opts)).rejects.toThrow(/HTTP 403\): Signature expired/);
    await expect(uploadTool(p, { datei: "referenzen/screenshot/start.png", upload_url: "https://127.0.0.1/upload" })).rejects.toThrow(/Lokale/);
    expect(cdn.uploads).toHaveLength(1);
  });
});
