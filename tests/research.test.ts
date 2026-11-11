import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertAccount } from "@/lib/accounts";
import type { DB } from "@/lib/db/client";
import { projectReferences, projects, settings, studioRuns, studioSessions } from "@/lib/db/schema";
import { listLearnings, decideLearning } from "@/lib/learnings";
import { getProject } from "@/lib/projects";
import { adLibraryTokens, exchangeLongLived, searchAds, searchAdsWithAnyToken, setMetaUserToken } from "@/lib/research/meta";
import { listReports, readReport, researchPrompt, runDueResearch, startResearch } from "@/lib/research/run";
import { updateSettings } from "@/lib/settings";
import { higgsfieldFor } from "@/lib/studio/higgsfield";
import { adLibraryTool, framesTool, instagramTool, patternTool, researchSourcesTool, transcriptTool, youtubeTool } from "@/lib/studio/research-tools";
import { setElevenLabsKey } from "@/lib/voice/elevenlabs";
import { testDb, testProject } from "./helpers";

const NOW = new Date("2026-11-11T10:00:00Z");

/* ---------- Nachgebaute Server: Meta Graph, YouTube, ElevenLabs ---------- */

class FakeApis {
  server = http.createServer((req, res) => void this.handle(req, res));
  base = "";
  log: { method: string; path: string; query: URLSearchParams; body: string }[] = [];
  /** Token, die Meta für die Werbebibliothek ablehnt */
  deniedTokens = new Set<string>();
  igNoViews = false;
  ytQuota = false;

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
    const body = Buffer.concat(chunks).toString("latin1");
    const url = new URL(req.url!, this.base);
    const q = url.searchParams;
    this.log.push({ method: req.method!, path: url.pathname, query: q, body });

    /* Meta */
    if (url.pathname === "/v24.0/oauth/access_token") return this.json(res, 200, { access_token: `lang-${q.get("fb_exchange_token")}`, expires_in: 5_184_000 });
    if (url.pathname === "/v24.0/ads_archive") {
      const token = q.get("access_token")!;
      if (this.deniedTokens.has(token)) return this.json(res, 400, { error: { message: "Application does not have permission for this action", code: 10 } });
      if (token === "abgelaufen") return this.json(res, 400, { error: { message: "Session has expired", code: 190 } });
      if (!q.get("after")) {
        return this.json(res, 200, {
          data: [
            {
              id: "111",
              page_id: "900",
              page_name: "Praxis-Assist GmbH",
              ad_delivery_start_time: "2026-11-01",
              ad_creative_bodies: ["Nie wieder verpasste Anrufe in der Praxis."],
              ad_creative_link_titles: ["Jetzt testen"],
              publisher_platforms: ["FACEBOOK", "INSTAGRAM"],
              eu_total_reach: 12000,
              target_ages: ["25", "65+"],
              target_gender: "All",
            },
          ],
          paging: { next: `${this.base}/v24.0/ads_archive?access_token=${token}&after=C1` },
        });
      }
      return this.json(res, 200, {
        data: [
          {
            id: "222",
            page_id: "901",
            page_name: "Telefon-KI AG",
            ad_delivery_start_time: "2026-08-01",
            ad_creative_bodies: ["Ihre Praxis ist voll? Ihr Telefon auch.", "Variante B"],
            publisher_platforms: ["INSTAGRAM"],
            target_locations: [{ name: "Deutschland" }, { name: "Berlin", excluded: true }],
          },
        ],
      });
    }
    const bd = url.pathname.match(/^\/v24\.0\/(ig-\w+)$/);
    if (bd) {
      const fields = q.get("fields") ?? "";
      if (fields.includes("unbekannt")) return this.json(res, 400, { error: { message: "Invalid user id", code: 110 } });
      if (this.igNoViews && fields.includes("view_count")) return this.json(res, 400, { error: { message: "Tried accessing nonexisting field (view_count)", code: 100 } });
      const v = (n: number) => (this.igNoViews ? {} : { view_count: n });
      return this.json(res, 200, {
        business_discovery: {
          username: "konkurrent",
          name: "Konkurrent",
          followers_count: 5400,
          media_count: 120,
          media: {
            data: [
              { id: "m1", caption: "Normaler Post", media_type: "VIDEO", media_product_type: "REELS", timestamp: "2026-11-01T10:00:00+0000", like_count: 50, comments_count: 3, ...v(2000) },
              { id: "m2", caption: "Der Hit: Demo-Anruf um 22 Uhr", media_type: "VIDEO", media_product_type: "REELS", permalink: "https://instagram.com/reel/m2", timestamp: "2026-10-20T10:00:00+0000", like_count: 900, comments_count: 40, ...v(20000) },
              { id: "m3", caption: "Bild", media_type: "IMAGE", timestamp: "2026-10-10T10:00:00+0000", like_count: 40, comments_count: 1, ...v(1500) },
            ],
          },
        },
      });
    }

