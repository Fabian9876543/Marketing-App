import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { upsertAccount } from "@/lib/accounts";
import { importBacklog } from "@/lib/backlog";
import type { DB } from "@/lib/db/client";
import { accounts, contents, postTargets, type Platform } from "@/lib/db/schema";
import { cancelPost, createPost, getPostView, reschedulePost } from "@/lib/posts";
import { PublishError, type Publisher, type PublishInput } from "@/lib/publishing/types";
import { updateSettings } from "@/lib/settings";
import { createEngine } from "@/lib/worker/engine";
import { makeShort, tempDir, testDb } from "./helpers";

const MIN = 60_000;

type Call = { kind: "publish" | "update" | "remove"; targetId: number; publishAt?: Date };

function fakePublisher(platform: Platform, behaviour: (input: PublishInput, n: number) => void = () => {}, opts: Partial<Publisher> = {}) {
  const calls: Call[] = [];
  let n = 0;
  const pub: Publisher = {
    platform,
    async publish(input, { publishAt }) {
      calls.push({ kind: "publish", targetId: input.target.id, publishAt });
      behaviour(input, ++n);
      return { state: publishAt ? "scheduled" : "published", externalId: `ext-${input.target.id}` };
    },
    async updateSchedule(input, publishAt) {
      calls.push({ kind: "update", targetId: input.target.id, publishAt });
    },
    async remove(input) {
      calls.push({ kind: "remove", targetId: input.target.id });
    },
    ...opts,
  };
  return { pub, calls };
}

async function setup(platform: Platform = "simulator") {
  const db = testDb();
  const dir = tempDir();
  makeShort(dir, "demo");
  await importBacklog(db, dir);
  const content = db.select().from(contents).get()!;
  const account = await upsertAccount(db, { platform, externalId: "acc", name: "Konto" });
  return { db, content, account };
}

function clock(start: number) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms), set: (ms: number) => (t = ms) };
}

const target = (db: DB, postId: number) => getPostView(db, postId)!.targets[0];

