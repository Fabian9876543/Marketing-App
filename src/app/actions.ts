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
  updateVoices,
} from "@/lib/projects";
import { addLinkReference, addNoteReference, deleteReference, isCategory, updateReference } from "@/lib/references";
import { QUICK_PROMPTS, cancelSession, createSession, deleteSession, getSession, sendMessage } from "@/lib/studio/sessions";
import { setupStudio } from "@/lib/studio/workspace";
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  setAutomationEnabled,
  startAutomationRun,
  updateAutomation,
} from "@/lib/automation";
import { projects } from "@/lib/db/schema";
import { startAnalysis } from "@/lib/analysis";
import { refreshDueInsights } from "@/lib/analytics/store";
import { addManualLearning, decideLearning, removeLearning } from "@/lib/learnings";
import { listVoices, setElevenLabsKey } from "@/lib/voice/elevenlabs";
import { addHiggsfieldToClaude, checkHiggsfield } from "@/lib/studio/higgsfield";
import { childEnv } from "@/lib/studio/runner";
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
      studio: {
        model: str(form, "studioModel"),
        maxParallel: Number(form.get("studioMaxParallel") ?? current.studio.maxParallel),
      },
      voice: current.voice,
      higgsfield: current.higgsfield,
      analytics: {
        fetchEveryHours: Number(form.get("anFetchEveryHours") ?? current.analytics.fetchEveryHours),
        weekly: form.get("anWeekly") === "on",
        weekday: Number(form.get("anWeekday") ?? current.analytics.weekday),
        time: str(form, "anTime") || current.analytics.time,
      },
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

/* ---------- Studio ---------- */

export async function setupStudioAction(form: FormData) {
  await attempt(form, "/studio", () => {
    const project = formProject(form);
    setupStudio(project);
    return `Studio für „${project.name}“ eingerichtet: Vorlage in studio/, Anweisungen in CLAUDE.md`;
  });
}

export async function startStudioAction(form: FormData) {
  let target = "/studio";
  let msg: { ok?: string; error?: string } = {};
  try {
    const project = formProject(form);
    const quick = QUICK_PROMPTS.find((q) => q.key === str(form, "quick"));
    const { session } = createSession(getDb(), project.id, quick?.prompt ?? str(form, "prompt"), quick?.label);
    target = `/studio?chat=${session.id}`;
  } catch (err) {
    msg = { error: (err as Error).message };
  }
  finish(target, msg);
}

export async function sendStudioMessageAction(form: FormData) {
  const sessionId = num(form, "sessionId");
  await attempt(form, `/studio?chat=${sessionId}`, () => {
    sendMessage(getDb(), sessionId, str(form, "prompt"));
    return "";
  });
}

export async function cancelStudioAction(form: FormData) {
  const sessionId = num(form, "sessionId");
  await attempt(form, `/studio?chat=${sessionId}`, () => (cancelSession(getDb(), sessionId) ? "Wird abgebrochen …" : "Es läuft gerade nichts"));
}

export async function deleteStudioSessionAction(form: FormData) {
  let error: string | undefined;
  try {
    const db = getDb();
    if (!getSession(db, num(form, "sessionId"))) throw new Error("Chat nicht gefunden");
    deleteSession(db, num(form, "sessionId"));
  } catch (err) {
    error = (err as Error).message;
  }
  finish("/studio", error ? { error } : { ok: "Chat gelöscht" });
}

/* ---------- Automationen ---------- */

const automationInput = (form: FormData) => ({
  name: str(form, "name"),
  recipe: str(form, "recipe"),
  time: str(form, "time"),
  weekdays: form.getAll("weekdays").map(Number),
  shortsPerRun: Number(form.get("shortsPerRun") ?? 1),
  autoSchedule: form.get("autoSchedule") === "on",
  enabled: form.get("enabled") === "on",
  sourceSessionId: Number(form.get("sourceSessionId")) || null,
});