    /* YouTube */
    if (url.pathname === "/youtube/v3/search") {
      if (this.ytQuota) return this.json(res, 403, { error: { message: "quota", errors: [{ reason: "quotaExceeded" }] } });
      return this.json(res, 200, { items: [{ id: { videoId: "a" } }, { id: { videoId: "b" } }, { id: { videoId: "lang" } }] });
    }
    if (url.pathname === "/youtube/v3/videos") {
      return this.json(res, 200, {
        items: [
          { id: "a", snippet: { title: "Kleiner Short", channelTitle: "Kanal A", publishedAt: "2026-10-01T00:00:00Z" }, contentDetails: { duration: "PT30S" }, statistics: { viewCount: "1000" } },
          { id: "b", snippet: { title: "Großer Short", channelTitle: "Kanal B", publishedAt: "2026-10-02T00:00:00Z" }, contentDetails: { duration: "PT45S" }, statistics: { viewCount: "90000", likeCount: "3000" } },
          { id: "lang", snippet: { title: "Langes Video" }, contentDetails: { duration: "PT12M" }, statistics: { viewCount: "999999" } },
        ],
      });
    }

    /* ElevenLabs: Spracherkennung */
    if (url.pathname === "/v1/speech-to-text") {
      const model = body.match(/name="model_id"\r\n\r\n([\w.-]+)/)?.[1];
      if (model === "scribe_v2") return this.json(res, 422, { detail: { status: "invalid_model", message: "Invalid model_id scribe_v2" } });
      const words = ["Haben", "Sie", "morgen", "Zeit?", "Ja,", "um", "neun."].map((w, i) => ({ text: w, start: i * 0.8, end: i * 0.8 + 0.5, type: "word" }));
      return this.json(res, 200, { language_code: "deu", text: "Haben Sie morgen Zeit? Ja, um neun.", words });
    }
    this.json(res, 404, { error: { message: `unbekannt ${url.pathname}` } });
  }
}

const fake = new FakeApis();
beforeAll(async () => {
  await fake.start();
  Object.assign(process.env, {
    META_GRAPH_BASE: fake.base,
    YOUTUBE_API_BASE: fake.base,
    ELEVENLABS_API_BASE: fake.base,
    META_APP_ID: "app",
    META_APP_SECRET: "geheim",
  });
});
afterAll(() => {
  fake.server.close();
  for (const k of ["META_GRAPH_BASE", "YOUTUBE_API_BASE", "ELEVENLABS_API_BASE", "META_APP_ID", "META_APP_SECRET"]) delete process.env[k];
});
beforeEach(() => {
  fake.log = [];
  fake.deniedTokens = new Set();
  fake.igNoViews = false;
  fake.ytQuota = false;
});

async function withAccounts(db: DB, projectId: number) {
  await upsertAccount(db, { projectId, platform: "instagram", externalId: "ig-mein", name: "Fokuspilot IG", tokens: { accessToken: "seiten-token" } });
  await upsertAccount(db, { projectId, platform: "youtube", externalId: "yt", name: "Fokuspilot YT", tokens: { accessToken: "yt-token", expiresAt: Date.now() + 3600_000 } });
}

/* ---------- Werbebibliothek ---------- */

