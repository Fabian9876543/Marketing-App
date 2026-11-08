import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { settings } from "@/lib/db/schema";
import { getProject, updateVoices } from "@/lib/projects";
import { updateSettings } from "@/lib/settings";
import { childEnv } from "@/lib/studio/runner";
import { speakTool, voiceFileName, voicesTool } from "@/lib/studio/tools";
import { agentInstructions, pendingTemplateMerges, setupStudio, studioDir, TEMPLATE_VERSION, upgradeTemplate } from "@/lib/studio/workspace";
import { getElevenLabsKey, getUsage, hasElevenLabsKey, listVoices, setElevenLabsKey, synthesize, wordsFromAlignment } from "@/lib/voice/elevenlabs";
import { testDb, testProject } from "./helpers";

/* ---------- Nachgebaute ElevenLabs-API ---------- */

class FakeElevenLabs {
  server = http.createServer((req, res) => void this.handle(req, res));
  base = "";
  log: { method: string; path: string; key: string | undefined; body: string }[] = [];
  mode: "ok" | "quota" | "busy-once" = "ok";
  private busy = false;

  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(req.url!, this.base);
    const key = req.headers["xi-api-key"] as string | undefined;
    this.log.push({ method: req.method!, path: `${url.pathname}${url.search}`, key, body });
    if (key !== "sk_gueltig") return this.json(res, 401, { detail: { status: "invalid_api_key", message: "Invalid API key" } });

    if (url.pathname === "/v2/voices") {
      if (!url.searchParams.get("next_page_token")) {
        return this.json(res, 200, {
          voices: [{ voice_id: "v-anna", name: "Anna", category: "premade", labels: { gender: "female", age: "middle_aged", accent: "german" }, preview_url: "https://x/anna.mp3" }],
          has_more: true,
          next_page_token: "S2",
        });
      }
      return this.json(res, 200, { voices: [{ voice_id: "v-ben", name: "Ben", category: "cloned", description: "Ruhiger Erzähler" }], has_more: false });
    }
    if (url.pathname === "/v1/user/subscription") {
      return this.json(res, 200, { character_count: 1234, character_limit: 30000, next_character_count_reset_unix: 1798761600, tier: "creator" });
    }
    const tts = url.pathname.match(/^\/v1\/text-to-speech\/([^/]+)(\/with-timestamps)?$/);
    if (tts && req.method === "POST") {
      if (this.mode === "quota") return this.json(res, 401, { detail: { status: "quota_exceeded", message: "This request exceeds your quota" } });
      if (this.mode === "busy-once" && !this.busy) {
        this.busy = true;
        return this.json(res, 429, { detail: { status: "too_many_concurrent_requests", message: "busy" } });
      }
      const { text, model_id } = JSON.parse(body) as { text: string; model_id: string };
      if (tts[2] && model_id === "ohne_zeitstempel") return this.json(res, 400, { detail: { status: "invalid_request", message: "Model does not support timestamps" } });
      const audio = Buffer.from(`MP3:${tts[1]}:${text}`);
      if (!tts[2]) return void res.writeHead(200, { "Content-Type": "audio/mpeg" }).end(audio);
      const chars = [...text];
      return this.json(res, 200, {
        audio_base64: audio.toString("base64"),
        alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.1), character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1) },
      });
    }
    this.json(res, 404, { detail: `unbekannt: ${url.pathname}` });
  }
}

const fake = new FakeElevenLabs();
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
  fake.mode = "ok";
});