export async function saveAutomationAction(form: FormData) {
  let target = backTo(form, "/studio/automationen");
  let msg: { ok?: string; error?: string };
  try {
    const db = getDb();
    const id = Number(form.get("automationId")) || 0;
    if (id) {
      const a = updateAutomation(db, id, automationInput(form));
      msg = { ok: `Automation „${a.name}“ gespeichert` };
    } else {
      const a = createAutomation(db, formProject(form).id, automationInput(form));
      msg = { ok: `Automation „${a.name}“ angelegt${a.enabled ? "" : " (pausiert)"}` };
    }
    target = "/studio/automationen";
  } catch (err) {
    msg = { error: (err as Error).message };
  }
  finish(target, msg);
}

export async function toggleAutomationAction(form: FormData) {
  await attempt(form, "/studio/automationen", () => {
    const enabled = form.get("enabled") === "1";
    setAutomationEnabled(getDb(), num(form, "automationId"), enabled);
    return enabled ? "Automation aktiv" : "Automation pausiert";
  });
}

export async function runAutomationNowAction(form: FormData) {
  let target = "/studio/automationen";
  let msg: { ok?: string; error?: string } = {};
  try {
    const db = getDb();
    const a = getAutomation(db, num(form, "automationId"));
    if (!a) throw new Error("Automation nicht gefunden");
    const { session } = startAutomationRun(db, a);
    target = `/studio?chat=${session.id}`;
  } catch (err) {
    msg = { error: (err as Error).message };
  }
  finish(target, msg);
}

export async function deleteAutomationAction(form: FormData) {
  await attempt(form, "/studio/automationen", () => {
    deleteAutomation(getDb(), num(form, "automationId"));
    return "Automation gelöscht – ihre bisherigen Chats bleiben erhalten";
  });
}

export async function updateAutoFillAction(form: FormData) {
  await attempt(form, "/projekte", () => {
    const project = formProject(form);
    const autoFill = form.get("autoFill") === "on";
    const days = Math.min(14, Math.max(1, Number(form.get("autoFillDays")) || 3));
    getDb().update(projects).set({ autoFill, autoFillDays: days }).where(eq(projects.id, project.id)).run();
    return autoFill ? `Freie Slots der nächsten ${days} Tage werden automatisch gefüllt (zur Freigabe)` : "Automatisches Füllen ausgeschaltet";
  });
}

/* ---------- Zahlen und Erkenntnisse ---------- */

export async function refreshInsightsAction(form: FormData) {
  await attempt(form, "/zahlen", async () => {
    const projectId = Number(form.get("projectId")) || undefined;
    const results = await refreshDueInsights(getDb(), new Date(), { force: true, projectId });
    if (!results.length) throw new Error("Kein aktives Konto verbunden");
    const ok = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    const items = ok.reduce((t, r) => t + r.items, 0);
    return (
      `Zahlen aktualisiert: ${items} Beiträge aus ${ok.length} ${ok.length === 1 ? "Konto" : "Konten"}` +
      (failed.length ? ` · ${failed.length} ohne Zahlen (${failed.map((r) => r.account.name).join(", ")} – Hinweis bei Konten)` : "")
    );
  });
}

export async function startAnalysisAction(form: FormData) {
  let target = backTo(form, "/zahlen");
  let msg: { ok?: string; error?: string } = {};
  try {
    const { session } = startAnalysis(getDb(), formProject(form).id);
    target = `/studio?chat=${session.id}`;
  } catch (err) {
    msg = { error: (err as Error).message };
  }
  finish(target, msg);
}

export async function decideLearningAction(form: FormData) {
  await attempt(form, "/zahlen", () => {
    const decision = form.get("decision") === "rejected" ? "rejected" : "accepted";
    decideLearning(getDb(), num(form, "learningId"), decision, str(form, "text"));
    return decision === "accepted" ? "Erkenntnis übernommen – steht jetzt in PROJEKT.md und gilt für neue Shorts" : "Erkenntnis abgelehnt";
  });
}

