import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertAccount } from "@/lib/accounts";
import { analysisPrompt, nextAnalysisAt, runDueAnalyses, startAnalysis } from "@/lib/analysis";
import { instagramInsights } from "@/lib/analytics/instagram";
import { linkedinInsights, simulatorInsights } from "@/lib/analytics/others";
import { bestHours, median, ratedItems, statsText, summarize } from "@/lib/analytics/stats";
import { refreshAccountInsights, refreshDueInsights } from "@/lib/analytics/store";
import { tiktokInsights } from "@/lib/analytics/tiktok";
import type { InsightsFetcher, MediaStat } from "@/lib/analytics/types";
import { isoDuration, youtubeInsights } from "@/lib/analytics/youtube";
import { createAutomation, startAutomationRun } from "@/lib/automation";
import { importBacklog } from "@/lib/backlog";
import type { DB } from "@/lib/db/client";
import { accounts, contents, mediaItems, metricSnapshots, postTargets, projects, studioRuns, studioSessions, type Account } from "@/lib/db/schema";
import { addManualLearning, decideLearning, listLearnings, proposeLearning, removeLearning } from "@/lib/learnings";
import { createPost } from "@/lib/posts";
import { getSettings, updateSettings } from "@/lib/settings";
import { learningsTool, proposeLearningTool, statsTool } from "@/lib/studio/tools";
import { makeShort, testDb, testProject } from "./helpers";

const H = 3600_000;
const D = 24 * H;

/* ---------- Nachgebaute Plattform-APIs ---------- */

class FakeInsights {
  server = http.createServer((req, res) => void this.handle(req, res));
  base = "";
  log: string[] = [];
  igInsightsError: number | null = null;
  ttScopeMissing = false;

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
    const p = url.pathname;
    const q = url.searchParams;
    this.log.push(`${req.method} ${p}${url.search}`);

    /* YouTube Data API */
    if (p === "/youtube/v3/channels") return this.json(res, 200, { items: [{ contentDetails: { relatedPlaylists: { uploads: "UU123" } } }] });
    if (p === "/youtube/v3/playlistItems") {
      if (!q.get("pageToken")) {
        return this.json(res, 200, {
          items: [
            { contentDetails: { videoId: "yt1", videoPublishedAt: "2026-11-05T10:00:00Z" } },
            { contentDetails: { videoId: "yt2", videoPublishedAt: "2026-11-01T10:00:00Z" } },
          ],
          nextPageToken: "P2",
        });
      }
      return this.json(res, 200, {
        items: [
          { contentDetails: { videoId: "yt3", videoPublishedAt: "2026-10-20T10:00:00Z" } },
          { contentDetails: { videoId: "alt", videoPublishedAt: "2026-01-01T10:00:00Z" } },
        ],
        nextPageToken: "P3",
      });
    }
    if (p === "/youtube/v3/videos") {
      const ids = q.get("id")!.split(",");
      return this.json(res, 200, {
        items: ids.map((id, i) => ({
          id,
          snippet: { title: `Video ${id}`, publishedAt: "2026-11-05T10:00:00Z" },
          contentDetails: { duration: id === "yt3" ? "PT4M10S" : "PT35S" },
          statistics: { viewCount: String(1000 * (i + 1)), likeCount: "12", commentCount: "3" },
        })),
      });
    }

    /* Meta Graph API */
    if (p === "/v24.0/ig-1/media") {
      return this.json(res, 200, {
        data: [
          { id: "m1", caption: "Erster Reel\nmit Zeilenumbruch", permalink: "https://instagram.com/reel/m1", timestamp: "2026-11-05T08:00:00+0000", like_count: 40, comments_count: 5 },
          { id: "m2", caption: "Zweiter", timestamp: "2026-11-02T08:00:00+0000", like_count: 10, comments_count: 1 },
          { id: "m-alt", caption: "Alt", timestamp: "2025-01-01T08:00:00+0000", like_count: 1, comments_count: 0 },
        ],
        paging: { cursors: { after: "X" }, next: `${this.base}/next` },
      });
    }
    const ins = p.match(/^\/v24\.0\/(m\d)\/insights$/);
    if (ins) {
      if (this.igInsightsError) return this.json(res, 400, { error: { message: "nope", code: this.igInsightsError } });
      const metric = q.get("metric")!;
      // m2 kennt „views“ nicht (z. B. Bild) → Rückfall auf kleineren Satz
      if (ins[1] === "m2" && metric.includes("views")) return this.json(res, 400, { error: { message: "metric views not supported", code: 100 } });
      return this.json(res, 200, {
        data: metric.split(",").map((name) => ({ name, values: [{ value: name === "views" ? 900 : name === "reach" ? 700 : name === "shares" ? 9 : 4 }] })),
      });
    }

