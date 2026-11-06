import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAccount, readTokens, upsertAccount } from "@/lib/accounts";
import { importBacklog } from "@/lib/backlog";
import { contents, type UploadSession } from "@/lib/db/schema";
import { getAccessToken } from "@/lib/publishing/tokens";
import type { PublishInput } from "@/lib/publishing/types";
import { CHUNK_SIZE, toYoutubeError } from "@/lib/publishing/youtube/api";
import { buildAuthUrl } from "@/lib/publishing/youtube/oauth";
import { buildMetadata, youtubePublisher } from "@/lib/publishing/youtube/publisher";
import { getSettings } from "@/lib/settings";
import { makeShort, tempDir, testDb } from "./helpers";

/** Nachbau der relevanten YouTube-/Google-Endpunkte. */
class FakeYouTube {
  server = http.createServer((req, res) => void this.handle(req, res));
  base = "";
  received = Buffer.alloc(0);
  expectedSize = 0;
  metadata: unknown = null;
  failChunkOnce: number | null = null;
  chunkCount = 0;
  bytesInRequests = 0;
  statusUpdates: unknown[] = [];
  deleted: string[] = [];
  tokenRequests: URLSearchParams[] = [];

  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  reset() {
    Object.assign(this, { received: Buffer.alloc(0), metadata: null, failChunkOnce: null, chunkCount: 0, bytesInRequests: 0, statusUpdates: [], deleted: [], tokenRequests: [] });
  }
  private async body(req: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }
  private json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url!, this.base);
    const body = await this.body(req);
    if (url.pathname === "/token") {
      this.tokenRequests.push(new URLSearchParams(body.toString()));
      return this.json(res, 200, { access_token: "neu-123", expires_in: 3600 });
    }
    if (req.headers.authorization?.startsWith("Bearer ") !== true) return this.json(res, 401, { error: { message: "no auth" } });
    if (req.method === "POST" && url.pathname === "/upload/youtube/v3/videos") {
      this.metadata = JSON.parse(body.toString());
      this.expectedSize = Number(req.headers["x-upload-content-length"]);
      return this.json(res, 200, {}, { Location: `${this.base}/upload/session/1` });
    }
    if (req.method === "PUT" && url.pathname === "/upload/session/1") {
      const range = String(req.headers["content-range"]);
      const done = () => this.json(res, 200, { id: "vid-1", status: { uploadStatus: "uploaded" } });
      const incomplete = () => {
        const headers: Record<string, string> = this.received.length ? { Range: `bytes=0-${this.received.length - 1}` } : {};
        res.writeHead(308, headers).end();
      };
      if (range.startsWith("bytes */")) return this.received.length === this.expectedSize ? done() : incomplete();
      const m = range.match(/bytes (\d+)-(\d+)\/(\d+)/)!;
      const start = Number(m[1]);
      this.chunkCount++;
      if (this.failChunkOnce === this.chunkCount) {
        this.failChunkOnce = null;
        return this.json(res, 503, { error: { message: "backend error" } });
      }
      if (start !== this.received.length) return this.json(res, 400, { error: { message: "falscher Offset" } });
      this.bytesInRequests += body.length;
      this.received = Buffer.concat([this.received, body]);
      return this.received.length === this.expectedSize ? done() : incomplete();
    }
    if (req.method === "PUT" && url.pathname === "/youtube/v3/videos") {
      this.statusUpdates.push(JSON.parse(body.toString()));
      return this.json(res, 200, {});
    }
    if (req.method === "DELETE" && url.pathname === "/youtube/v3/videos") {
      this.deleted.push(url.searchParams.get("id")!);
      res.writeHead(204).end();
      return;
    }
    this.json(res, 404, { error: { message: "unbekannt" } });
  }
}

const yt = new FakeYouTube();

beforeAll(async () => {
  await yt.start();
  process.env.YOUTUBE_API_BASE = yt.base;
  process.env.GOOGLE_TOKEN_URL = `${yt.base}/token`;
  process.env.GOOGLE_CLIENT_ID = "client-id";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
});
afterAll(() => yt.server.close());
beforeEach(() => yt.reset());

async function setup(bytes: number) {
  const db = testDb();
  const dir = tempDir();
  const folder = makeShort(dir, "gross", { bytes, meta: { title: "Anruf um 22 Uhr", hashtags: ["KI"], aiGenerated: true } });
  await importBacklog(db, dir);
  const content = db.select().from(contents).get()!;
  const account = await upsertAccount(db, { platform: "youtube", externalId: "UC1", name: "Fokuspilot", tokens: { accessToken: "a", expiresAt: Date.now() + 3600_000 } });
  let session: UploadSession | null = null;
  const input = (): PublishInput => ({
    target: { id: 1, uploadSession: session } as PublishInput["target"],
    post: {} as PublishInput["post"],
    content,
    account,
    settings: getSettings(db),
    accessToken: async () => "a",
    saveSession: (s) => (session = s),
    log: () => {},
    now: new Date(),
  });
  return { db, content, account, input, file: path.join(folder, "video.mp4"), getSession: () => session };
}

