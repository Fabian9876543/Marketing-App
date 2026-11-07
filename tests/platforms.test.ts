import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertAccount } from "@/lib/accounts";
import { importBacklog } from "@/lib/backlog";
import { contents, type Content, type Platform, type UploadSession } from "@/lib/db/schema";
import { captionFor } from "@/lib/publishing/captions";
import { instagramOAuth } from "@/lib/publishing/instagram/oauth";
import { createInstagramPublisher } from "@/lib/publishing/instagram/publisher";
import { toLittleText } from "@/lib/publishing/linkedin/api";
import { linkedinOAuth } from "@/lib/publishing/linkedin/oauth";
import { createLinkedInPublisher } from "@/lib/publishing/linkedin/publisher";
import { pkcePair } from "@/lib/publishing/pkce";
import { chunkPlan, toTikTokError } from "@/lib/publishing/tiktok/api";
import { tiktokOAuth } from "@/lib/publishing/tiktok/oauth";
import { createTikTokPublisher } from "@/lib/publishing/tiktok/publisher";
import type { PublishInput } from "@/lib/publishing/types";
import { getSettings, updateSettings, type AppSettings } from "@/lib/settings";
import { makeShort, tempDir, testDb, testProject } from "./helpers";

const MiB = 1024 * 1024;

