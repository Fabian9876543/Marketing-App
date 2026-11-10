import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { upsertAccount } from "@/lib/accounts";
import {
  CATCH_UP_MS,
  automationBusy,
  createAutomation,
  deleteAutomation,
  nextRunAt,
  recipeFromSession,
  runDueAutomations,
  startAutomationRun,
  upcomingRuns,
  updateAutomation,
} from "@/lib/automation";
import { autoFillProject, unplannedContents } from "@/lib/autoplan";
import { importBacklog } from "@/lib/backlog";
import type { DB } from "@/lib/db/client";
import { automations, contents, posts, projects, studioRuns, studioSessions } from "@/lib/db/schema";
import { listPostViews } from "@/lib/posts";
import { addSlot } from "@/lib/slots";
import { claudeInfo } from "@/lib/studio/claude";
import { executeRun } from "@/lib/studio/runner";
import { createSession, sessionMessages, sendMessage } from "@/lib/studio/sessions";
import { makeShort, testDb, testProject } from "./helpers";

const tz = "Europe/Berlin";
const base = { name: "Täglicher Tipp", recipe: "Mach einen Dialog-Short.", time: "06:00", weekdays: [1, 2, 3, 4, 5], shortsPerRun: 1, autoSchedule: true };

beforeAll(() => {
  process.env.CLAUDE_BIN = path.resolve("tests/fixtures/fake-claude.mjs");
});
afterAll(() => {
  delete process.env.CLAUDE_BIN;
});

function setCreated(db: DB, id: number, at: Date) {
  db.update(automations).set({ createdAt: at }).where(eq(automations.id, id)).run();
  return db.select().from(automations).where(eq(automations.id, id)).get()!;
}

describe("Zeitplan", () => {
  it("nächster Lauf: Mo–Fr 06:00 Ortszeit, nach dem letzten Lauf", () => {
    const a = { time: "06:00", weekdays: [1, 2, 3, 4, 5], createdAt: new Date("2026-11-06T09:00:00Z"), lastRunAt: null }; // Freitag
    expect(nextRunAt(a, tz)!.toISOString()).toBe("2026-11-09T05:00:00.000Z"); // Montag 06:00 Winterzeit
    expect(nextRunAt({ ...a, lastRunAt: new Date("2026-11-09T05:00:00Z") }, tz)!.toISOString()).toBe("2026-11-10T05:00:00.000Z");
    expect(upcomingRuns(a, new Date("2026-11-09T06:00:00Z"), tz, 3).map((d) => d.toISOString())).toEqual([
      "2026-11-10T05:00:00.000Z",
      "2026-11-11T05:00:00.000Z",
      "2026-11-12T05:00:00.000Z",
    ]);
  });

  it("über die Zeitumstellung hinweg bleibt es 06:00 Ortszeit", () => {
    const a = { time: "06:00", weekdays: [1, 2, 3, 4, 5, 6, 7], createdAt: new Date("2026-03-28T06:00:00Z"), lastRunAt: null };
    expect(nextRunAt(a, tz)!.toISOString()).toBe("2026-03-29T04:00:00.000Z"); // Sommerzeit: UTC+2
  });
});