describe("Meta-Werbebibliothek", () => {
  it("Zugänge: Nutzer-Token verschlüsselt, abgelaufene übersprungen, App-Zugang zuletzt", async () => {
    const db = testDb();
    expect((await adLibraryTokens(db)).map((t) => t.label)).toEqual(["App-Zugang"]);
    await setMetaUserToken(db, "nutzer-token", { source: "instagram", expiresAt: Date.now() + 86_400_000 });
    expect((await adLibraryTokens(db)).map((t) => [t.label, t.token])).toEqual([
      ["Anmeldung von Instagram", "nutzer-token"],
      ["App-Zugang", "app|geheim"],
    ]);
    expect(JSON.stringify(db.select().from(settings).all())).not.toContain("nutzer-token");
    await setMetaUserToken(db, "alt", { expiresAt: Date.now() - 1000 });
    expect((await adLibraryTokens(db)).map((t) => t.label)).toEqual(["App-Zugang"]);
    expect(await exchangeLongLived("kurz")).toMatchObject({ token: "lang-kurz" });
  });

  it("sucht in Deutschland, blättert weiter und gibt Links ohne Token heraus", async () => {
    const ads = await searchAds("tok", { terms: " Telefonassistent ", limit: 10 });
    expect(ads.map((a) => a.id)).toEqual(["111", "222"]);
    const q = fake.log[0].query;
    expect(q.get("ad_reached_countries")).toBe('["DE"]');
    expect(q.get("ad_active_status")).toBe("ACTIVE");
    expect(q.get("search_terms")).toBe("Telefonassistent");
    expect(q.get("fields")).toContain("ad_creative_bodies");
    expect(ads[1]).toMatchObject({ pageName: "Telefon-KI AG", targetLocations: ["Deutschland"], link: "https://www.facebook.com/ads/library/?id=222" });
    await searchAds("tok", { pageIds: ["900", " 901 "], activeOnly: false });
    expect(fake.log.at(-2)!.query.get("search_page_ids")).toBe('["900","901"]');
    expect(fake.log.at(-2)!.query.get("ad_active_status")).toBe("ALL");
    await expect(searchAds("tok", {})).rejects.toThrow(/Suchbegriff/);
  });

  it("probiert den nächsten Zugang, wenn Meta einen ablehnt", async () => {
    const db = testDb();
    await setMetaUserToken(db, "ohne-id-bestaetigung", { source: "manual" });
    fake.deniedTokens.add("ohne-id-bestaetigung");
    expect((await searchAdsWithAnyToken(db, { terms: "x" })).via).toBe("App-Zugang");
    fake.deniedTokens.add("app|geheim");
    await expect(searchAdsWithAnyToken(db, { terms: "x" })).rejects.toThrow(/facebook\.com\/ID/);
  });

  it("Werkzeug: lange laufende Anzeigen zuerst, keine Token im Text", async () => {
    const db = testDb();
    const p = testProject(db);
    await setMetaUserToken(db, "geheimes-nutzer-token", { source: "manual" });
    const text = await adLibraryTool(db, p, { suchbegriff: "Praxis Telefon" }, NOW);
    expect(text.indexOf("- Telefon-KI AG")).toBeLessThan(text.indexOf("- Praxis-Assist GmbH"));
    expect(text).toContain("seit 102 Tagen");
    expect(text).toContain("(2 Textvarianten – wird getestet)");
    expect(text).toContain("Ansehen: https://www.facebook.com/ads/library/?id=111");
    expect(text).not.toContain("geheimes-nutzer-token");
    expect(text).not.toContain("geheim");
  });
});

/* ---------- Instagram und YouTube ---------- */