/** Ein Server, der die benötigten Endpunkte von Meta, TikTok und LinkedIn nachbildet. */
class FakePlatforms {
  server = http.createServer((req, res) => void this.handle(req, res));
  base = "";
  log: { method: string; path: string; headers: http.IncomingHttpHeaders; body: Buffer }[] = [];
  igStatus: string[] = [];
  igQuotaUsage = 0;
  igUploaded = Buffer.alloc(0);
  ttStatus: string[] = [];
  ttPrivacy = ["SELF_ONLY", "PUBLIC_TO_EVERYONE"];
  ttReceived: { range: string; bytes: number }[] = [];
  ttError: string | null = null;
  liStatus: string[] = [];
  liParts: Buffer[] = [];

  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  reset() {
    Object.assign(this, {
      log: [], igStatus: [], igQuotaUsage: 0, igUploaded: Buffer.alloc(0),
      ttStatus: [], ttPrivacy: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"], ttReceived: [], ttError: null,
      liStatus: [], liParts: [],
    });
  }
  calls(fragment: string) {
    return this.log.filter((l) => l.path.includes(fragment));
  }
  private json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, this.base);
    const p = url.pathname;
    this.log.push({ method: req.method!, path: `${p}${url.search}`, headers: req.headers, body });
    const form = () => new URLSearchParams(body.toString());
    const json = () => JSON.parse(body.toString() || "{}");

    /* ---------- Meta ---------- */
    if (p === "/v24.0/oauth/access_token") {
      if (url.searchParams.get("grant_type") === "fb_exchange_token") return this.json(res, 200, { access_token: "user-long" });
      return this.json(res, 200, { access_token: "user-short" });
    }
    if (p === "/v24.0/me/accounts") {
      return this.json(res, 200, {
        data: [
          { id: "page1", name: "Fokuspilot", access_token: "page-token-1", instagram_business_account: { id: "ig1", username: "fokuspilot", name: "Fokuspilot" } },
          { id: "page2", name: "Ohne Instagram", access_token: "page-token-2" },
        ],
      });
    }
    if (p === "/v24.0/debug_token") return this.json(res, 200, { data: { data_access_expires_at: 1900000000 } });
    if (p === "/v24.0/ig1/content_publishing_limit") return this.json(res, 200, { data: [{ quota_usage: this.igQuotaUsage, config: { quota_total: 100 } }] });
    if (p === "/v24.0/ig1/media" && req.method === "POST") {
      return this.json(res, 200, { id: "cont1", uri: `${this.base}/ig-api-upload/v24.0/cont1` });
    }
    if (p === "/ig-api-upload/v24.0/cont1") {
      if (req.headers.authorization !== "OAuth page-token-1") return this.json(res, 400, { success: false });
      this.igUploaded = body;
      return this.json(res, 200, { success: true });
    }
    if (p === "/v24.0/cont1") return this.json(res, 200, { status_code: this.igStatus.shift() ?? "FINISHED" });
    if (p === "/v24.0/ig1/media_publish") return this.json(res, 200, { id: "media1" });
    if (p === "/v24.0/media1") return this.json(res, 200, { permalink: "https://www.instagram.com/reel/abc/" });

    /* ---------- TikTok ---------- */
    const ok = { code: "ok", message: "" };
    if (p === "/v2/oauth/token/") {
      return this.json(res, 200, { access_token: "tt-access", expires_in: 86400, open_id: "open-1", refresh_token: "tt-refresh", refresh_expires_in: 31536000, scope: "video.upload" });
    }
    if (p === "/v2/user/info/") return this.json(res, 200, { data: { user: { open_id: "open-1", display_name: "Fokuspilot TT" } }, error: ok });
    if (this.ttError && p.startsWith("/v2/post/")) return this.json(res, 400, { error: { code: this.ttError, message: "nope" } });
    if (p === "/v2/post/publish/inbox/video/init/" || p === "/v2/post/publish/video/init/") {
      return this.json(res, 200, { data: { publish_id: "pub-1", upload_url: `${this.base}/tt-upload/pub-1` }, error: ok });
    }
    if (p === "/v2/post/publish/creator_info/query/") {
      return this.json(res, 200, { data: { creator_nickname: "fokus", privacy_level_options: this.ttPrivacy, max_video_post_duration_sec: 600 }, error: ok });
    }
    if (p === "/tt-upload/pub-1") {
      this.ttReceived.push({ range: String(req.headers["content-range"]), bytes: body.length });
      const total = Number(String(req.headers["content-range"]).split("/")[1]);
      const sent = this.ttReceived.reduce((s, r) => s + r.bytes, 0);
      res.writeHead(sent >= total ? 201 : 206).end();
      return;
    }
    if (p === "/v2/post/publish/status/fetch/") {
      return this.json(res, 200, { data: { status: this.ttStatus.shift() ?? "SEND_TO_USER_INBOX", publicaly_available_post_id: [7300000000001] }, error: ok });
    }

    /* ---------- LinkedIn ---------- */
    if (p === "/oauth/v2/accessToken") return this.json(res, 200, { access_token: "li-access", expires_in: 5184000, scope: "openid profile w_member_social" });
    if (p === "/v2/userinfo") return this.json(res, 200, { sub: "abc123", name: "Fabian Muster" });
    if (p.startsWith("/rest/") && !req.headers["linkedin-version"]) return this.json(res, 400, { message: "LinkedIn-Version fehlt" });
    if (p === "/rest/videos" && url.searchParams.get("action") === "initializeUpload") {
      const size = json().initializeUploadRequest.fileSizeBytes as number;
      const half = Math.floor(size / 2);
      return this.json(res, 200, {
        value: {
          video: "urn:li:video:V1",
          uploadToken: "",
          uploadInstructions: [
            { uploadUrl: `${this.base}/li-upload/1`, firstByte: 0, lastByte: half - 1 },
            { uploadUrl: `${this.base}/li-upload/2`, firstByte: half, lastByte: size - 1 },
          ],
        },
      });
    }
    if (p.startsWith("/li-upload/")) {
      this.liParts.push(body);
      res.writeHead(200, { ETag: `etag-${p.split("/").pop()}` }).end();
      return;
    }
    if (p === "/rest/videos" && url.searchParams.get("action") === "finalizeUpload") return this.json(res, 200, {});
    if (p === "/rest/videos/urn%3Ali%3Avideo%3AV1" || p === "/rest/videos/urn:li:video:V1") {
      return this.json(res, 200, { status: this.liStatus.shift() ?? "AVAILABLE" });
    }
    if (p === "/rest/posts") {
      res.writeHead(201, { "x-restli-id": "urn:li:share:123" }).end();
      return;
    }
    this.json(res, 404, { error: { message: `unbekannt ${req.method} ${p}` } });
  }
}

