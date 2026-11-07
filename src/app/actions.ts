"use server";

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { disconnectAccount, upsertAccount } from "@/lib/accounts";
import { ALL_PROJECTS, PROJECT_COOKIE } from "@/lib/active-project";
import { importBacklog, normalizeHashtags } from "@/lib/backlog";
import { getDb } from "@/lib/db/client";
import { contents } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  approveAll,
  approvePost,
  cancelPost,
  createPost,
  deletePost,
  reschedulePost,
  retryTarget,
  takenTimes,
} from "@/lib/posts";
import {
  backlogFolder,
  createProject,
  deleteProject,
  expandHome,
  referencesFolder,
  requireProject,
  setArchived,
  updateBrief,
  updateProject,
} from "@/lib/projects";
import { addLinkReference, addNoteReference, deleteReference, isCategory, updateReference } from "@/lib/references";
import { appSettingsSchema, getSettings, updateSettings } from "@/lib/settings";
import { addSlot, listSlots, nextFreeSlot, removeSlot, toggleSlot } from "@/lib/slots";
import { formatDateTime, fromLocalInput, isValidTimezone } from "@/lib/time";

/* ---------- Hilfen ---------- */

function backTo(form: FormData, fallback: string): string {
  const b = String(form.get("back") ?? "");
  return b.startsWith("/") && !b.startsWith("//") ? b : fallback;
}

function finish(path: string, msg: { ok?: string; error?: string }): never {
  revalidatePath("/", "layout");
  const url = new URL(path, "http://local");
  url.searchParams.delete("ok");
  url.searchParams.delete("fehler");
  if (msg.ok) url.searchParams.set("ok", msg.ok);
  if (msg.error) url.searchParams.set("fehler", msg.error);
  redirect(`${url.pathname}${url.search}${url.hash}`);
}

/** Führt eine Aktion aus und kehrt mit Erfolgs- oder Fehlermeldung zur Seite zurück. */
async function attempt(form: FormData, fallback: string, fn: () => string | Promise<string>): Promise<never> {
  let msg: { ok?: string; error?: string };
  try {
    msg = { ok: await fn() };
  } catch (err) {
    msg = { error: err instanceof Error ? err.message : String(err) };
  }
  finish(backTo(form, fallback), msg);
}