describe("YouTube", () => {
  it("lädt in 8-MiB-Teilen hoch und kennzeichnet KI-Inhalte", async () => {
    const size = 2 * CHUNK_SIZE + 12345;
    const { input, file } = await setup(size);
    const out = await youtubePublisher.publish(input(), {});
    expect(out).toMatchObject({ state: "published", externalId: "vid-1" });
    expect(yt.chunkCount).toBe(3);
    expect(yt.received.equals(fs.readFileSync(file))).toBe(true);
    expect(yt.metadata).toMatchObject({
      snippet: { title: "Anruf um 22 Uhr", tags: ["KI"], categoryId: "28" },
      status: { privacyStatus: "public", containsSyntheticMedia: true, selfDeclaredMadeForKids: false },
    });
    expect((yt.metadata as { snippet: { description: string } }).snippet.description).toContain("#Shorts");
  });

  it("setzt einen abgebrochenen Upload an der richtigen Stelle fort", async () => {
    const size = 2 * CHUNK_SIZE + 999;
    const { input, file, getSession } = await setup(size);
    yt.failChunkOnce = 2;
    await expect(youtubePublisher.publish(input(), {})).rejects.toMatchObject({ kind: "retryable" });
    expect(getSession()).toMatchObject({ total: size });
    expect(yt.received.length).toBe(CHUNK_SIZE);

    const out = await youtubePublisher.publish(input(), {});
    expect(out.externalId).toBe("vid-1");
    expect(yt.received.equals(fs.readFileSync(file))).toBe(true);
    expect(yt.bytesInRequests).toBe(size); // nichts doppelt gesendet
    expect(getSession()).toBeNull();
  });

  it("plant mit publishAt (privat bis zur Zeit), ändert Zeit und löscht bei Absage", async () => {
    const { input } = await setup(1000);
    const at = new Date(Date.now() + 86_400_000);
    const out = await youtubePublisher.publish(input(), { publishAt: at });
    expect(out.state).toBe("scheduled");
    expect(yt.metadata).toMatchObject({ status: { privacyStatus: "private", publishAt: at.toISOString() } });

    const i = input();
    i.target.externalId = "vid-1";
    const later = new Date(at.getTime() + 3600_000);
    await youtubePublisher.updateSchedule!(i, later);
    expect(yt.statusUpdates[0]).toMatchObject({ id: "vid-1", status: { privacyStatus: "private", publishAt: later.toISOString() } });
    await youtubePublisher.remove!(i);
    expect(yt.deleted).toEqual(["vid-1"]);
  });

  it("erneuert abgelaufene Tokens und speichert sie verschlüsselt", async () => {
    const db = testDb();
    const acc = await upsertAccount(db, {
      platform: "youtube",
      externalId: "UC2",
      name: "K",
      tokens: { accessToken: "alt", refreshToken: "refresh-1", expiresAt: Date.now() - 1000 },
    });
    expect(await getAccessToken(db, acc)).toBe("neu-123");
    expect(yt.tokenRequests[0].get("grant_type")).toBe("refresh_token");
    expect(yt.tokenRequests[0].get("refresh_token")).toBe("refresh-1");
    const stored = await readTokens(getAccount(db, acc.id)!);
    expect(stored).toMatchObject({ accessToken: "neu-123", refreshToken: "refresh-1" });
  });

  it("übersetzt API-Fehler", async () => {
    const res = (status: number, reason: string) =>
      new Response(JSON.stringify({ error: { message: "x", errors: [{ reason }] } }), { status });
    expect((await toYoutubeError(res(403, "quotaExceeded"), "c")).kind).toBe("quota");
    expect((await toYoutubeError(res(401, ""), "c")).kind).toBe("auth");
    expect((await toYoutubeError(res(503, "backendError"), "c")).kind).toBe("retryable");
    expect((await toYoutubeError(res(400, "invalidTitle"), "c")).kind).toBe("fatal");
  });

  it("Metadaten: Titel gekürzt, spitze Klammern entfernt, plattformeigene Texte haben Vorrang", async () => {
    const { content, db } = await setup(10);
    const meta = buildMetadata(
      { ...content, title: "<b>".padEnd(150, "x"), platformTexts: { youtube: { description: "Eigene Beschreibung #shorts" } } },
      getSettings(db),
    );
    expect(meta.snippet.title.length).toBe(100);
    expect(meta.snippet.title).not.toMatch(/[<>]/);
    expect(meta.snippet.description).toBe("Eigene Beschreibung #shorts");
  });

  it("Anmelde-URL enthält PKCE, Offline-Zugriff und die Upload-Berechtigung", () => {
    const url = new URL(buildAuthUrl({ state: "s1", codeChallenge: "c1" }));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toContain("youtube.upload");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:4321/api/oauth/youtube/callback");
  });
});
