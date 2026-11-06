import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readTokens, upsertAccount } from "@/lib/accounts";
import { importBacklog, normalizeHashtags, prettifySlug, slugify } from "@/lib/backlog";
import { contents, type Slot } from "@/lib/db/schema";
import { approvePost, cancelPost, createPost, getPostView, reschedulePost } from "@/lib/posts";
import { decrypt, encrypt } from "@/lib/secrets/cipher";
import { getSettings, updateSettings } from "@/lib/settings";
import { nextFreeSlot, slotOccurrences } from "@/lib/slots";
import { fromLocalInput, toLocalInput } from "@/lib/time";
import { makeShort, tempDir, testDb } from "./helpers";

describe("Verschlüsselung", () => {
  it("ver- und entschlüsselt, erkennt Manipulation", () => {
    const key = crypto.randomBytes(32);
    const sealed = encrypt("geheim", key);
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(decrypt(sealed, key)).toBe("geheim");
    const parts = sealed.split(":");
    parts[3] = Buffer.from("anders").toString("base64");
    expect(() => decrypt(parts.join(":"), key)).toThrow();
    expect(() => decrypt(sealed, crypto.randomBytes(32))).toThrow();
  });

  it("speichert Tokens verschlüsselt in der Datenbank", async () => {
    const db = testDb();
    const acc = await upsertAccount(db, { platform: "youtube", externalId: "UC1", name: "Kanal", tokens: { accessToken: "abc", refreshToken: "r" } });
    expect(acc.tokens).not.toContain("abc");
    expect(await readTokens(acc)).toMatchObject({ accessToken: "abc", refreshToken: "r" });
  });
});

describe("Zeit und Slots", () => {
  const tz = "Europe/Berlin";
  const slot = (time: string, weekdays = [1, 2, 3, 4, 5, 6, 7], active = true): Slot =>
    ({ id: 1, time, weekdays, active, createdAt: new Date() }) as Slot;

  it("rechnet datetime-local in der Zeitzone um", () => {
    const d = fromLocalInput("2026-11-10T09:00", tz);
    expect(d.toISOString()).toBe("2026-11-10T08:00:00.000Z"); // Winterzeit = UTC+1
    expect(toLocalInput(d, tz)).toBe("2026-11-10T09:00");
  });

  it("berücksichtigt die Zeitumstellung", () => {
    // 29.03.2026: Sommerzeit beginnt
    const occ = slotOccurrences([slot("09:00")], new Date("2026-03-28T00:00:00Z"), new Date("2026-03-29T23:00:00Z"), tz);
    expect(occ.map((d) => d.toISOString())).toEqual(["2026-03-28T08:00:00.000Z", "2026-03-29T07:00:00.000Z"]);
  });

  it("findet den nächsten freien Slot und überspringt belegte und inaktive", () => {
    const from = new Date("2026-11-09T07:00:00Z"); // Mo 08:00 Berlin
    const slots = [slot("09:00"), slot("19:00"), slot("13:00", [1], false)];
    expect(nextFreeSlot(slots, [], from, tz)?.toISOString()).toBe("2026-11-09T08:00:00.000Z");
    const taken = [new Date("2026-11-09T08:00:00Z")];
    expect(nextFreeSlot(slots, taken, from, tz)?.toISOString()).toBe("2026-11-09T18:00:00.000Z");
    expect(nextFreeSlot([], [], from, tz)).toBeNull();
  });

  it("nur an ausgewählten Wochentagen", () => {
    const from = new Date("2026-11-09T07:00:00Z"); // Montag
    expect(nextFreeSlot([slot("10:00", [3])], [], from, tz)?.toISOString()).toBe("2026-11-11T09:00:00.000Z");
  });
});