const num = (form: FormData, key: string) => {
  const n = Number(form.get(key));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Ungültiger Wert: ${key}`);
  return n;
};

const str = (form: FormData, key: string) => String(form.get(key) ?? "");

/** Projekt aus dem Formularfeld projectId. */
const formProject = (form: FormData) => requireProject(getDb(), num(form, "projectId"));

async function setActiveProject(value: string) {
  (await cookies()).set(PROJECT_COOKIE, value, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 365 * 86_400 });
}

/* ---------- Posts ---------- */

export async function schedulePostAction(form: FormData) {
  await attempt(form, "/backlog", () => {
    const db = getDb();
    const settings = getSettings(db);
    const contentId = num(form, "contentId");
    const content = db.select().from(contents).where(eq(contents.id, contentId)).get();
    if (!content) throw new Error("Short nicht gefunden");
    const accountIds = form.getAll("accountIds").map(Number).filter(Boolean);
    let at: Date;
    if (form.get("mode") === "time") {
      const value = String(form.get("at") ?? "");
      if (!value) throw new Error("Bitte eine Zeit wählen");
      at = fromLocalInput(value, settings.timezone);
    } else {
      const slot = nextFreeSlot(listSlots(db, content.projectId), takenTimes(db, new Date(), content.projectId), new Date(), settings.timezone);
      if (!slot) throw new Error("Kein freier Slot – lege beim Projekt Posting-Zeiten an oder wähle eine feste Zeit");
      at = slot;
    }
    const approve = form.get("approve") === "on";
    createPost(db, { contentId, scheduledAt: at, accountIds, approve });
    return `Eingeplant für ${formatDateTime(at, settings.timezone)}${approve ? "" : " – wartet auf Freigabe"}`;
  });
}

export async function approvePostAction(form: FormData) {
  await attempt(form, "/warteschlange", () => {
    approvePost(getDb(), num(form, "postId"));
    return "Freigegeben";
  });
}

export async function approveAllAction(form: FormData) {
  await attempt(form, "/warteschlange", () => {
    const projectId = Number(form.get("projectId")) || undefined;
    return `${approveAll(getDb(), new Date(), projectId)} Posts freigegeben`;
  });
}

export async function reschedulePostAction(form: FormData) {
  await attempt(form, "/kalender", () => {
    const db = getDb();
    const tz = getSettings(db).timezone;
    const at = fromLocalInput(String(form.get("at") ?? ""), tz);
    reschedulePost(db, num(form, "postId"), at);
    return `Verschoben auf ${formatDateTime(at, tz)}`;
  });
}

export async function cancelPostAction(form: FormData) {
  await attempt(form, "/kalender", () => {
    cancelPost(getDb(), num(form, "postId"));
    return "Post abgesagt";
  });
}

export async function deletePostAction(form: FormData) {
  let error: string | undefined;
  try {
    deletePost(getDb(), num(form, "postId"));
  } catch (err) {
    error = (err as Error).message;
  }
  // Nach dem Löschen gibt es die Detailseite nicht mehr.
  finish(error ? backTo(form, "/kalender") : "/warteschlange", error ? { error } : { ok: "Post gelöscht" });
}

export async function retryTargetAction(form: FormData) {
  await attempt(form, "/warteschlange?tab=fehler", () => {
    retryTarget(getDb(), num(form, "targetId"));
    return "Wird gleich erneut versucht";
  });
}

/* ---------- Backlog ---------- */

export async function importBacklogAction(form: FormData) {
  await attempt(form, "/backlog", async () => {
    const r = await importBacklog(getDb(), formProject(form));
    const parts = [`${r.added} neu`, `${r.updated} aktualisiert`];
    if (r.missing) parts.push(`${r.missing} fehlen`);
    if (r.errors.length) throw new Error(`Eingelesen (${parts.join(", ")}), aber: ${r.errors.join(" · ")}`);
    return `Backlog eingelesen: ${parts.join(", ")}`;
  });
}

/** Projektordner (oder backlog/ bzw. referenzen/) im Finder öffnen. */
export async function openProjectFolderAction(form: FormData) {
  await attempt(form, "/backlog", () => {
    const project = formProject(form);
    const sub = str(form, "sub");
    const dir = sub === "backlog" ? backlogFolder(project) : sub === "referenzen" ? referencesFolder(project) : project.folder;
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform !== "darwin") return `Ordner: ${dir}`;
    execFile("open", [dir]);
    return "Ordner im Finder geöffnet";
  });
}

/* ---------- Slots ---------- */

export async function addSlotAction(form: FormData) {
  await attempt(form, "/projekte", () => {
    const time = str(form, "time");
    addSlot(getDb(), num(form, "projectId"), time, form.getAll("weekdays").map(Number));
    return `Posting-Zeit ${time} angelegt`;
  });
}

export async function removeSlotAction(form: FormData) {
  await attempt(form, "/projekte", () => {
    removeSlot(getDb(), num(form, "projectId"), num(form, "slotId"));
    return "Posting-Zeit gelöscht";
  });
}

export async function toggleSlotAction(form: FormData) {
  await attempt(form, "/projekte", () => {
    const active = form.get("active") === "1";
    toggleSlot(getDb(), num(form, "projectId"), num(form, "slotId"), active);
    return active ? "Posting-Zeit aktiviert" : "Posting-Zeit pausiert";
  });
}

/* ---------- Projekte ---------- */

/** Aktives Projekt wechseln („alle“ = alle Projekte). */
export async function switchProjectAction(form: FormData) {
  const value = str(form, "projekt");
  await setActiveProject(value === ALL_PROJECTS ? ALL_PROJECTS : String(num(form, "projekt")));
  finish(backTo(form, "/"), {});
}

export async function createProjectAction(form: FormData) {
  let target = "/projekte/neu";
  let msg: { ok?: string; error?: string };
  try {
    const project = createProject(getDb(), {
      name: str(form, "name"),
      description: str(form, "description"),
      website: str(form, "website"),
      color: str(form, "color"),
      folder: str(form, "folder"),
      defaultHashtags: normalizeHashtags(str(form, "hashtags").split(/[\s,]+/)),
    });
    await setActiveProject(String(project.id));
    target = `/projekte/${project.id}?tab=briefing`;
    msg = { ok: `Projekt „${project.name}“ angelegt – Ordner: ${project.folder}` };
  } catch (err) {
    msg = { error: (err as Error).message };
  }
  finish(target, msg);
}

export async function updateProjectAction(form: FormData) {
  await attempt(form, "/projekte", () => {
    const project = updateProject(getDb(), num(form, "projectId"), {
      name: str(form, "name"),
      description: str(form, "description"),
      website: str(form, "website"),
      color: str(form, "color"),
      folder: str(form, "folder"),
      defaultHashtags: normalizeHashtags(str(form, "hashtags").split(/[\s,]+/)),
    });
    return `Projekt „${project.name}“ gespeichert`;
  });
}

export async function updateBriefAction(form: FormData) {
  await attempt(form, "/projekte", () => {
    updateBrief(getDb(), num(form, "projectId"), {
      audience: str(form, "audience"),
      tone: str(form, "tone"),
      messages: str(form, "messages"),
      rules: str(form, "rules"),
      cta: str(form, "cta"),
    });
    return "Briefing gespeichert – PROJEKT.md im Projektordner ist aktualisiert";
  });
}

export async function archiveProjectAction(form: FormData) {
  await attempt(form, "/projekte", () => {
    const archived = form.get("archived") === "1";
    setArchived(getDb(), num(form, "projectId"), archived);
    return archived ? "Projekt archiviert – geplante Posts laufen weiter" : "Projekt wieder aktiv";
  });
}

export async function deleteProjectAction(form: FormData) {
  let error: string | undefined;
  try {
    deleteProject(getDb(), num(form, "projectId"));
  } catch (err) {
    error = (err as Error).message;
  }
  finish(error ? backTo(form, "/projekte") : "/projekte", error ? { error } : { ok: "Projekt gelöscht – der Ordner auf der Festplatte ist erhalten geblieben" });
}

/* ---------- Referenzen ---------- */

const categoryOf = (form: FormData, fallback: "inspiration" | "sonstiges") => {
  const c = str(form, "category");
  return isCategory(c) ? c : fallback;
};

export async function addReferenceLinkAction(form: FormData) {
  await attempt(form, "/projekte", () => {
    const ref = addLinkReference(getDb(), formProject(form), {
      url: str(form, "url"),
      title: str(form, "title"),
      note: str(form, "note"),
      category: categoryOf(form, "inspiration"),
    });
    return `Link „${ref.title}“ gespeichert`;
  });
}

export async function addReferenceNoteAction(form: FormData) {
  await attempt(form, "/projekte", () => {
    const ref = addNoteReference(getDb(), formProject(form), { title: str(form, "title"), note: str(form, "note"), category: categoryOf(form, "sonstiges") });
    return `Notiz „${ref.title}“ gespeichert`;
  });
}

export async function updateReferenceAction(form: FormData) {
  await attempt(form, "/projekte", () => {
    updateReference(getDb(), formProject(form), num(form, "referenceId"), {
      title: str(form, "title"),
      note: str(form, "note"),
      category: categoryOf(form, "sonstiges"),
    });
    return "Referenz gespeichert";
  });
}

export async function deleteReferenceAction(form: FormData) {
  await attempt(form, "/projekte", () => {
    deleteReference(getDb(), formProject(form), num(form, "referenceId"));
    return "Referenz entfernt (Datei liegt in referenzen/_geloescht)";
  });
}

/* ---------- Einstellungen ---------- */

export async function saveSettingsAction(form: FormData) {
  await attempt(form, "/einstellungen", () => {
    const db = getDb();
    const current = getSettings(db);
    const timezone = String(form.get("timezone") ?? current.timezone).trim();
    if (!isValidTimezone(timezone)) throw new Error(`Unbekannte Zeitzone: ${timezone}`);
    const projectsDir = expandHome(str(form, "projectsDir") || current.projectsDir);
    if (!path.isAbsolute(projectsDir)) throw new Error("Projekte-Ordner bitte als vollständigen Pfad angeben");
    const parsed = appSettingsSchema.safeParse({
      timezone,
      missedToleranceMinutes: Number(form.get("missedToleranceMinutes")),
      projectsDir,
      youtube: {
        privacy: form.get("ytPrivacy"),
        uploadAheadDays: Number(form.get("ytUploadAheadDays")),
        dailyUploadLimit: Number(form.get("ytDailyUploadLimit")),
        categoryId: String(form.get("ytCategoryId") ?? "28"),
        addShortsTag: form.get("ytAddShortsTag") === "on",
      },
      tiktok: { mode: form.get("tiktokMode") ?? current.tiktok.mode },
      instagram: { shareToFeed: form.get("igShareToFeed") === "on" },
      linkedin: { visibility: form.get("liVisibility") ?? current.linkedin.visibility },
      aiDisclosure: String(form.get("aiDisclosure") ?? current.aiDisclosure).trim(),
    });
    if (!parsed.success) throw new Error(`Ungültige Eingabe: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
    updateSettings(db, parsed.data);
    return "Einstellungen gespeichert";
  });
}

/* ---------- Konten ---------- */

export async function addTestAccountAction(form: FormData) {
  await attempt(form, "/konten", async () => {
    await upsertAccount(getDb(), { projectId: formProject(form).id, platform: "simulator", externalId: "test-kanal", name: "Test-Kanal", handle: "lokal" });
    return "Test-Kanal hinzugefügt – Posts landen als Kopie im Datenordner";
  });
}

export async function disconnectAccountAction(form: FormData) {
  await attempt(form, "/konten", () => {
    disconnectAccount(getDb(), num(form, "accountId"));
    return "Konto getrennt";
  });
}