const fake = new FakePlatforms();

beforeAll(async () => {
  await fake.start();
  Object.assign(process.env, {
    META_APP_ID: "meta-app",
    META_APP_SECRET: "meta-secret",
    META_GRAPH_BASE: fake.base,
    META_RUPLOAD_BASE: fake.base,
    TIKTOK_CLIENT_KEY: "tt-key",
    TIKTOK_CLIENT_SECRET: "tt-secret",
    TIKTOK_API_BASE: fake.base,
    LINKEDIN_CLIENT_ID: "li-id",
    LINKEDIN_CLIENT_SECRET: "li-secret",
    LINKEDIN_AUTH_BASE: `${fake.base}/oauth/v2`,
    LINKEDIN_API_BASE: fake.base,
  });
});
afterAll(() => fake.server.close());
beforeEach(() => fake.reset());

async function setup(platform: Platform, opts: { bytes?: number; meta?: object; externalId?: string; settings?: Partial<AppSettings> } = {}) {
  const db = testDb();
  if (opts.settings) updateSettings(db, opts.settings);
  const project = testProject(db);
    const dir = project.folder;
  const folder = makeShort(dir, "demo", {
    bytes: opts.bytes ?? 2048,
    meta: opts.meta ?? { title: "Anruf um 22 Uhr", description: "Die Praxis ist zu (aber nicht der Assistent).", hashtags: ["KI", "Praxis"], aiGenerated: true },
  });
  await importBacklog(db, project);
  const content = db.select().from(contents).get()!;
  const account = await upsertAccount(db, { projectId: project.id, platform, externalId: opts.externalId ?? "ig1", name: "Fokuspilot" });
  let session: UploadSession | null = null;
  const input = (): PublishInput => ({
    target: { id: 1, uploadSession: session } as PublishInput["target"],
    post: {} as PublishInput["post"],
    content,
    account,
    settings: getSettings(db),
    accessToken: async () => (platform === "instagram" ? "page-token-1" : "token"),
    saveSession: (s) => (session = s),
    log: () => {},
    now: new Date(),
  });
  return { db, content, input, file: path.join(folder, "video.mp4"), session: () => session };
}