describe("ElevenLabs", () => {
  it("Schlüssel liegt verschlüsselt in der Datenbank", async () => {
    const db = testDb();
    expect(await getElevenLabsKey(db)).toBeNull();
    await setElevenLabsKey(db, "  sk_gueltig ");
    expect(hasElevenLabsKey(db)).toBe(true);
    expect(await getElevenLabsKey(db)).toBe("sk_gueltig");
    expect(JSON.stringify(db.select().from(settings).all())).not.toContain("sk_gueltig");
    await setElevenLabsKey(db, "");
    expect(hasElevenLabsKey(db)).toBe(false);
  });

  it("Stimmen über mehrere Seiten, Verbrauch, ungültiger Schlüssel", async () => {
    const voices = await listVoices("sk_gueltig");
    expect(voices.map((v) => v.name)).toEqual(["Anna", "Ben"]);
    expect(voices[0]).toMatchObject({ id: "v-anna", previewUrl: "https://x/anna.mp3", labels: { gender: "female" } });
    expect(fake.log.every((l) => l.key === "sk_gueltig")).toBe(true);
    expect(await getUsage("sk_gueltig")).toMatchObject({ characterCount: 1234, characterLimit: 30000, tier: "creator" });
    await expect(listVoices("sk_falsch")).rejects.toThrow(/Schlüssel ungültig/);
  });

  it("Sprache mit Zeitstempeln je Wort; Kontingent, Wartezeit und Modelle ohne Zeitstempel", async () => {
    const s = await synthesize("sk_gueltig", { voiceId: "v-anna", text: "Hallo Welt", modelId: "eleven_multilingual_v2", speed: 1.5 });
    expect(s.audio.toString()).toBe("MP3:v-anna:Hallo Welt");
    expect(s.words).toEqual([
      { word: "Hallo", start: 0, end: expect.closeTo(0.5) },
      { word: "Welt", start: expect.closeTo(0.6), end: expect.closeTo(1.0) },
    ]);
    expect(s.durationSec).toBeCloseTo(1.0);
    expect(JSON.parse(fake.log.at(-1)!.body)).toMatchObject({ model_id: "eleven_multilingual_v2", voice_settings: { speed: 1.2 } }); // Tempo begrenzt

    fake.mode = "busy-once";
    expect((await synthesize("sk_gueltig", { voiceId: "v-anna", text: "Nochmal", modelId: "m" })).words).toHaveLength(1);

    fake.mode = "quota";
    await expect(synthesize("sk_gueltig", { voiceId: "v-anna", text: "Zu viel", modelId: "m" })).rejects.toThrow(/Kontingent aufgebraucht/);

    fake.mode = "ok";
    const plain = await synthesize("sk_gueltig", { voiceId: "v-ben", text: "Ohne", modelId: "ohne_zeitstempel" });
    expect(plain).toMatchObject({ words: [], durationSec: null });
    expect(plain.audio.toString()).toBe("MP3:v-ben:Ohne");

    await expect(synthesize("sk_gueltig", { voiceId: "v-anna", text: "x".repeat(1001), modelId: "m" })).rejects.toThrow(/1000 Zeichen/);
    expect(wordsFromAlignment({ characters: [" ", "a", " ", " "], character_start_times_seconds: [0, 1, 2, 3], character_end_times_seconds: [1, 2, 3, 4] })).toEqual([{ word: "a", start: 1, end: 2 }]);
  });
});

describe("Studio-Werkzeuge für Stimmen", () => {
  it("ohne Schlüssel: verständlicher Hinweis", async () => {
    const db = testDb();
    const p = testProject(db);
    expect(await voicesTool(db, p)).toMatch(/Einstellungen → Stimmen/);
    await expect(speakTool(db, p, { text: "Hallo", datei: "x" })).rejects.toThrow(/Einstellungen → Stimmen/);
  });

  it("erzeugt MP3 und Zeitstempel im Projekt, mit Haupt-, zweiter oder benannter Stimme", async () => {
    const db = testDb();
    let p = testProject(db);
    await setElevenLabsKey(db, "sk_gueltig");
    await expect(speakTool(db, p, { text: "Hallo", datei: "x" })).rejects.toThrow(/Keine Hauptstimme/);

    p = updateVoices(db, p.id, { main: { id: "v-anna", name: "Anna" }, second: { id: "v-ben", name: "Ben" } });
    updateSettings(db, { voice: { model: "eleven_v3" } });
    const msg = await speakTool(db, p, { text: "Haben Sie morgen Zeit?", datei: "../Termin Böse" });
    expect(msg).toContain('"voice": "stimme/termin-boese.mp3"');
    expect(msg).toMatch(/Dauer: 2,20 s/);
    expect(msg).toContain("aiGenerated");
    const dir = path.join(studioDir(p), "public", "stimme");
    expect(fs.readFileSync(path.join(dir, "termin-boese.mp3"), "utf8")).toBe("MP3:v-anna:Haben Sie morgen Zeit?");
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "termin-boese.json"), "utf8"));
    expect(meta).toMatchObject({ voice: { id: "v-anna" }, model: "eleven_v3", words: expect.arrayContaining([expect.objectContaining({ word: "Haben" })]) });
    expect(fs.existsSync(path.join(p.folder, "studio", "public", "Termin Böse.mp3"))).toBe(false);

    await speakTool(db, p, { text: "Ja.", datei: "antwort", stimme: "zweit" });
    expect(fake.log.at(-1)!.path).toContain("/v1/text-to-speech/v-ben/");
    await speakTool(db, p, { text: "Ja.", datei: "antwort2", stimme: "anna" });
    expect(fake.log.at(-1)!.path).toContain("/v1/text-to-speech/v-anna/");
    await expect(speakTool(db, p, { text: "Ja.", datei: "a", stimme: "Unbekannt" })).rejects.toThrow(/nicht gefunden/);

    const list = await voicesTool(db, p);
    expect(list).toContain("Hauptstimme des Projekts (Erzähler, Assistent): Anna (v-anna)");
    expect(list).toContain("- Ben (v-ben) – Ruhiger Erzähler");
    expect(voiceFileName("")).toMatch(/^stimme-\d+$/);
  });

  it("Stimmen stehen in PROJEKT.md", () => {
    const db = testDb();
    const p = testProject(db);
    updateVoices(db, p.id, { main: { id: "v-anna", name: "Anna" } });
    const md = fs.readFileSync(path.join(p.folder, "PROJEKT.md"), "utf8");
    expect(md).toContain("## Stimmen (ElevenLabs)");
    expect(md).toContain("- Hauptstimme (Erzähler, Assistent): Anna");
    expect(getProject(db, p.id)!.voices.second).toBeUndefined();
  });

  it("Geheimnisse der App und der Nutzer-Umgebung gehen nicht an Claude, Claudes eigene Anmeldung schon", () => {
    const env = childEnv({ PATH: "/bin", NODE_ENV: "test", ELEVENLABS_API_KEY: "x", GITHUB_TOKEN: "y", ANTHROPIC_API_KEY: "a", CLAUDE_CODE_OAUTH_TOKEN: "c" });
    expect(Object.keys(env).sort()).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "NODE_ENV", "PATH"]);
  });
});

