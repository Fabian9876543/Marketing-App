"use server";

import { execFile } from "node:child_process";
import fs from "node:fs";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { disconnectAccount, upsertAccount } from "@/lib/accounts";
import { backlogDir, importBacklog } from "@/lib/backlog";
import { getDb } from "@/lib/db/client";
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

/* ---------- Posts ---------- */

export async function schedulePostAction(form: FormData) {
  await attempt(form, "/backlog", () => {
    const db = getDb();
    const settings = getSettings(db);
    const contentId = num(form, "contentId");
    const accountIds = form.getAll("accountIds").map(Number).filter(Boolean);
    let at: Date;
    if (form.get("mode") === "time") {
      const value = String(form.get("at") ?? "");
      if (!value) throw new Error("Bitte eine Zeit wählen");
      at = fromLocalInput(value, settings.timezone);
    } else {
      const slot = nextFreeSlot(listSlots(db), takenTimes(db, new Date()), new Date(), settings.timezone);
      if (!slot) throw new Error("Kein freier Slot – lege unter „Einstellungen“ Posting-Zeiten an oder wähle eine feste Zeit");
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
  await attempt(form, "/warteschlange", () => `${approveAll(getDb())} Posts freigegeben`);
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
    const db = getDb();
    const r = await importBacklog(db, getSettings(db).contentDir);
    const parts = [`${r.added} neu`, `${r.updated} aktualisiert`];
    if (r.missing) parts.push(`${r.missing} fehlen`);
    if (r.errors.length) throw new Error(`Eingelesen (${parts.join(", ")}), aber: ${r.errors.join(" · ")}`);
    return `Backlog eingelesen: ${parts.join(", ")}`;
  });
}

export async function openContentFolderAction(form: FormData) {
  await attempt(form, "/backlog", () => {
    const dir = backlogDir(getSettings(getDb()).contentDir);
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform !== "darwin") return `Ordner: ${dir}`;
    execFile("open", [dir]);
    return "Ordner im Finder geöffnet";
  });
}

/* ---------- Slots ---------- */

export async function addSlotAction(form: FormData) {
  await attempt(form, "/einstellungen", () => {
    const time = String(form.get("time") ?? "");
    addSlot(getDb(), time, form.getAll("weekdays").map(Number));
    return `Posting-Zeit ${time} angelegt`;
  });
}

export async function removeSlotAction(form: FormData) {
  await attempt(form, "/einstellungen", () => {
    removeSlot(getDb(), num(form, "slotId"));
    return "Posting-Zeit gelöscht";
  });
}

export async function toggleSlotAction(form: FormData) {
  await attempt(form, "/einstellungen", () => {
    const active = form.get("active") === "1";
    toggleSlot(getDb(), num(form, "slotId"), active);
    return active ? "Posting-Zeit aktiviert" : "Posting-Zeit pausiert";
  });
}

/* ---------- Einstellungen ---------- */

export async function saveSettingsAction(form: FormData) {
  await attempt(form, "/einstellungen", () => {
    const db = getDb();
    const current = getSettings(db);
    const timezone = String(form.get("timezone") ?? current.timezone).trim();
    if (!isValidTimezone(timezone)) throw new Error(`Unbekannte Zeitzone: ${timezone}`);
    const contentDir = String(form.get("contentDir") ?? current.contentDir).trim();
    if (!contentDir.startsWith("/") && !contentDir.startsWith("~")) throw new Error("Content-Ordner bitte als vollständigen Pfad angeben");
    const parsed = appSettingsSchema.safeParse({
      timezone,
      missedToleranceMinutes: Number(form.get("missedToleranceMinutes")),
      contentDir: contentDir.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"),
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
    await upsertAccount(getDb(), { platform: "simulator", externalId: "test-kanal", name: "Test-Kanal", handle: "lokal" });
    return "Test-Kanal hinzugefügt – Posts landen als Kopie im Datenordner";
  });
}

export async function disconnectAccountAction(form: FormData) {
  await attempt(form, "/konten", () => {
    disconnectAccount(getDb(), num(form, "accountId"));
    return "Konto getrennt";
  });
}