describe("Konkurrenz auf Instagram und YouTube", () => {
  it("Instagram: Beiträge eines anderen Kontos, sortiert nach Erfolg im Verhältnis zum Konto", async () => {
    const db = testDb();
    const p = testProject(db);
    await expect(instagramTool(db, p, { benutzername: "konkurrent" })).rejects.toThrow(/Instagram-Business-Konto verbunden/);
    await withAccounts(db, p.id);
    const text = await instagramTool(db, p, { benutzername: "@konkurrent" });
    expect(text).toMatch(/^@konkurrent \(Konkurrent\) · 5\.400 Follower/);
    expect(text.indexOf("Der Hit")).toBeLessThan(text.indexOf("Normaler Post"));
    expect(text).toContain("×10,0 des Kontos");
    expect(fake.log.at(-1)!.query.get("access_token")).toBe("seiten-token");
    expect(fake.log.at(-1)!.query.get("fields")).toContain("business_discovery.username(konkurrent)");

    fake.igNoViews = true; // ältere API: ohne view_count
    expect(await instagramTool(db, p, { benutzername: "konkurrent" })).toContain("×18,0 des Kontos");
    await expect(instagramTool(db, p, { benutzername: "unbekannt" })).rejects.toThrow(/nicht gefunden/);
    await expect(instagramTool(db, p, { benutzername: "x y" })).rejects.toThrow(/Ungültiger Instagram-Name/);
  });

  it("YouTube: nur Shorts, nach Views; Kontingent verständlich", async () => {
    const db = testDb();
    const p = testProject(db);
    await withAccounts(db, p.id);
    const text = await youtubeTool(db, p, { suchbegriff: "KI Telefon" });
    expect(text).not.toContain("Langes Video");
    expect(text.indexOf("Großer Short")).toBeLessThan(text.indexOf("Kleiner Short"));
    const search = fake.log.find((l) => l.path === "/youtube/v3/search")!.query;
    expect([search.get("videoDuration"), search.get("regionCode"), search.get("order")]).toEqual(["short", "DE", "viewCount"]);
    fake.ytQuota = true;
    await expect(youtubeTool(db, p, { suchbegriff: "x" })).rejects.toThrow(/Tageskontingent/);
  });
});

/* ---------- Beispiele auswerten ---------- */

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("Beispielvideos auswerten", () => {
  it.skipIf(!hasFfmpeg)("zerlegt Videos aus referenzen/ in Hook-Bilder und eine Übersicht", async () => {
    const db = testDb();
    const p = testProject(db);
    const dir = path.join(p.folder, "referenzen", "inspiration");
    fs.mkdirSync(dir, { recursive: true });
    const video = path.join(dir, "Beispiel Reel.mp4");
    execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=4:size=360x640:rate=10", "-pix_fmt", "yuv420p", video]);
    fs.writeFileSync(path.join(dir, "bild.png"), "PNG");

    const text = await framesTool(p, { datei: "referenzen/inspiration/Beispiel Reel.mp4" });
    expect(text).toMatch(/4,0 s, 360×640/);
    expect(text).toContain("recherche/analyse/beispiel-reel/hook-0_0s.jpg");
    expect(text).toContain("recherche/analyse/beispiel-reel/hook-3_0s.jpg");
    expect(fs.existsSync(path.join(p.folder, "recherche", "analyse", "beispiel-reel", "uebersicht.jpg"))).toBe(true);

    await expect(framesTool(p, { datei: "referenzen/inspiration/bild.png" })).rejects.toThrow(/nur von Videos/);
    await expect(framesTool(p, { datei: "../anderes/video.mp4" })).rejects.toThrow(/Nur Dateien aus/);
  });

  it("schreibt Gesprochenes mit (neueres Modell zuerst, sonst das ältere)", async () => {
    const db = testDb();
    const p = testProject(db);
    const dir = path.join(p.folder, "referenzen", "inspiration");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "anruf.mp3"), "MP3");
    await expect(transcriptTool(db, p, { datei: "referenzen/inspiration/anruf.mp3" })).rejects.toThrow(/ElevenLabs-Schlüssel/);
    await setElevenLabsKey(db, "sk_test");
    const text = await transcriptTool(db, p, { datei: "referenzen/inspiration/anruf.mp3" });
    expect(text).toBe("referenzen/inspiration/anruf.mp3 – Sprache: deu\n0,0 s: Haben Sie morgen Zeit?\n3,2 s: Ja, um neun.");
    const calls = fake.log.filter((l) => l.path === "/v1/speech-to-text");
    expect(calls.map((c) => c.body.match(/name="model_id"\r\n\r\n([\w.-]+)/)?.[1])).toEqual(["scribe_v2", "scribe_v1"]);
  });
});