describe("Fällige Läufe", () => {
  it("startet fällige Automationen genau einmal als frischen Chat", () => {
    const db = testDb();
    const p = testProject(db);
    const a = setCreated(db, createAutomation(db, p.id, base).id, new Date("2026-11-06T09:00:00Z"));
    expect(runDueAutomations(db, new Date("2026-11-09T04:59:00Z")).started).toBe(0); // noch nicht fällig
    expect(runDueAutomations(db, new Date("2026-11-09T05:00:30Z")).started).toBe(1);
    expect(runDueAutomations(db, new Date("2026-11-09T05:01:00Z")).started).toBe(0); // nicht doppelt

    const [s] = db.select().from(studioSessions).all();
    expect(s).toMatchObject({ automationId: a.id, title: "Täglicher Tipp · 09.11." });
    const [m] = sessionMessages(db, s.id);
    expect(m.text).toContain("Mach einen neuen Short nach dem Rezept");
    expect(m.text).toContain("Mach einen Dialog-Short.");
    expect(db.select().from(automations).get()!.lastRunAt!.toISOString()).toBe("2026-11-09T05:00:30.000Z");
  });

  it("wartet, solange der vorige Lauf noch arbeitet; überspringt lange verpasste Läufe", () => {
    const db = testDb();
    const p = testProject(db);
    const a = setCreated(db, createAutomation(db, p.id, base).id, new Date("2026-11-06T09:00:00Z"));
    runDueAutomations(db, new Date("2026-11-09T05:00:00Z"));
    expect(automationBusy(db, a.id)).toBe(true);
    expect(runDueAutomations(db, new Date("2026-11-10T05:00:10Z")).started).toBe(0); // Montagslauf hängt noch
    expect(() => startAutomationRun(db, db.select().from(automations).get()!)).toThrow(/noch nicht fertig/);

    db.update(studioRuns).set({ state: "done" }).run();
    // Dienstag 06:00 verpasst, Rechner erst um 13:00 wieder an → übersprungen
    const later = new Date(new Date("2026-11-10T05:00:00Z").getTime() + CATCH_UP_MS + 3600_000);
    expect(runDueAutomations(db, later)).toEqual({ started: 0, skipped: 1 });
    expect(nextRunAt(db.select().from(automations).get()!, tz)!.toISOString()).toBe("2026-11-11T05:00:00.000Z");
  });

  it("pausierte Automationen und archivierte Projekte laufen nicht", () => {
    const db = testDb();
    const p = testProject(db);
    const a = setCreated(db, createAutomation(db, p.id, { ...base, enabled: false }).id, new Date("2026-11-06T09:00:00Z"));
    expect(runDueAutomations(db, new Date("2026-11-09T05:00:30Z")).started).toBe(0);
    updateAutomation(db, a.id, { ...base, enabled: true });
    db.update(projects).set({ archived: true }).run();
    expect(runDueAutomations(db, new Date("2026-11-09T05:00:30Z")).started).toBe(0);
  });

  it("prüft Eingaben; Löschen lässt die Chats stehen", () => {
    const db = testDb();
    const p = testProject(db);
    expect(() => createAutomation(db, p.id, { ...base, name: " " })).toThrow(/Namen/);
    expect(() => createAutomation(db, p.id, { ...base, time: "25:00" })).toThrow(/HH:MM/);
    expect(() => createAutomation(db, p.id, { ...base, weekdays: [] })).toThrow(/Wochentag/);
    expect(() => createAutomation(db, p.id, { ...base, shortsPerRun: 9 })).toThrow(/1 bis 5/);
    const a = createAutomation(db, p.id, base);
    startAutomationRun(db, a);
    deleteAutomation(db, a.id);
    expect(db.select().from(studioSessions).get()!.automationId).toBeNull();
  });
});

describe("Rezept aus einem Chat", () => {
  it("übernimmt Auftrag, Rückmeldungen und das Ergebnis als Vorbild", () => {
    const db = testDb();
    const p = testProject(db);
    const { session, run } = createSession(db, p.id, "Mach einen Dialog-Short über einen Anruf um 22 Uhr.", "Anruf 22 Uhr");
    db.update(studioRuns).set({ state: "done", newShorts: ["2026-11-07-anruf-22-uhr"] }).where(eq(studioRuns.id, run.id)).run();
    const next = sendMessage(db, session.id, "Hook kürzer,\nund immer mit Untertiteln");
    db.update(studioRuns).set({ state: "done" }).where(eq(studioRuns.id, next.id)).run();

    const r = recipeFromSession(db, session.id);
    expect(r).toMatchObject({ name: "Anruf 22 Uhr", projectId: p.id });
    expect(r.recipe).toContain("## Auftrag\n\nMach einen Dialog-Short über einen Anruf um 22 Uhr.");
    expect(r.recipe).toContain("- Hook kürzer, und immer mit Untertiteln");
    expect(r.recipe).toContain("`backlog/2026-11-07-anruf-22-uhr/`");
  });
});