describe("Worker-Engine", () => {
  it("veröffentlicht freigegebene Posts zur geplanten Zeit – nicht vorher, nicht ohne Freigabe", async () => {
    const { db, content, account } = await setup();
    const base = Date.now();
    const c = clock(base);
    const { pub, calls } = fakePublisher("simulator");
    const engine = createEngine({ db, publishers: { simulator: pub }, getAccessToken: async () => "t", now: c.now });

    const approved = createPost(db, { contentId: content.id, scheduledAt: new Date(base + 10 * MIN), accountIds: [account.id], approve: true });
    const review = createPost(db, { contentId: content.id, scheduledAt: new Date(base + 10 * MIN), accountIds: [account.id], approve: false });

    let r = await engine.tick();
    expect(calls).toHaveLength(0);
    expect(r.nextDueAt?.getTime()).toBe(base + 10 * MIN);

    c.advance(10 * MIN);
    r = await engine.tick();
    expect(r.published).toBe(1);
    expect(target(db, approved)).toMatchObject({ state: "published", externalId: `ext-${target(db, approved).id}`, attempts: 1 });
    expect(target(db, review).state).toBe("pending");
    expect(getPostView(db, approved)!.display).toBe("published");
  });

  it("wiederholt nach 1, 5, 15, 60 Minuten und gibt dann auf", async () => {
    const { db, content, account } = await setup();
    const base = Date.now();
    const c = clock(base);
    const { pub, calls } = fakePublisher("simulator", () => {
      throw new PublishError("retryable", "Server hustet");
    });
    const engine = createEngine({ db, publishers: { simulator: pub }, getAccessToken: async () => "t", now: c.now });
    const id = createPost(db, { contentId: content.id, scheduledAt: new Date(base + MIN), accountIds: [account.id], approve: true });

    c.advance(MIN);
    for (const delay of [1, 5, 15, 60]) {
      await engine.tick();
      const t = target(db, id);
      expect(t.state).toBe("pending");
      expect(t.nextAttemptAt!.getTime()).toBe(c.now().getTime() + delay * MIN);
      c.advance(delay * MIN - 1000);
      await engine.tick(); // noch nicht fällig
      c.advance(1000);
    }
    await engine.tick();
    expect(calls).toHaveLength(5);
    expect(target(db, id)).toMatchObject({ state: "failed", attempts: 5 });
    expect(target(db, id).lastError).toContain("Nach 5 Versuchen aufgegeben");
  });

  it("markiert Posts als verpasst, wenn der Rechner länger als die Toleranz aus war", async () => {
    const { db, content, account } = await setup();
    updateSettings(db, { missedToleranceMinutes: 120 });
    const base = Date.now();
    const c = clock(base);
    const { pub, calls } = fakePublisher("simulator");
    const engine = createEngine({ db, publishers: { simulator: pub }, getAccessToken: async () => "t", now: c.now });
    const late = createPost(db, { contentId: content.id, scheduledAt: new Date(base + MIN), accountIds: [account.id], approve: true });
    const ok = createPost(db, { contentId: content.id, scheduledAt: new Date(base + 60 * MIN), accountIds: [account.id], approve: true });

    c.advance(MIN + 121 * MIN); // „aufgewacht“: erster 2 Std. 1 Min. drüber, zweiter 62 Min.
    const r = await engine.tick();
    expect(r).toMatchObject({ missed: 1, published: 1 });
    expect(target(db, late).state).toBe("missed");
    expect(target(db, ok).state).toBe("published");
    expect(calls).toHaveLength(1);
  });

  it("Anmeldefehler: Konto braucht Neuverbindung, Post schlägt fehl", async () => {
    const { db, content, account } = await setup();
    const base = Date.now();
    const c = clock(base);
    const { pub } = fakePublisher("simulator", () => {
      throw new PublishError("auth", "Token widerrufen");
    });
    const engine = createEngine({ db, publishers: { simulator: pub }, getAccessToken: async () => "t", now: c.now });
    const a = createPost(db, { contentId: content.id, scheduledAt: new Date(base + MIN), accountIds: [account.id], approve: true });
    const b = createPost(db, { contentId: content.id, scheduledAt: new Date(base + 2 * MIN), accountIds: [account.id], approve: true });

    c.advance(MIN);
    await engine.tick();
    expect(target(db, a)).toMatchObject({ state: "failed", lastError: "Token widerrufen" });
    expect(db.select().from(accounts).where(eq(accounts.id, account.id)).get()!.status).toBe("needs_reconnect");

    c.advance(MIN);
    await engine.tick();
    expect(target(db, b).lastError).toContain("neu verbunden");
  });

  it("Tageslimit erreicht: zählt nicht als Versuch, wird verschoben", async () => {
    const { db, content, account } = await setup();
    const base = Date.now();
    const c = clock(base);
    const { pub } = fakePublisher("simulator", (_i, n) => {
      if (n === 1) throw new PublishError("quota", "Limit", new Date(base + 600 * MIN));
    });
    const engine = createEngine({ db, publishers: { simulator: pub }, getAccessToken: async () => "t", now: c.now });
    const id = createPost(db, { contentId: content.id, scheduledAt: new Date(base + MIN), accountIds: [account.id], approve: true });
    c.advance(MIN);
    await engine.tick();
    expect(target(db, id)).toMatchObject({ state: "pending", attempts: 0 });
    expect(target(db, id).nextAttemptAt!.getTime()).toBe(base + 600 * MIN);
  });

  it("eigenes Tageslimit pro Plattform", async () => {
    const { db, content, account } = await setup();
    const base = Date.now();
    const c = clock(base);
    const { pub, calls } = fakePublisher("simulator", () => {}, {
      dailyLimit: () => 1,
      quotaDayStart: (now) => new Date(now.getTime() - (now.getTime() % 86_400_000)),
    });
    const engine = createEngine({ db, publishers: { simulator: pub }, getAccessToken: async () => "t", now: c.now });
    createPost(db, { contentId: content.id, scheduledAt: new Date(base + MIN), accountIds: [account.id], approve: true });
    const second = createPost(db, { contentId: content.id, scheduledAt: new Date(base + MIN), accountIds: [account.id], approve: true });
    c.advance(MIN);
    await engine.tick();
    expect(calls).toHaveLength(1);
    expect(target(db, second).state).toBe("pending");
    expect(target(db, second).lastError).toContain("Tageslimit");
  });

  it("lädt vorab hoch, überträgt neue Zeiten und Absagen an die Plattform", async () => {
    const { db, content, account } = await setup("youtube");
    const base = Date.now();
    const c = clock(base);
    const { pub, calls } = fakePublisher("youtube", () => {}, { uploadAheadWindowMs: () => 14 * 86_400_000 });
    const engine = createEngine({ db, publishers: { youtube: pub }, getAccessToken: async () => "t", now: c.now });
    const at = new Date(base + 3 * 86_400_000);
    const id = createPost(db, { contentId: content.id, scheduledAt: at, accountIds: [account.id], approve: true });

    await engine.tick();
    expect(calls[0]).toMatchObject({ kind: "publish", publishAt: at });
    expect(target(db, id).state).toBe("scheduled");
    expect(getPostView(db, id)!.display).toBe("platform");

    const later = new Date(base + 4 * 86_400_000);
    reschedulePost(db, id, later);
    expect(target(db, id).syncNeeded).toBe(true);
    await engine.tick();
    expect(calls[1]).toMatchObject({ kind: "update", publishAt: later });
    expect(target(db, id).syncNeeded).toBe(false);

    c.set(later.getTime());
    const r = await engine.tick();
    expect(r.published).toBe(1);
    expect(target(db, id).state).toBe("published");

    // Absage eines zweiten, vorab hochgeladenen Posts
    const id2 = createPost(db, { contentId: content.id, scheduledAt: new Date(c.now().getTime() + 86_400_000), accountIds: [account.id], approve: true });
    await engine.tick();
    expect(target(db, id2).state).toBe("scheduled");
    cancelPost(db, id2);
    await engine.tick();
    expect(calls.at(-1)).toMatchObject({ kind: "remove" });
    expect(target(db, id2).state).toBe("cancelled");
  });

  it("kurz vor der Zeit wird direkt veröffentlicht statt vorab", async () => {
    const { db, content, account } = await setup("youtube");
    const base = Date.now();
    const c = clock(base);
    const { pub, calls } = fakePublisher("youtube", () => {}, { uploadAheadWindowMs: () => 14 * 86_400_000 });
    const engine = createEngine({ db, publishers: { youtube: pub }, getAccessToken: async () => "t", now: c.now });
    createPost(db, { contentId: content.id, scheduledAt: new Date(base + 5 * MIN), accountIds: [account.id], approve: true });
    await engine.tick();
    expect(calls).toHaveLength(0);
    c.advance(5 * MIN);
    await engine.tick();
    expect(calls[0].publishAt).toBeUndefined();
  });

  it("nimmt hängende Uploads nach einem Neustart wieder auf", async () => {
    const { db, content, account } = await setup();
    const base = Date.now();
    const c = clock(base);
    const { pub, calls } = fakePublisher("simulator");
    const engine = createEngine({ db, publishers: { simulator: pub }, getAccessToken: async () => "t", now: c.now });
    const id = createPost(db, { contentId: content.id, scheduledAt: new Date(base + MIN), accountIds: [account.id], approve: true });
    const tid = target(db, id).id;
    db.update(postTargets).set({ state: "uploading", attempts: 1, uploadSession: { url: "x", total: 1, createdAt: base } }).where(eq(postTargets.id, tid)).run();

    expect(engine.recoverStale()).toBe(1);
    expect(target(db, id)).toMatchObject({ state: "pending", uploadSession: { url: "x" } });
    await engine.tick();
    expect(calls).toHaveLength(1);
    expect(target(db, id).state).toBe("published");
  });

  it("nicht unterstützte Plattform: klare Fehlermeldung", async () => {
    const { db, content, account } = await setup("instagram");
    const base = Date.now();
    const engine = createEngine({ db, publishers: {}, getAccessToken: async () => "t", now: () => new Date(base + 2 * MIN) });
    const id = createPost(db, { contentId: content.id, scheduledAt: new Date(base + MIN), accountIds: [account.id], approve: true });
    await engine.tick();
    expect(target(db, id).lastError).toContain("Instagram wird in dieser Version noch nicht unterstützt");
  });
});