describe("Backlog", () => {
  it("liest Ordner ein, nutzt meta.json und markiert verschwundene Ordner", async () => {
    const db = testDb();
    const dir = tempDir();
    makeShort(dir, "2026-11-06-mailbox-vs-assistent", {
      meta: { title: "Mailbox vs. Assistent", hashtags: ["KI", "#Telefon", "KI"], aiGenerated: true, platforms: { youtube: { title: "YT-Titel" } } },
    });
    const second = makeShort(dir, "zahnarzt_termin");
    fs.mkdirSync(path.join(dir, "backlog", "leer")); // ohne Video → ignoriert

    const r1 = await importBacklog(db, dir);
    expect(r1).toMatchObject({ added: 2, updated: 0, errors: [] });
    const rows = db.select().from(contents).all();
    const first = rows.find((c) => c.slug.includes("mailbox"))!;
    expect(first.title).toBe("Mailbox vs. Assistent");
    expect(first.hashtags).toEqual(["#KI", "#Telefon"]);
    expect(first.aiGenerated).toBe(true);
    expect(first.platformTexts.youtube?.title).toBe("YT-Titel");
    expect(rows.find((c) => c.slug === "zahnarzt_termin")!.title).toBe("Zahnarzt termin");

    fs.rmSync(second, { recursive: true });
    const r2 = await importBacklog(db, dir);
    expect(r2).toMatchObject({ added: 0, updated: 1, missing: 1 });
  });

  it("meldet kaputte meta.json, importiert das Video trotzdem", async () => {
    const db = testDb();
    const dir = tempDir();
    const folder = makeShort(dir, "kaputt");
    fs.writeFileSync(path.join(folder, "meta.json"), "{ nicht json");
    const r = await importBacklog(db, dir);
    expect(r.added).toBe(1);
    expect(r.errors[0]).toContain("meta.json");
  });

  it("Hilfsfunktionen", () => {
    expect(slugify("Mailbox vs. KI-Assistent: Größe zählt!")).toBe("mailbox-vs-ki-assistent-groesse-zaehlt");
    expect(prettifySlug("2026-11-06-branchen_handwerk")).toBe("Branchen handwerk");
    expect(normalizeHashtags([" ki ", "##KI", ""])).toEqual(["#ki", "#KI"]);
  });
});

describe("Posts", () => {
  async function setup() {
    const db = testDb();
    const dir = tempDir();
    makeShort(dir, "demo");
    await importBacklog(db, dir);
    const content = db.select().from(contents).get()!;
    const account = await upsertAccount(db, { platform: "simulator", externalId: "test", name: "Test" });
    return { db, content, account };
  }

  it("legt Post mit Ziel an; Freigabe, Verschieben und Absage", async () => {
    const { db, content, account } = await setup();
    const at = new Date(Date.now() + 3600_000);
    const id = createPost(db, { contentId: content.id, scheduledAt: at, accountIds: [account.id], approve: false });
    expect(getPostView(db, id)!.display).toBe("review");

    approvePost(db, id);
    expect(getPostView(db, id)!.display).toBe("planned");

    const later = new Date(Date.now() + 7200_000);
    reschedulePost(db, id, later);
    expect(getPostView(db, id)!.scheduledAt.getTime()).toBe(later.getTime());

    cancelPost(db, id);
    const v = getPostView(db, id)!;
    expect(v.display).toBe("cancelled");
    expect(v.targets[0].state).toBe("cancelled");
  });

  it("überfällige Freigabe veröffentlicht sofort", async () => {
    const { db, content, account } = await setup();
    const id = createPost(db, { contentId: content.id, scheduledAt: new Date(Date.now() + 1000), accountIds: [account.id], approve: false });
    const later = new Date(Date.now() + 10 * 60_000);
    approvePost(db, id, later);
    expect(getPostView(db, id)!.targets[0].nextAttemptAt?.getTime()).toBe(later.getTime());
  });

  it("lehnt ungültige Eingaben ab", async () => {
    const { db, content, account } = await setup();
    expect(() => createPost(db, { contentId: content.id, scheduledAt: new Date(Date.now() + 1000), accountIds: [], approve: true })).toThrow(/Konto/);
    expect(() =>
      createPost(db, { contentId: content.id, scheduledAt: new Date(Date.now() - 3600_000), accountIds: [account.id], approve: true }),
    ).toThrow(/Vergangenheit/);
  });
});

describe("Einstellungen", () => {
  it("liefert Standardwerte und speichert Teil-Updates", () => {
    const db = testDb();
    expect(getSettings(db)).toMatchObject({ timezone: "Europe/Berlin", missedToleranceMinutes: 120, youtube: { privacy: "public" } });
    updateSettings(db, { youtube: { ...getSettings(db).youtube, privacy: "private" } });
    updateSettings(db, { missedToleranceMinutes: 30 });
    expect(getSettings(db)).toMatchObject({ missedToleranceMinutes: 30, youtube: { privacy: "private", uploadAheadDays: 14 } });
  });
});