    /* TikTok Display API */
    if (p === "/v2/video/list/") {
      if (this.ttScopeMissing) return this.json(res, 401, { error: { code: "scope_not_authorized", message: "scope" } });
      const { cursor } = JSON.parse(body || "{}");
      const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
      if (!cursor) {
        return this.json(res, 200, {
          data: { videos: [{ id: "tt1", title: "", video_description: "Beschreibung\nzweite Zeile", create_time: sec("2026-11-04T12:00:00Z"), share_url: "https://tiktok.com/@x/video/tt1", duration: 21, view_count: 5000, like_count: 300, comment_count: 20, share_count: 15 }], cursor: 111, has_more: true },
          error: { code: "ok" },
        });
      }
      return this.json(res, 200, {
        data: {
          videos: [
            { id: "tt2", title: "Zweites", create_time: sec("2026-10-30T12:00:00Z"), view_count: 800, like_count: 30, comment_count: 2, share_count: 1 },
            { id: "tt-alt", title: "Alt", create_time: sec("2025-01-01T12:00:00Z"), view_count: 1 },
          ],
          cursor: 222,
          has_more: true,
        },
        error: { code: "ok" },
      });
    }
    this.json(res, 404, { error: { message: `unbekannt: ${p}` } });
  }
}

const fake = new FakeInsights();
const NOW = new Date("2026-11-07T12:00:00Z");
const SINCE = new Date(NOW.getTime() - 90 * D);
const fetchInput = (account: Partial<Account>, warnings: string[] = []) => ({
  db: testDb(),
  account: account as Account,
  token: "tok",
  since: SINCE,
  now: NOW,
  warn: (m: string) => warnings.push(m),
});

beforeAll(async () => {
  await fake.start();
  process.env.YOUTUBE_API_BASE = fake.base;
  process.env.META_GRAPH_BASE = fake.base;
  process.env.TIKTOK_API_BASE = fake.base;
});
afterAll(() => {
  fake.server.close();
  delete process.env.YOUTUBE_API_BASE;
  delete process.env.META_GRAPH_BASE;
  delete process.env.TIKTOK_API_BASE;
});
beforeEach(() => {
  fake.log = [];
  fake.igInsightsError = null;
  fake.ttScopeMissing = false;
});

