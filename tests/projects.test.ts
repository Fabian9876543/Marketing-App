import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { listAccounts, upsertAccount } from "@/lib/accounts";
import { resolveScope } from "@/lib/active-project";
import { importBacklog } from "@/lib/backlog";
import { openDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { contents, projectReferences, projects, settings } from "@/lib/db/schema";
import { approveAll, createPost, getPostView, listPostViews, takenTimes } from "@/lib/posts";
import { createProject, deleteProject, getProject, listProjects, setArchived, updateBrief, updateProject } from "@/lib/projects";
import { addFileReference, addLinkReference, addNoteReference, deleteReference, listReferences, referenceFile, updateReference } from "@/lib/references";
import { updateSettings } from "@/lib/settings";
import { addSlot, listSlots } from "@/lib/slots";
import { makeShort, tempDir, testDb, testProject } from "./helpers";

const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

describe("Projekte anlegen und bearbeiten", () => {
  it("legt Ordner, Unterordner und PROJEKT.md an; Slugs sind eindeutig", () => {
    const db = testDb();
    const base = tempDir("fps-projekte-");
    updateSettings(db, { projectsDir: base });
    const a = createProject(db, { name: "Fokuspilot", description: "KI-Telefonassistent", website: "fokuspilot.de" });
    const b = createProject(db, { name: "Fokuspilot" });
    expect([a.slug, b.slug]).toEqual(["fokuspilot", "fokuspilot-2"]);
    expect(a.folder).toBe(path.join(base, "fokuspilot"));
    expect(a.website).toBe("https://fokuspilot.de/");
    expect(a.color).not.toBe(b.color);
    for (const sub of ["backlog", "referenzen"]) expect(fs.existsSync(path.join(a.folder, sub))).toBe(true);
    expect(fs.readFileSync(path.join(a.folder, "PROJEKT.md"), "utf8")).toContain("# Fokuspilot");
  });

  it("lehnt ungültige Eingaben ab", () => {
    const db = testDb();
    expect(() => createProject(db, { name: " " })).toThrow(/Projektnamen/);
    expect(() => createProject(db, { name: "X", folder: "relativ/ordner" })).toThrow(/vollständigen Pfad/);
    expect(() => createProject(db, { name: "X", folder: "~" })).toThrow(/eigenen Ordner/);
    expect(() => createProject(db, { name: "X", folder: tempDir(), website: "http://[kaputt" })).toThrow(/Website/);
  });

  it("Briefing landet in PROJEKT.md, leere Felder werden weggelassen", () => {
    const db = testDb();
    const p = testProject(db, "Behörden-App");
    updateBrief(db, p.id, { audience: "Bürger ab 50", tone: "  ", messages: "Termine in 2 Minuten\nKeine Warteschlange", cta: "Jetzt laden" });
    const md = fs.readFileSync(path.join(p.folder, "PROJEKT.md"), "utf8");
    expect(md).toContain("## Zielgruppe\n\nBürger ab 50");
    expect(md).toContain("## Kernbotschaften\n\nTermine in 2 Minuten\nKeine Warteschlange");
    expect(md).not.toContain("## Tonalität");
    expect(md).not.toMatch(/\n{3,}/);
    expect(getProject(db, p.id)!.brief).toEqual({ audience: "Bürger ab 50", messages: "Termine in 2 Minuten\nKeine Warteschlange", cta: "Jetzt laden" });
  });

  it("bearbeiten, archivieren, löschen – der Ordner bleibt erhalten", async () => {
    const db = testDb();
    const p = testProject(db, "Alt");
    makeShort(p.folder, "demo");
    await importBacklog(db, p);
    const acc = await upsertAccount(db, { projectId: p.id, platform: "simulator", externalId: "t", name: "T" });
    const content = db.select().from(contents).get()!;
    createPost(db, { contentId: content.id, scheduledAt: new Date(Date.now() + 3600_000), accountIds: [acc.id], approve: true });

    updateProject(db, p.id, { name: "Neu", color: "#00AA11", folder: p.folder, defaultHashtags: ["#x"] });
    expect(getProject(db, p.id)).toMatchObject({ name: "Neu", color: "#00aa11", defaultHashtags: ["#x"] });

    expect(() => deleteProject(db, p.id)).toThrow(/archivieren/);
    setArchived(db, p.id, true);
    expect(listProjects(db).map((x) => x.id)).not.toContain(p.id);
    expect(() => deleteProject(db, p.id)).toThrow(/geplante Posts/);

    db.update(schema.posts).set({ state: "cancelled" }).run();
    deleteProject(db, p.id);
    expect(getProject(db, p.id)).toBeUndefined();
    expect(db.select().from(contents).all()).toHaveLength(0);
    expect(fs.existsSync(path.join(p.folder, "backlog", "demo", "video.mp4"))).toBe(true);
  });
});

describe("Referenzen", () => {
  it("speichert Dateien nach Kategorie, erkennt Typen und lehnt Unbekanntes ab", () => {
    const db = testDb();
    const p = testProject(db);
    const shot = addFileReference(db, p, { fileName: "Startseite iPhone.png", data: png, category: "auto", note: "Echte App-Screens" });
    const logo = addFileReference(db, p, { fileName: "logo-dunkel.png", data: png });
    const svg = addFileReference(db, p, { fileName: "zeichen.svg", data: Buffer.from("<svg/>") });
    const again = addFileReference(db, p, { fileName: "Startseite iPhone.png", data: png, category: "screenshot" });
    expect(shot).toMatchObject({ kind: "file", category: "screenshot", mime: "image/png", filePath: "referenzen/screenshot/startseite-iphone.png", title: "Startseite iPhone" });
    expect(logo.category).toBe("logo");
    expect(svg.category).toBe("logo");
    expect(again.filePath).toBe("referenzen/screenshot/startseite-iphone-2.png");
    expect(fs.readFileSync(path.join(p.folder, shot.filePath!)).equals(png)).toBe(true);
    expect(() => addFileReference(db, p, { fileName: "virus.exe", data: png })).toThrow(/nicht unterstützt/);
    expect(() => addFileReference(db, p, { fileName: "leer.png", data: Buffer.alloc(0) })).toThrow(/leer/);
  });

  it("Links und Notizen; alles erscheint in PROJEKT.md", () => {
    const db = testDb();
    const p = testProject(db, "Corporate Health");
    const link = addLinkReference(db, p, { url: "www.example.com/beispiel-video", note: "Tempo und Schnitt gefallen" });
    expect(link).toMatchObject({ kind: "link", category: "inspiration", title: "example.com", url: "https://www.example.com/beispiel-video" });
    expect(() => addLinkReference(db, p, { url: "http://[kaputt" })).toThrow(/Ungültiger Link/);
    addNoteReference(db, p, { title: "Farben", note: "Primär #1F6FEB", category: "branding" });
    expect(() => addNoteReference(db, p, { title: "", note: "x" })).toThrow(/Titel/);
    addFileReference(db, p, { fileName: "logo.png", data: png, note: "unten rechts" });

    const md = fs.readFileSync(path.join(p.folder, "PROJEKT.md"), "utf8");
    expect(md).toContain("### Inspiration & Beispiele\n\n- **example.com** – https://www.example.com/beispiel-video – Tempo und Schnitt gefallen");
    expect(md).toContain("### Farben & Schriften\n\n- **Farben** – Primär #1F6FEB");
    expect(md).toContain("- **logo** – `referenzen/logo/logo.png` – unten rechts");
  });

  it("bearbeiten und entfernen; die Datei wandert in den Papierkorb-Ordner", () => {
    const db = testDb();
    const p = testProject(db);
    const other = testProject(db, "Anderes");
    const ref = addFileReference(db, p, { fileName: "musik.mp3", data: Buffer.from("ID3") });
    expect(ref.category).toBe("audio");
    updateReference(db, p, ref.id, { title: "Hintergrundmusik", note: "lizenziert bis 2027", category: "audio" });
    expect(listReferences(db, p.id)[0]).toMatchObject({ title: "Hintergrundmusik", note: "lizenziert bis 2027" });
    expect(() => deleteReference(db, other, ref.id)).toThrow(/nicht gefunden/);
    deleteReference(db, p, ref.id);
    expect(listReferences(db, p.id)).toHaveLength(0);
    expect(fs.existsSync(path.join(p.folder, ref.filePath!))).toBe(false);
    expect(fs.readdirSync(path.join(p.folder, "referenzen", "_geloescht"))[0]).toMatch(/musik\.mp3$/);
  });

  it("liefert nur Pfade innerhalb des Projektordners", () => {
    const db = testDb();
    const p = testProject(db);
    const ref = addFileReference(db, p, { fileName: "a.png", data: png });
    expect(referenceFile(p, ref)).toBe(path.join(p.folder, "referenzen", "screenshot", "a.png"));
    db.update(projectReferences).set({ filePath: "../../etc/passwd" }).where(eq(projectReferences.id, ref.id)).run();
    expect(referenceFile(p, listReferences(db, p.id)[0])).toBeNull();
  });
});

describe("Projekte sind voneinander getrennt", () => {
  it("Backlog, Konten, Slots, Posts und Freigaben je Projekt", async () => {
    const db = testDb();
    const a = testProject(db, "A", { defaultHashtags: ["#ProjektA"] });
    const b = testProject(db, "B");
    makeShort(a.folder, "gleicher-name");
    makeShort(b.folder, "gleicher-name", { meta: { title: "B-Short", hashtags: ["eigener"] } });
    await importBacklog(db, a);
    await importBacklog(db, b);
    const rows = db.select().from(contents).all();
    expect(rows).toHaveLength(2);
    expect(rows.find((c) => c.projectId === a.id)!.hashtags).toEqual(["#ProjektA"]); // Standard-Hashtags
    expect(rows.find((c) => c.projectId === b.id)!.hashtags).toEqual(["#eigener"]);

    // Einlesen von A markiert keine Shorts von B als fehlend
    fs.rmSync(path.join(a.folder, "backlog", "gleicher-name"), { recursive: true });
    await importBacklog(db, a);
    expect(db.select().from(contents).where(eq(contents.projectId, b.id)).get()!.available).toBe(true);
    makeShort(a.folder, "gleicher-name");
    await importBacklog(db, a);

    const accA = await upsertAccount(db, { projectId: a.id, platform: "simulator", externalId: "x", name: "A-Kanal" });
    const accB = await upsertAccount(db, { projectId: b.id, platform: "simulator", externalId: "x", name: "B-Kanal" }); // gleiches Konto, anderes Projekt
    expect(accA.id).not.toBe(accB.id);
    expect(listAccounts(db, { projectId: a.id }).map((x) => x.name)).toEqual(["A-Kanal"]);

    const cA = rows.find((c) => c.projectId === a.id)!;
    const cB = rows.find((c) => c.projectId === b.id)!;
    expect(() => createPost(db, { contentId: cA.id, scheduledAt: new Date(Date.now() + 3600_000), accountIds: [accB.id], approve: true })).toThrow(
      /anderen Projekt/,
    );
    const at = new Date(Date.now() + 3600_000);
    const pa = createPost(db, { contentId: cA.id, scheduledAt: at, accountIds: [accA.id], approve: false });
    createPost(db, { contentId: cB.id, scheduledAt: at, accountIds: [accB.id], approve: false });

    expect(listPostViews(db, { projectId: a.id }).map((v) => v.project.name)).toEqual(["A"]);
    expect(listPostViews(db)).toHaveLength(2);
    expect(takenTimes(db, new Date(), b.id)).toHaveLength(1);

    addSlot(db, a.id, "09:00", [1, 2, 3, 4, 5]);
    expect(listSlots(db, a.id)).toHaveLength(1);
    expect(listSlots(db, b.id)).toHaveLength(0);

    expect(approveAll(db, new Date(), a.id)).toBe(1);
    expect(getPostView(db, pa)!.state).toBe("approved");
    expect(listPostViews(db, { projectId: b.id })[0].state).toBe("review");
  });

  it("Projektauswahl: unbekannt → erstes Projekt, „alle“ erst ab zwei Projekten", () => {
    const p = (id: number) => ({ id, name: `P${id}` }) as schema.Project;
    expect(resolveScope([], "alle")).toMatchObject({ active: null, all: false });
    expect(resolveScope([p(1)], "alle")).toMatchObject({ active: { id: 1 }, all: false });
    expect(resolveScope([p(1), p(2)], "alle")).toMatchObject({ active: null, all: true });
    expect(resolveScope([p(1), p(2)], "2")).toMatchObject({ active: { id: 2 }, all: false });
    expect(resolveScope([p(1), p(2)], "99")).toMatchObject({ active: { id: 1 } });
    expect(resolveScope([p(1), p(2)], undefined)).toMatchObject({ active: { id: 1 } });
  });
});

describe("Übernahme von Daten aus der Zeit vor den Projekten", () => {
  it("bestehende Konten, Shorts und Slots landen im Projekt „Fokuspilot“ mit dem alten Content-Ordner", () => {
    process.env.FPS_DATA_DIR ??= tempDir("fps-data-");
    const file = path.join(tempDir(), "alt.db");
    const legacyFolder = tempDir("fps-alt-content-");

    // Datenbank im Stand vor den Projekten (nur Migrationen 0000 und 0001)
    const oldMigrations = tempDir("fps-mig-");
    fs.mkdirSync(path.join(oldMigrations, "meta"));
    for (const f of ["0000_init.sql", "0001_accounts_reconnect_by.sql"]) fs.copyFileSync(path.join("drizzle", f), path.join(oldMigrations, f));
    const journal = JSON.parse(fs.readFileSync("drizzle/meta/_journal.json", "utf8"));
    journal.entries = journal.entries.slice(0, 2);
    fs.writeFileSync(path.join(oldMigrations, "meta", "_journal.json"), JSON.stringify(journal));
    const sqlite = new Database(file);
    const old = drizzle(sqlite, { schema });
    migrate(old, { migrationsFolder: oldMigrations });
    sqlite.exec(`INSERT INTO accounts (platform, external_id, name) VALUES ('youtube', 'UC1', 'Kanal')`);
    sqlite.exec(`INSERT INTO contents (slug, folder, video_file, title) VALUES ('demo', '/x', 'video.mp4', 'Demo')`);
    sqlite.exec(`INSERT INTO slots (time) VALUES ('09:00')`);
    sqlite.prepare(`INSERT INTO settings (key, value) VALUES ('app', ?)`).run(JSON.stringify({ contentDir: legacyFolder }));
    sqlite.close();

    const db = openDb(file);
    const [p] = db.select().from(projects).all();
    expect(p).toMatchObject({ id: 1, name: "Fokuspilot", folder: legacyFolder });
    expect(db.select().from(schema.accounts).get()!.projectId).toBe(1);
    expect(db.select().from(contents).get()!.projectId).toBe(1);
    expect(db.select().from(schema.slots).get()!.projectId).toBe(1);
    expect(fs.existsSync(path.join(legacyFolder, "backlog"))).toBe(true);
    expect(db.select().from(settings).all()).toHaveLength(1);
  });

  it("neue Installation: kein Projekt, bis du eins anlegst", () => {
    const db = testDb();
    expect(listProjects(db)).toHaveLength(0);
  });
});

describe("Anmeldung gehört zu einem Projekt", () => {
  it("ohne Projekt keine Anmeldung; mit Projekt wird es im OAuth-Status gemerkt", async () => {
    process.env.FPS_DATA_DIR = tempDir("fps-data-oauth-");
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    const { getDb } = await import("@/lib/db/client");
    const { __setTestKey } = await import("@/lib/secrets/keystore");
    __setTestKey(crypto.randomBytes(32));
    (globalThis as { __fpsDb?: unknown }).__fpsDb = undefined;
    const db = getDb();
    const project = createProject(db, { name: "OAuth-Test", folder: tempDir() });
    const { GET } = await import("@/app/api/oauth/[platform]/start/route");
    const params = Promise.resolve({ platform: "youtube" });

    const without = await GET(new Request("http://localhost:4321/api/oauth/youtube/start"), { params });
    expect(new URL(without.headers.get("location")!).searchParams.get("fehler")).toContain("Bitte zuerst ein Projekt wählen");

    const res = await GET(new Request(`http://localhost:4321/api/oauth/youtube/start?projekt=${project.id}`), { params: Promise.resolve({ platform: "youtube" }) });
    expect(res.headers.get("location")).toContain("accounts.google.com");
    const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
    expect(db.select().from(schema.oauthStates).where(eq(schema.oauthStates.state, state)).get()!.projectId).toBe(project.id);
  });
});