describe("Texte je Plattform", () => {
  const base = { title: "T", description: "Beschreibung", hashtags: ["#KI"], aiGenerated: true, platformTexts: {} } as unknown as Content;

  it("hängt den KI-Hinweis an, wo es keine API-Kennzeichnung gibt", async () => {
    const db = testDb();
    const s = getSettings(db);
    expect(captionFor("instagram", base, s)).toBe("Beschreibung\n\nMit KI erstellt.\n\n#KI");
    expect(captionFor("linkedin", base, s)).toContain("Mit KI erstellt.");
    expect(captionFor("tiktok", base, s)).toContain("Mit KI erstellt."); // Entwurfsmodus
    const direct = updateSettings(db, { tiktok: { mode: "direct_private" } });
    expect(captionFor("tiktok", base, direct)).not.toContain("Mit KI erstellt."); // dort per is_aigc
  });

  it("eigene Texte aus meta.json haben Vorrang, Limits werden eingehalten", () => {
    const s = getSettings(testDb());
    const own = { ...base, aiGenerated: false, platformTexts: { linkedin: { text: "Eigener LinkedIn-Text" } } } as Content;
    expect(captionFor("linkedin", own, s)).toBe("Eigener LinkedIn-Text");
    const many = { ...base, aiGenerated: false, hashtags: Array.from({ length: 40 }, (_, i) => `#t${i}`) } as Content;
    expect(captionFor("instagram", many, s).match(/#t\d+/g)).toHaveLength(30);
    const long = { ...base, aiGenerated: false, hashtags: [], description: "x".repeat(5000) } as Content;
    expect([...captionFor("instagram", long, s)]).toHaveLength(2200);
  });

  it("LinkedIn Little Text: schützt Sonderzeichen, Hashtags bleiben klickbar", () => {
    expect(toLittleText("Praxis zu (22 Uhr) – @Max fragt *wer* geht ran? #KI #Praxis_Tipp")).toBe(
      "Praxis zu \\(22 Uhr\\) – \\@Max fragt \\*wer\\* geht ran? {hashtag|\\#|KI} {hashtag|\\#|Praxis\\_Tipp}",
    );
    expect(toLittleText("Größe {a|b} [c] <d> ~e~ \\")).toBe("Größe \\{a\\|b\\} \\[c\\] \\<d\\> \\~e\\~ \\\\");
  });
});

describe("Instagram", () => {
  it("verbindet alle Instagram-Konten der Facebook-Seiten mit Seiten-Token", async () => {
    const url = new URL(instagramOAuth.authUrl({ state: "s", codeChallenge: null, settings: getSettings(testDb()) }));
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:4321/api/oauth/instagram/callback");
    expect(url.searchParams.get("scope")).toContain("instagram_content_publish");

    const found = await instagramOAuth.connect({ code: "c", codeVerifier: "v", settings: getSettings(testDb()) });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ externalId: "ig1", handle: "@fokuspilot", tokens: { accessToken: "page-token-1" } });
    expect(found[0].reconnectBy?.getTime()).toBe(1900000000 * 1000);
  });

  it("mit Facebook Login for Business wird config_id statt scope gesendet", () => {
    process.env.META_CONFIG_ID = "cfg-1";
    const url = new URL(instagramOAuth.authUrl({ state: "s", codeChallenge: null, settings: getSettings(testDb()) }));
    delete process.env.META_CONFIG_ID;
    expect(url.searchParams.get("config_id")).toBe("cfg-1");
    expect(url.searchParams.get("scope")).toBeNull();
  });

  it("lädt den Reel hoch, wartet auf die Verarbeitung und veröffentlicht", async () => {
    const { input, file } = await setup("instagram");
    fake.igStatus = ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"];
    const out = await createInstagramPublisher({ pollMs: 5, waitMs: 5000 }).publish(input(), {});
    expect(out).toEqual({ state: "published", externalId: "media1", externalUrl: "https://www.instagram.com/reel/abc/" });
    expect(fake.igUploaded.equals(fs.readFileSync(file))).toBe(true);
    const create = new URLSearchParams(fake.calls("/ig1/media")[0].body.toString());
    expect(create.get("media_type")).toBe("REELS");
    expect(create.get("upload_type")).toBe("resumable");
    expect(create.get("caption")).toContain("Mit KI erstellt.");
    const up = fake.calls("/ig-api-upload/")[0];
    expect(up.headers.offset).toBe("0");
    expect(up.headers.file_size).toBe(String(fs.statSync(file).size));
  });

  it("verarbeitet Instagram noch: kein erneuter Upload beim nächsten Versuch", async () => {
    const { input, session } = await setup("instagram");
    fake.igStatus = ["IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS"];
    const pub = createInstagramPublisher({ pollMs: 5, waitMs: 15 });
    await expect(pub.publish(input(), {})).rejects.toMatchObject({ kind: "processing" });
    expect(session()?.remoteId).toBe("cont1");
    fake.igStatus = ["FINISHED"];
    const out = await pub.publish(input(), {});
    expect(out.externalId).toBe("media1");
    expect(fake.calls("/ig-api-upload/")).toHaveLength(1);
  });

  it("Tageslimit erreicht: Fehlerart quota, nichts hochgeladen", async () => {
    const { input } = await setup("instagram");
    fake.igQuotaUsage = 100;
    await expect(createInstagramPublisher({ pollMs: 5 }).publish(input(), {})).rejects.toMatchObject({ kind: "quota" });
    expect(fake.calls("/ig1/media")).toHaveLength(0);
  });
});