describe("Zahlen abrufen", () => {
  it("YouTube: Uploads seit dem Stichtag, Shorts-Links, keine Shares", async () => {
    expect(isoDuration("PT1M5S")).toBe(65);
    expect(isoDuration("P1DT1H")).toBe(90000);
    expect(isoDuration("unsinn")).toBeNull();

    const stats = await youtubeInsights.fetch(fetchInput({ platform: "youtube" }));
    expect(stats.map((s) => s.externalId)).toEqual(["yt1", "yt2", "yt3"]); // „alt“ liegt vor dem Stichtag → Abbruch
    expect(stats[0]).toMatchObject({ views: 1000, likes: 12, comments: 3, shares: null, durationSec: 35, url: "https://youtube.com/shorts/yt1" });
    expect(stats[2].url).toBe("https://www.youtube.com/watch?v=yt3");
    expect(fake.log.filter((l) => l.includes("playlistItems"))).toHaveLength(2);
  });

  it("Instagram: Likes/Kommentare plus Insights, Rückfall bei unbekannter Kennzahl", async () => {
    const warnings: string[] = [];
    const stats = await instagramInsights.fetch(fetchInput({ platform: "instagram", externalId: "ig-1" }, warnings));
    expect(stats).toHaveLength(2);
    expect(stats[0]).toMatchObject({ externalId: "m1", title: "Erster Reel", views: 900, reach: 700, shares: 9, saves: 4, likes: 40, comments: 5 });
    expect(stats[1]).toMatchObject({ externalId: "m2", views: null, reach: 700, shares: 9 });
    expect(warnings).toEqual([]);
    expect(fake.log.some((l) => l.includes("after="))).toBe(false); // ältere Beiträge erreicht → keine weitere Seite
  });

  it("Instagram ohne Insights-Berechtigung: Grundzahlen plus Hinweis, nur ein Versuch", async () => {
    fake.igInsightsError = 10;
    const warnings: string[] = [];
    const stats = await instagramInsights.fetch(fetchInput({ platform: "instagram", externalId: "ig-1" }, warnings));
    expect(stats.map((s) => [s.likes, s.views])).toEqual([
      [40, null],
      [10, null],
    ]);
    expect(warnings[0]).toMatch(/instagram_manage_insights/);
    expect(fake.log.filter((l) => l.includes("/insights"))).toHaveLength(1);
  });

  it("TikTok: Seiten mit Cursor, Beschreibung als Titel, fehlende Berechtigung", async () => {
    const stats = await tiktokInsights.fetch(fetchInput({ platform: "tiktok" }));
    expect(stats.map((s) => s.externalId)).toEqual(["tt1", "tt2"]);
    expect(stats[0]).toMatchObject({ title: "Beschreibung", views: 5000, shares: 15, durationSec: 21 });
    expect(fake.log.filter((l) => l.startsWith("POST /v2/video/list/"))).toHaveLength(2);

    fake.ttScopeMissing = true;
    await expect(tiktokInsights.fetch(fetchInput({ platform: "tiktok" }))).rejects.toThrow(/video\.list/);
  });

  it("LinkedIn: ohne Freigabe keine Zahlen – verständlicher Hinweis", async () => {
    await expect(linkedinInsights.fetch(fetchInput({ platform: "linkedin" }))).rejects.toThrow(/r_member_postAnalytics/);
  });
});

/* ---------- Speichern ---------- */

function staticFetcher(platform: Account["platform"], stats: () => MediaStat[]): InsightsFetcher {
  return { platform, needsToken: false, fetch: async () => stats() };
}

async function accountFor(db: DB, projectId: number, platform: Account["platform"] = "youtube", name = "Kanal") {
  return upsertAccount(db, { projectId, platform, externalId: `${platform}-${name}`, name });
}