/* ---------- Vorlagen-Update ---------- */

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

describe("Vorlagen-Update für bestehende Projekte", () => {
  it("neue Projekte bekommen die aktuelle Fassung samt Prüfsummen", () => {
    const db = testDb();
    const p = testProject(db);
    setupStudio(p);
    const manifest = JSON.parse(fs.readFileSync(path.join(studioDir(p), ".vorlage.json"), "utf8"));
    expect(manifest.version).toBe(TEMPLATE_VERSION);
    expect(fs.readFileSync(path.join(studioDir(p), "src", "Short.tsx"), "utf8")).toContain("VoiceTrack");
    expect(pendingTemplateMerges(p)).toEqual([]);
  });

  it("unveränderte Dateien werden ersetzt, angepasste bekommen eine .neu-Fassung, bis Claude sie übernommen hat", () => {
    const db = testDb();
    const p = testProject(db);
    setupStudio(p);
    const dir = studioDir(p);
    const short = path.join(dir, "src", "Short.tsx");
    const readme = path.join(dir, "README.md");
    // Stand wie bei Version 1: README unverändert, Short.tsx vom Projekt angepasst
    fs.writeFileSync(readme, "alte README");
    fs.writeFileSync(short, "// angepasst vom Projekt");
    fs.writeFileSync(path.join(dir, ".vorlage.json"), JSON.stringify({ version: 1, files: { "README.md": sha("alte README"), "src/Short.tsx": sha("// Original v1") } }));

    const r = upgradeTemplate(dir);
    expect(r).toEqual({ replaced: ["README.md"], pending: ["src/Short.tsx"] });
    expect(fs.readFileSync(readme, "utf8")).toContain("Sprecher (Stimmen)");
    expect(fs.readFileSync(short, "utf8")).toBe("// angepasst vom Projekt");
    expect(fs.readFileSync(`${short}.neu`, "utf8")).toContain("VoiceTrack");
    expect(agentInstructions(getProject(db, p.id)!)).toContain("studio/src/Short.tsx.neu");

    // Nochmal: nichts Neues, Hinweis bleibt
    expect(upgradeTemplate(dir).pending).toEqual(["src/Short.tsx"]);
    // Claude hat übernommen → .neu verschwindet
    fs.writeFileSync(short, "// angepasst + Stimmen");
    expect(upgradeTemplate(dir).pending).toEqual([]);
    expect(fs.existsSync(`${short}.neu`)).toBe(false);
    expect(agentInstructions(getProject(db, p.id)!)).not.toContain("Zuerst: Vorlage aktualisieren");
  });

  it("Projekte ohne Prüfsummen-Datei gelten als Version 1", () => {
    const db = testDb();
    const p = testProject(db);
    setupStudio(p);
    const dir = studioDir(p);
    fs.rmSync(path.join(dir, ".vorlage.json"));
    fs.writeFileSync(path.join(dir, "src", "Short.tsx"), "// eigene Fassung");
    expect(upgradeTemplate(dir).pending).toEqual(["src/Short.tsx"]);
  });
});