describe("Lauf mit automatischem Einplanen", () => {
  it("neue Shorts landen nach dem Lauf in freien Slots – zur Freigabe", async () => {
    const db = testDb();
    const p = testProject(db);
    addSlot(db, p.id, "09:00", [1, 2, 3, 4, 5, 6, 7]);
    await upsertAccount(db, { projectId: p.id, platform: "simulator", externalId: "t", name: "Test" });
    const a = createAutomation(db, p.id, { ...base, recipe: "Bitte render einen Short." });
    const { session, run } = startAutomationRun(db, a);
    await executeRun(db, run.id, { info: await claudeInfo(true) });

    expect(db.select().from(studioRuns).where(eq(studioRuns.id, run.id)).get()!.state).toBe("done");
    const [v] = listPostViews(db, { projectId: p.id });
    expect(v).toMatchObject({ state: "review", createdBy: "auto" });
    expect(sessionMessages(db, session.id).at(-1)!.text).toContain("Zur Freigabe eingeplant");

    // ohne „automatisch einplanen“ bleibt der Short ungeplant im Backlog
    updateAutomation(db, a.id, { ...base, recipe: "Bitte render einen Short.", autoSchedule: false });
    const second = startAutomationRun(db, db.select().from(automations).get()!);
    await executeRun(db, second.run.id, { info: await claudeInfo(true) });
    expect(listPostViews(db, { projectId: p.id })).toHaveLength(1);
    expect(unplannedContents(db, p.id)).toHaveLength(1);
  });
});

describe("Freie Slots füllen", () => {
  it("füllt freie Posting-Zeiten mit den ältesten ungeplanten Shorts, nie doppelt", async () => {
    const db = testDb();
    const p = testProject(db);
    for (const slug of ["a-erster", "b-zweiter", "c-dritter"]) makeShort(p.folder, slug);
    await importBacklog(db, p);
    const now = new Date("2026-11-09T07:00:00Z"); // Mo 08:00
    // Posts dürfen nicht in der Vergangenheit liegen – die Uhr für diesen Test auf „now“ stellen
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    onTestFinished(() => void vi.useRealTimers());
    addSlot(db, p.id, "09:00", [1, 2, 3, 4, 5, 6, 7]);
    addSlot(db, p.id, "19:00", [1, 2, 3, 4, 5, 6, 7]);

    expect(autoFillProject(db, p, now)).toBe(0); // ausgeschaltet
    db.update(projects).set({ autoFill: true, autoFillDays: 1 }).run();
    const proj = db.select().from(projects).get()!;
    expect(autoFillProject(db, proj, now)).toBe(0); // noch kein Konto
    await upsertAccount(db, { projectId: p.id, platform: "simulator", externalId: "t", name: "Test" });

    // Fenster 24 h (bis Di 08:00): heute 09:00 und 19:00 – Di 09:00 liegt schon außerhalb
    expect(autoFillProject(db, proj, now)).toBe(2);
    const views = listPostViews(db, { projectId: p.id });
    expect(views.map((v) => [v.content.slug, v.scheduledAt.toISOString(), v.state, v.createdBy])).toEqual([
      ["a-erster", "2026-11-09T08:00:00.000Z", "review", "auto"],
      ["b-zweiter", "2026-11-09T18:00:00.000Z", "review", "auto"],
    ]);
    expect(autoFillProject(db, proj, now)).toBe(0); // nichts doppelt
    expect(db.select().from(posts).all()).toHaveLength(2);
    expect(unplannedContents(db, p.id).map((c) => c.slug)).toEqual(["c-dritter"]);

    // abgesagte Posts geben den Short wieder frei
    db.update(posts).set({ state: "cancelled" }).where(eq(posts.contentId, db.select().from(contents).where(eq(contents.slug, "a-erster")).get()!.id)).run();
    expect(unplannedContents(db, p.id).map((c) => c.slug)).toEqual(["a-erster", "c-dritter"]);
  });
});