export async function addLearningAction(form: FormData) {
  await attempt(form, "/zahlen", () => {
    addManualLearning(getDb(), formProject(form).id, str(form, "text"));
    return "Erkenntnis hinzugefügt – steht jetzt in PROJEKT.md";
  });
}

export async function removeLearningAction(form: FormData) {
  await attempt(form, "/zahlen", () => {
    removeLearning(getDb(), num(form, "learningId"));
    return "Erkenntnis entfernt";
  });
}

/* ---------- Stimmen (ElevenLabs) ---------- */

export async function saveVoiceSettingsAction(form: FormData) {
  await attempt(form, "/einstellungen#stimmen", async () => {
    const db = getDb();
    const apiKey = str(form, "apiKey").trim();
    const model = str(form, "voiceModel").trim();
    if (apiKey) {
      const voices = await listVoices(apiKey); // prüft den Schlüssel
      await setElevenLabsKey(db, apiKey);
      if (model) updateSettings(db, { voice: { model } });
      return `ElevenLabs verbunden – ${voices.length} Stimmen verfügbar. Jetzt pro Projekt eine Stimme wählen (Projekt → Einstellungen).`;
    }
    if (model) updateSettings(db, { voice: { model } });
    return "Stimmen-Einstellungen gespeichert";
  });
}

export async function removeVoiceKeyAction(form: FormData) {
  await attempt(form, "/einstellungen#stimmen", async () => {
    await setElevenLabsKey(getDb(), null);
    return "ElevenLabs-Schlüssel entfernt";
  });
}

/** „id|Name“ aus der Auswahl → { id, name } */
const voiceRef = (v: string) => {
  const i = v.indexOf("|");
  return i > 0 ? { id: v.slice(0, i), name: v.slice(i + 1) } : undefined;
};

export async function saveProjectVoicesAction(form: FormData) {
  await attempt(form, "/projekte", () => {
    const project = formProject(form);
    updateVoices(getDb(), project.id, { main: voiceRef(str(form, "mainVoice")), second: voiceRef(str(form, "secondVoice")) });
    return "Stimmen gespeichert – stehen jetzt auch in PROJEKT.md";
  });
}

/* ---------- Higgsfield (KI-Bilder und -Videos) ---------- */

export async function saveHiggsfieldSettingsAction(form: FormData) {
  await attempt(form, "/einstellungen#higgsfield", () => {
    const enabled = form.get("hfEnabled") === "on";
    const maxCredits = Math.round(Number(form.get("hfMaxCredits")));
    if (!(maxCredits >= 1 && maxCredits <= 10000)) throw new Error("Budget zwischen 1 und 10.000 Credits angeben");
    updateSettings(getDb(), {
      higgsfield: { enabled, maxCredits, unlim: form.get("hfUnlim") === "on", inAutomations: form.get("hfAuto") === "on" },
    });
    return enabled ? `Higgsfield im Studio eingeschaltet – höchstens ${maxCredits} Credits pro Auftrag` : "Higgsfield im Studio ausgeschaltet";
  });
}

export async function checkHiggsfieldAction(form: FormData) {
  await attempt(form, "/einstellungen#higgsfield", async () => {
    const d = await checkHiggsfield(getDb(), { env: childEnv() });
    if (d.status === "ok") return `Higgsfield ist verbunden (${d.server})`;
    throw new Error(d.message);
  });
}

export async function setupHiggsfieldAction(form: FormData) {
  await attempt(form, "/einstellungen#higgsfield", async () => {
    await addHiggsfieldToClaude(childEnv());
    const d = await checkHiggsfield(getDb(), { env: childEnv() });
    if (d.status === "ok") return "Higgsfield ist eingerichtet und verbunden";
    return "Higgsfield ist bei Claude Code eingetragen – jetzt einmal anmelden (Anleitung unten)";
  });
}