describe("Zahlen speichern", () => {
  it("aktualisiert Beiträge, schreibt höchstens einen Verlaufspunkt pro Stunde und erkennt eigene Posts", async () => {
    const db = testDb();
    const p = testProject(db);
    const acc = await accountFor(db, p.id);
    makeShort(p.folder, "2026-11-01-demo");
    await importBacklog(db, p);
    const content = db.select().from(contents).get()!;
    const postId = createPost(db, { contentId: content.id, scheduledAt: new Date(Date.now() + 60_000), accountIds: [acc.id], approve: true });
    db.update(postTargets).set({ state: "published", externalId: "vid-1", publishedAt: new Date() }).where(eq(postTargets.postId, postId)).run();

    let views = 100;
    const fetchers = {
      youtube: staticFetcher("youtube", () => [
        { externalId: "vid-1", title: "Eigener Short", publishedAt: new Date(NOW.getTime() - 3 * D), views, likes: 5, comments: 1, shares: null },
        { externalId: "fremd", title: "Von Hand hochgeladen", publishedAt: new Date(NOW.getTime() - 5 * D), views: 50, likes: 1, comments: 0, shares: null },
      ]),
    };
    const r1 = await refreshAccountInsights(db, acc, { now: NOW, fetchers });
    expect(r1).toMatchObject({ items: 2, warnings: [] });
    views = 150;
    await refreshAccountInsights(db, acc, { now: new Date(NOW.getTime() + 10 * 60_000), fetchers }); // gleiche Stunde
    views = 220;
    await refreshAccountInsights(db, acc, { now: new Date(NOW.getTime() + 2 * H), fetchers });

    const items = db.select().from(mediaItems).all();
    expect(items).toHaveLength(2);
    const own = items.find((i) => i.externalId === "vid-1")!;
    expect(own.views).toBe(220);
    expect(own.targetId).not.toBeNull();
    expect(items.find((i) => i.externalId === "fremd")!.targetId).toBeNull();
    const snaps = db.select().from(metricSnapshots).where(eq(metricSnapshots.mediaId, own.id)).all();
    expect(snaps.map((s) => s.views)).toEqual([150, 220]);
    expect(ratedItems(db, { projectId: p.id, now: NOW }).find((i) => i.externalId === "vid-1")!.contentSlug).toBe("2026-11-01-demo");
  });

  it("Fehler landen am Konto, werden nicht minütlich wiederholt und verschwinden beim nächsten Erfolg", async () => {
    const db = testDb();
    const p = testProject(db);
    const acc = await accountFor(db, p.id);
    let fail = true;
    const fetchers = {
      youtube: {
        platform: "youtube" as const,
        needsToken: false,
        fetch: async () => {
          if (fail) throw new Error("Quota überschritten");
          return [];
        },
      },
    };
    const r = await refreshAccountInsights(db, acc, { now: NOW, fetchers });
    expect(r.error).toMatch(/Quota/);
    let row = db.select().from(accounts).where(eq(accounts.id, acc.id)).get()!;
    expect(row.insightsError).toMatch(/Quota/);
    expect(row.insightsAt?.getTime()).toBe(NOW.getTime());

    fail = false;
    await refreshAccountInsights(db, row, { now: new Date(NOW.getTime() + H), fetchers });
    row = db.select().from(accounts).where(eq(accounts.id, acc.id)).get()!;
    expect(row.insightsError).toBeNull();
  });

  it("refreshDueInsights hält das Intervall ein; „Jetzt aktualisieren“ erzwingt den Abruf", async () => {
    const db = testDb();
    const p = testProject(db);
    const acc = await accountFor(db, p.id, "simulator", "Test");
    expect(await refreshDueInsights(db, NOW)).toHaveLength(1);
    expect(await refreshDueInsights(db, new Date(NOW.getTime() + H))).toHaveLength(0);
    expect(await refreshDueInsights(db, new Date(NOW.getTime() + H), { force: true })).toHaveLength(1);
    expect(await refreshDueInsights(db, new Date(NOW.getTime() + 7 * H))).toHaveLength(1); // Standard: alle 6 Stunden
    expect(await refreshDueInsights(db, new Date(NOW.getTime() + 8 * H), { force: true, projectId: p.id + 1 })).toHaveLength(0);
    expect(acc.platform).toBe("simulator");
  });

  it("Test-Kanal liefert Zahlen zu veröffentlichten Posts, die mit der Zeit wachsen", async () => {
    const db = testDb();
    const p = testProject(db);
    const acc = await accountFor(db, p.id, "simulator", "Test");
    makeShort(p.folder, "2026-11-01-sim");
    await importBacklog(db, p);
    const content = db.select().from(contents).get()!;
    const postId = createPost(db, { contentId: content.id, scheduledAt: new Date(Date.now() + 60_000), accountIds: [acc.id], approve: true });
    db.update(postTargets).set({ state: "published", externalId: "sim-1", publishedAt: new Date(NOW.getTime() - 2 * H) }).where(eq(postTargets.postId, postId)).run();

    const early = await simulatorInsights.fetch({ db, account: acc, token: "", since: SINCE, now: NOW, warn: () => {} });
    const later = await simulatorInsights.fetch({ db, account: acc, token: "", since: SINCE, now: new Date(NOW.getTime() + 5 * D), warn: () => {} });
    expect(early).toHaveLength(1);
    expect(early[0].externalId).toBe("sim-1");
    expect(later[0].views!).toBeGreaterThan(early[0].views!);
    // gleiche ID → gleiche Zahlen
    const again = await simulatorInsights.fetch({ db, account: acc, token: "", since: SINCE, now: NOW, warn: () => {} });
    expect(again[0].views).toBe(early[0].views);
  });
});