describe("TikTok", () => {
  it("Teile nach TikToks Regeln", () => {
    expect(chunkPlan(3 * MiB)).toMatchObject({ chunkSize: 3 * MiB, count: 1 });
    expect(chunkPlan(7 * MiB)).toMatchObject({ chunkSize: 7 * MiB, count: 1 });
    const p = chunkPlan(25 * MiB);
    expect(p).toMatchObject({ chunkSize: 10 * MiB, count: 2 });
    expect(p.ranges).toEqual([
      [0, 10 * MiB - 1],
      [10 * MiB, 25 * MiB - 1],
    ]);
    expect(chunkPlan(100 * MiB + 5).count).toBe(10);
  });

  it("Anmeldung mit hex-PKCE, Token und Erinnerung nach einem Jahr", async () => {
    const { verifier, challenge } = pkcePair("hex");
    expect(challenge).toMatch(/^[0-9a-f]{64}$/);
    const db = testDb();
    const url = new URL(tiktokOAuth.authUrl({ state: "s", codeChallenge: challenge, settings: getSettings(db) }));
    expect(url.searchParams.get("scope")).toBe("user.info.basic,video.upload,video.list");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    const direct = updateSettings(db, { tiktok: { mode: "direct_public" } });
    expect(new URL(tiktokOAuth.authUrl({ state: "s", codeChallenge: challenge, settings: direct })).searchParams.get("scope")).toContain("video.publish");

    const [acc] = await tiktokOAuth.connect({ code: "c", codeVerifier: verifier, settings: getSettings(db) });
    expect(acc).toMatchObject({ externalId: "open-1", name: "Fokuspilot TT", tokens: { accessToken: "tt-access", refreshToken: "tt-refresh" } });
    expect(new URLSearchParams(fake.calls("/v2/oauth/token/")[0].body.toString()).get("code_verifier")).toBe(verifier);
    expect(acc.reconnectBy!.getTime()).toBeGreaterThan(Date.now() + 360 * 86_400_000);
  });

  it("Entwurfsmodus: lädt in Teilen hoch und übergibt an die App", async () => {
    const { input, file } = await setup("tiktok", { bytes: 25 * MiB, externalId: "open-1" });
    fake.ttStatus = ["PROCESSING_UPLOAD", "SEND_TO_USER_INBOX"];
    const out = await createTikTokPublisher({ pollMs: 5, waitMs: 5000 }).publish(input(), {});
    expect(out).toEqual({ state: "handed_off", externalId: "pub-1" });
    const init = JSON.parse(fake.calls("/inbox/video/init/")[0].body.toString());
    expect(init.source_info).toEqual({ source: "FILE_UPLOAD", video_size: 25 * MiB, chunk_size: 10 * MiB, total_chunk_count: 2 });
    expect(fake.ttReceived).toEqual([
      { range: `bytes 0-${10 * MiB - 1}/${25 * MiB}`, bytes: 10 * MiB },
      { range: `bytes ${10 * MiB}-${25 * MiB - 1}/${25 * MiB}`, bytes: 15 * MiB },
    ]);
    expect(fs.statSync(file).size).toBe(25 * MiB);
  });

  it("direkt öffentlich ohne Audit: verständlicher Fehler, kein Upload", async () => {
    const { input } = await setup("tiktok", { externalId: "open-1", settings: { tiktok: { mode: "direct_public" } } });
    fake.ttPrivacy = ["SELF_ONLY"];
    await expect(createTikTokPublisher({ pollMs: 5 }).publish(input(), {})).rejects.toMatchObject({ kind: "fatal", message: expect.stringContaining("Audit") });
    expect(fake.ttReceived).toHaveLength(0);
  });

  it("direkt privat: Sichtbarkeit nur ich, KI-Kennzeichnung per is_aigc", async () => {
    const { input } = await setup("tiktok", { externalId: "open-1", settings: { tiktok: { mode: "direct_private" } } });
    fake.ttStatus = ["PUBLISH_COMPLETE"];
    const out = await createTikTokPublisher({ pollMs: 5 }).publish(input(), {});
    expect(out).toEqual({ state: "published", externalId: "7300000000001" });
    const init = JSON.parse(fake.calls("/v2/post/publish/video/init/")[0].body.toString());
    expect(init.post_info).toMatchObject({ privacy_level: "SELF_ONLY", is_aigc: true });
    expect(init.post_info.title).toContain("Die Praxis ist zu");
  });

  it("Fehlercodes", () => {
    expect(toTikTokError(400, { code: "spam_risk_too_many_posts" }, "x").kind).toBe("quota");
    expect(toTikTokError(401, { code: "access_token_invalid" }, "x").kind).toBe("auth");
    expect(toTikTokError(429, { code: "rate_limit_exceeded" }, "x").kind).toBe("retryable");
    expect(toTikTokError(400, { code: "unaudited_client_can_only_post_to_private_accounts" }, "x").message).toContain("Entwurf in der App");
  });
});