/* ---------- Muster, Lauf, Berichte ---------- */

describe("Recherche-Lauf und Muster", () => {
  it("Muster gelten erst nach Bestätigung und stehen getrennt von den Erkenntnissen in PROJEKT.md", async () => {
    const db = testDb();
    const p = testProject(db);
    expect(patternTool(db, p, { text: "Demo-Anruf in den ersten 3 Sekunden", begruendung: "2 lange laufende Anzeigen" })).toContain("Vorgeschlagen");
    expect(patternTool(db, p, { text: "demo-anruf in den ersten 3 sekunden", begruendung: "x" })).toMatch(/Gibt es schon/);
    const [l] = listLearnings(db, p.id);
    expect(l.source).toBe("research");
    decideLearning(db, l.id, "accepted");
    const md = fs.readFileSync(path.join(p.folder, "PROJEKT.md"), "utf8");
    expect(md).toContain("## Muster aus Beispielen und Recherche");
    expect(md).toContain("- Demo-Anruf in den ersten 3 Sekunden");
    expect(md).not.toContain("## Erkenntnisse aus den Zahlen");
    expect(await researchSourcesTool(db, getProject(db, p.id)!)).toContain("[bestätigt] Demo-Anruf in den ersten 3 Sekunden");
  });

  it("startet nur mit Quellen, nie doppelt, und automatisch nur im gewählten Rhythmus", () => {
    const db = testDb();
    const p = testProject(db);
    expect(() => startResearch(db, p.id, NOW)).toThrow(/Erst Quellen angeben/);
    expect(runDueResearch(db, NOW).started).toBe(0);

    db.update(projects).set({ research: { keywords: ["KI Telefonassistent"] } }).where(eq(projects.id, p.id)).run();
    expect(runDueResearch(db, NOW).started).toBe(0); // Rhythmus „nie“
    updateSettings(db, { research: { every: "week" } });
    expect(runDueResearch(db, NOW).started).toBe(1);
    const session = db.select().from(studioSessions).get()!;
    expect(session).toMatchObject({ research: true, title: "Recherche · 11.11." });
    expect(db.select().from(studioRuns).get()!.prompt).toContain("recherche/berichte/2026-11-11.md");
    expect(() => startResearch(db, p.id, NOW)).toThrow(/läuft schon/);
    expect(higgsfieldFor(db, session)).toBeNull();

    db.update(studioRuns).set({ state: "done" }).run();
    expect(runDueResearch(db, new Date(NOW.getTime() + 3 * 86_400_000)).started).toBe(0); // noch keine Woche
    expect(runDueResearch(db, new Date(NOW.getTime() + 8 * 86_400_000)).started).toBe(1);
  });

  it("Beispiele unter Referenzen reichen als Quelle; Auftrag nennt Regeln", () => {
    const db = testDb();
    const p = testProject(db);
    db.insert(projectReferences).values({ projectId: p.id, kind: "link", category: "inspiration", title: "Gutes Reel", url: "https://instagram.com/reel/x" }).run();
    const prompt = researchPrompt(db, getProject(db, p.id)!, NOW, "Europe/Berlin");
    expect(prompt).toContain("nie zum Kopieren".replace("nie", "nicht"));
    expect(prompt).toContain("Keine Texte, Slogans, Bilder, Musik oder Figuren anderer übernehmen");
    expect(() => startResearch(db, p.id, NOW)).not.toThrow();
  });

  it("Berichte: nur .md-Dateien aus recherche/berichte, neueste zuerst", () => {
    const db = testDb();
    const p = testProject(db);
    const dir = path.join(p.folder, "recherche", "berichte");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "2026-11-04.md"), "alt");
    fs.writeFileSync(path.join(dir, "2026-11-11.md"), "# Neu");
    fs.writeFileSync(path.join(dir, "notiz.txt"), "x");
    expect(listReports(p)).toEqual(["2026-11-11.md", "2026-11-04.md"]);
    expect(readReport(p, "2026-11-11.md")).toBe("# Neu");
    expect(readReport(p, "../PROJEKT.md")).toBeNull();
  });
});