/* ---------- Bewertung ---------- */

function seedItems(db: DB, accountId: number, list: { id: string; views: number | null; ageH: number; likes?: number }[]) {
  for (const it of list) {
    db.insert(mediaItems)
      .values({
        accountId,
        externalId: it.id,
        title: `Beitrag ${it.id}`,
        publishedAt: new Date(NOW.getTime() - it.ageH * H),
        views: it.views,
        likes: it.likes ?? 0,
        comments: 0,
        shares: 0,
        fetchedAt: NOW,
      })
      .run();
  }
}

describe("Bewertung gegen den Median des Kanals", () => {
  it("Median", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("stark, normal, schwach, zu frisch – jeder Kanal für sich", async () => {
    const db = testDb();
    const p = testProject(db);
    const yt = await accountFor(db, p.id, "youtube");
    const tt = await accountFor(db, p.id, "tiktok");
    const ig = await accountFor(db, p.id, "instagram");
    seedItems(db, yt.id, [
      { id: "a", views: 100, ageH: 100 },
      { id: "b", views: 100, ageH: 120 },
      { id: "c", views: 160, ageH: 140, likes: 16 },
      { id: "d", views: 40, ageH: 160 },
      { id: "e", views: 90, ageH: 180 },
      { id: "neu", views: 5000, ageH: 10 }, // zählt nicht zum Median
      { id: "uralt", views: 99999, ageH: 100 * 24 }, // älter als 90 Tage
    ]);
    // Anderer Kanal mit ganz anderen Größenordnungen
    seedItems(db, tt.id, [
      { id: "t1", views: 10000, ageH: 72 },
      { id: "t2", views: 10000, ageH: 96 },
      { id: "t3", views: 30000, ageH: 120 },
    ]);
    seedItems(db, ig.id, [{ id: "i1", views: 300, ageH: 80 }]); // zu wenig für einen Median

    const items = ratedItems(db, { projectId: p.id, now: NOW });
    const by = (id: string) => items.find((i) => i.externalId === id)!;
    expect(by("a").channelMedian).toBe(100);
    expect(by("c")).toMatchObject({ rating: "stark", ratio: 1.6, engagement: 0.1 });
    expect(by("d").rating).toBe("schwach");
    expect(by("e").rating).toBe("normal");
    expect(by("neu").rating).toBe("frisch");
    expect(by("t3")).toMatchObject({ rating: "stark", ratio: 3 });
    expect(by("t1").rating).toBe("normal");
    expect(by("i1").rating).toBe("ohne");
    expect(items.find((i) => i.externalId === "uralt")).toBeUndefined();
    expect(items[0].externalId).toBe("neu"); // neueste zuerst

    const week = ratedItems(db, { projectId: p.id, days: 7, now: NOW });
    expect(week.map((i) => i.externalId).sort()).toEqual(["a", "b", "c", "d", "i1", "neu", "t1", "t2", "t3"]); // e ist 7,5 Tage alt
    const s = summarize(week);
    expect(s.posts).toBe(9);
    expect(s.byPlatform[0].platform).toBe("tiktok");

    expect(ratedItems(db, { projectId: p.id + 1, now: NOW })).toEqual([]);
  });

  it("beste Uhrzeiten und Text für Claude", async () => {
    const db = testDb();
    const p = testProject(db);
    const yt = await accountFor(db, p.id, "youtube");
    // NOW = 12:00 UTC = 13:00 Berlin. ageH so wählen, dass zwei Beiträge um 13 Uhr und zwei um 9 Uhr liegen.
    seedItems(db, yt.id, [
      { id: "m1", views: 300, ageH: 72 },
      { id: "m2", views: 250, ageH: 96 },
      { id: "f1", views: 50, ageH: 76 },
      { id: "f2", views: 60, ageH: 100 },
      { id: "x", views: 100, ageH: 50 },
    ]);
    const tz = getSettings(db).timezone;
    const hours = bestHours(ratedItems(db, { projectId: p.id, now: NOW }), tz);
    expect(hours[0]).toMatchObject({ hour: 13, posts: 2 });
    expect(hours[1]).toMatchObject({ hour: 9, posts: 2 });

    const text = statsText(db, p.id, 30, tz, NOW);
    expect(text).toContain("5 Beiträge");
    expect(text).toMatch(/stark ×3,0/);
    expect(text).toContain("Beste Uhrzeiten: 13:00");
    expect(statsText(db, p.id + 99, 30, tz, NOW)).toMatch(/Keine Zahlen/);
  });
});

/* ---------- Erkenntnisse ---------- */

describe("Erkenntnisse", () => {
  it("Vorschläge gelten erst nach Bestätigung und landen dann in PROJEKT.md", () => {
    const db = testDb();
    const p = testProject(db);
    const brief = () => fs.readFileSync(path.join(p.folder, "PROJEKT.md"), "utf8");

    const l = proposeLearning(db, p.id, "  Hook als Frage   in den ersten 2 Sekunden ", "3 von 4 starken Posts")!;
    expect(l).toMatchObject({ text: "Hook als Frage in den ersten 2 Sekunden", status: "proposed", reason: "3 von 4 starken Posts" });
    expect(proposeLearning(db, p.id, "hook als frage in den ersten 2 sekunden")).toBeNull(); // doppelt
    expect(() => proposeLearning(db, p.id, "kurz")).toThrow(/zu kurz/);
    expect(brief()).not.toContain("Erkenntnisse aus den Zahlen");

    decideLearning(db, l.id, "accepted", "Hook als Frage in den ersten 2 Sekunden stellen");
    expect(brief()).toContain("## Erkenntnisse aus den Zahlen");
    expect(brief()).toContain("- Hook als Frage in den ersten 2 Sekunden stellen");

    const r = proposeLearning(db, p.id, "Videos länger als 45 Sekunden machen")!;
    decideLearning(db, r.id, "rejected");
    expect(brief()).not.toContain("länger als 45");
    expect(proposeLearningTool(db, p, { text: "Videos länger als 45 Sekunden machen", begruendung: "x" })).toMatch(/abgelehnt/);

    const m = addManualLearning(db, p.id, "Untertitel immer groß und mittig");
    expect(m.status).toBe("accepted");
    expect(brief()).toContain("- Untertitel immer groß und mittig");

    removeLearning(db, m.id);
    expect(brief()).not.toContain("Untertitel");
    expect(listLearnings(db, p.id).map((x) => x.status)).toEqual(["accepted", "rejected"]);

    const overview = learningsTool(db, p);
    expect(overview).toContain("Bestätigt");
    expect(overview).toContain("Abgelehnt");
    expect(proposeLearningTool(db, p, { text: "Am Ende immer eine Frage an die Zuschauer stellen", begruendung: "Kommentare ×2" })).toMatch(/erst, wenn/);
    expect(learningsTool(db, p)).toContain("Vorgeschlagen");
  });

  it("bestätigte Erkenntnisse stehen im Auftrag jeder Automation", () => {
    const db = testDb();
    const p = testProject(db);
    const auto = createAutomation(db, p.id, { name: "Tipps", recipe: "Ein Tipp pro Short", time: "06:00", weekdays: [1], shortsPerRun: 1, autoSchedule: false });
    addManualLearning(db, p.id, "Erste Szene ohne Logo");
    const { run } = startAutomationRun(db, auto, NOW);
    expect(run.prompt).toContain("# Erkenntnisse aus den Zahlen");
    expect(run.prompt).toContain("- Erste Szene ohne Logo");
  });

  it("Werkzeug „statistik“ nutzt die Zeitzone aus den Einstellungen", async () => {
    const db = testDb();
    const p = testProject(db);
    const yt = await accountFor(db, p.id, "youtube");
    seedItems(db, yt.id, [{ id: "z", views: 10, ageH: 1 }]);
    expect(statsTool(db, p, 7)).toContain("zu frisch");
  });
});

/* ---------- Wochenanalyse ---------- */

describe("Wochenanalyse", () => {
  it("nächster Termin: Wochentag und Uhrzeit in der eingestellten Zeitzone", () => {
    // Sa, 07.11.2026 13:00 Berlin → Mo, 09.11. 07:30 Berlin = 06:30 UTC
    expect(nextAnalysisAt(NOW, 1, "07:30", "Europe/Berlin").toISOString()).toBe("2026-11-09T06:30:00.000Z");
    // gleicher Tag, aber Uhrzeit vorbei → eine Woche später
    expect(nextAnalysisAt(NOW, 6, "09:00", "Europe/Berlin").toISOString()).toBe("2026-11-14T08:00:00.000Z");
    expect(nextAnalysisAt(NOW, 6, "18:00", "Europe/Berlin").toISOString()).toBe("2026-11-07T17:00:00.000Z");
  });

  it("startet einmal pro Woche, nur mit genug Zahlen, holt höchstens einen Tag nach", async () => {
    const db = testDb();
    const p = testProject(db);
    updateSettings(db, { analytics: { ...getSettings(db).analytics, weekday: 1, time: "07:30" } });
    const mon = new Date("2026-11-09T06:35:00Z"); // Mo 07:35 Berlin

    expect(runDueAnalyses(db, mon).started).toBe(0); // noch keine Zahlen
    expect(() => startAnalysis(db, p.id, mon)).toThrow(/zu wenig Zahlen/);

    const yt = await accountFor(db, p.id, "youtube");
    seedItems(db, yt.id, [
      { id: "1", views: 10, ageH: 60 },
      { id: "2", views: 20, ageH: 70 },
      { id: "3", views: 30, ageH: 80 },
    ]);
    expect(runDueAnalyses(db, mon).started).toBe(1);
    const session = db.select().from(studioSessions).get()!;
    expect(session).toMatchObject({ analysis: true, title: "Wochenanalyse · 09.11." });
    const run = db.select().from(studioRuns).get()!;
    expect(run.prompt).toContain("erkenntnis_vorschlagen");
    expect(run.prompt).toContain("Nichts rendern, nichts einplanen");

    expect(runDueAnalyses(db, new Date(mon.getTime() + H)).started).toBe(0); // diese Woche erledigt
    expect(() => startAnalysis(db, p.id, mon)).toThrow(/läuft schon/);
    db.update(studioRuns).set({ state: "done" }).run();

    // Nächste Woche: Rechner war bis Dienstagabend aus → verpasst, nicht nachholen
    const tueEvening = new Date("2026-11-17T19:00:00Z");
    expect(runDueAnalyses(db, tueEvening).started).toBe(0);
    expect(db.select().from(projects).where(eq(projects.id, p.id)).get()!.analysisAt?.getTime()).toBe(tueEvening.getTime());
    // Übernächste Woche, Montag 10 Uhr → innerhalb eines Tages, wird nachgeholt
    expect(runDueAnalyses(db, new Date("2026-11-23T09:00:00Z")).started).toBe(1);

    updateSettings(db, { analytics: { ...getSettings(db).analytics, weekly: false } });
    db.update(studioRuns).set({ state: "done" }).run();
    expect(runDueAnalyses(db, new Date("2026-11-30T06:35:00Z")).started).toBe(0);
  });

  it("Auftrag nennt bestätigte und abgelehnte Erkenntnisse, damit Claude sie nicht wiederholt", () => {
    const db = testDb();
    const p = testProject(db);
    addManualLearning(db, p.id, "Untertitel groß");
    const r = proposeLearning(db, p.id, "Mehr Emojis im Hook")!;
    decideLearning(db, r.id, "rejected");
    const prompt = analysisPrompt(db, p, NOW, "Europe/Berlin");
    expect(prompt).toContain("Samstag, 7. November 2026");
    expect(prompt).toContain("Schon bestätigt (1): „Untertitel groß“");
    expect(prompt).toContain("Schon abgelehnt (1): „Mehr Emojis im Hook“");
  });
});