describe("LinkedIn", () => {
  it("verbindet das persönliche Profil, Erinnerung nach 60 Tagen", async () => {
    const url = new URL(linkedinOAuth.authUrl({ state: "s", codeChallenge: null, settings: getSettings(testDb()) }));
    expect(url.searchParams.get("scope")).toBe("openid profile w_member_social");
    const [acc] = await linkedinOAuth.connect({ code: "c", codeVerifier: "v", settings: getSettings(testDb()) });
    expect(acc).toMatchObject({ externalId: "abc123", name: "Fabian Muster", tokens: { accessToken: "li-access" } });
    const days = (acc.reconnectBy!.getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(60);
  });

  it("lädt in Teilen hoch, wartet und legt den Beitrag mit geschütztem Text an", async () => {
    const { input, file } = await setup("linkedin", { externalId: "abc123", bytes: 4001 });
    fake.liStatus = ["PROCESSING", "AVAILABLE"];
    const out = await createLinkedInPublisher({ pollMs: 5, waitMs: 5000 }).publish(input(), {});
    expect(out).toEqual({ state: "published", externalId: "urn:li:share:123", externalUrl: "https://www.linkedin.com/feed/update/urn:li:share:123/" });
    expect(Buffer.concat(fake.liParts).equals(fs.readFileSync(file))).toBe(true);
    const fin = JSON.parse(fake.calls("action=finalizeUpload")[0].body.toString());
    expect(fin.finalizeUploadRequest.uploadedPartIds).toEqual(["etag-1", "etag-2"]);
    const post = JSON.parse(fake.calls("/rest/posts")[0].body.toString());
    expect(post).toMatchObject({ author: "urn:li:person:abc123", visibility: "PUBLIC", lifecycleState: "PUBLISHED", content: { media: { id: "urn:li:video:V1" } } });
    expect(post.commentary).toContain("\\(aber nicht der Assistent\\)");
    expect(post.commentary).toContain("{hashtag|\\#|KI}");
    expect(fake.calls("/rest/posts")[0].headers["linkedin-version"]).toBe("202605");
  });

  it("verarbeitet LinkedIn noch: processing, danach ohne neuen Upload weiter", async () => {
    const { input } = await setup("linkedin", { externalId: "abc123" });
    fake.liStatus = ["PROCESSING", "PROCESSING", "PROCESSING", "PROCESSING"];
    const pub = createLinkedInPublisher({ pollMs: 5, waitMs: 15 });
    await expect(pub.publish(input(), {})).rejects.toMatchObject({ kind: "processing" });
    fake.liStatus = ["AVAILABLE"];
    await pub.publish(input(), {});
    expect(fake.calls("action=initializeUpload")).toHaveLength(1);
    expect(fake.calls("/rest/posts")).toHaveLength(1);
  });
});
