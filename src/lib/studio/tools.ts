import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { listAccounts, PLATFORM_LABEL } from "../accounts";
import { importBacklog } from "../backlog";
import type { DB } from "../db/client";
import { contents, PLATFORMS, type Platform, type Project } from "../db/schema";
import { describePlan, planIntoNextSlot } from "../autoplan";
import { statsText } from "../analytics/stats";
import { probeVideo } from "../media";
import { describeVoice, getElevenLabsKey, listVoices, synthesize, VoiceError, type Voice } from "../voice/elevenlabs";
import { listLearnings, proposeLearning } from "../learnings";
import { contentUsage, takenTimes } from "../posts";
import { getSettings } from "../settings";
import { listSlots, slotOccurrences } from "../slots";
import { formatDateTime } from "../time";

/**
 * Werkzeuge, die Claude Code im Studio über den MCP-Server „studio“ aufrufen kann.
 * Bewusst klein gehalten: lesen, einlesen, zur Freigabe einplanen – nie veröffentlichen.
 */

export function briefingTool(project: Project): string {
  const file = path.join(project.folder, "PROJEKT.md");
  const md = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : `# ${project.name}\n\n(Noch kein Briefing)`;
  return `${md}\n\n---\nProjektordner: ${project.folder}\nBacklog: ${path.join(project.folder, "backlog")}\nReferenzen: ${path.join(project.folder, "referenzen")}\nVorlage: ${path.join(project.folder, "studio")}`;
}

export function backlogTool(db: DB, project: Project): string {
  const rows = db.select().from(contents).where(and(eq(contents.projectId, project.id), eq(contents.available, true))).all();
  if (!rows.length) return "Das Backlog ist leer.";
  const usage = contentUsage(db, project.id);
  return rows
    .map((c) => {
      const u = usage.get(c.id);
      const status = u?.published ? `${u.published}× veröffentlicht` : u?.planned ? `${u.planned}× geplant` : "noch nicht geplant";
      const dur = c.durationSec ? `${Math.round(c.durationSec)} s` : "?";
      return `- ${c.slug} – „${c.title}“ (${dur}, ${status})`;
    })
    .join("\n");
}

export function freeSlotsTool(db: DB, project: Project, count = 5): string {
  const tz = getSettings(db).timezone;
  const slots = listSlots(db, project.id);
  if (!slots.filter((s) => s.active).length) return "Für dieses Projekt sind keine Posting-Zeiten angelegt (Projekt → Posting-Zeiten).";
  const taken = new Set(takenTimes(db, new Date(), project.id).map((d) => Math.round(d.getTime() / 60_000)));
  const free = slotOccurrences(slots, new Date(Date.now() + 5 * 60_000), new Date(Date.now() + 60 * 86_400_000), tz)
    .filter((d) => !taken.has(Math.round(d.getTime() / 60_000)))
    .slice(0, count);
  return free.length ? free.map((d) => `- ${formatDateTime(d, tz)} (${d.toISOString()})`).join("\n") : "In den nächsten 60 Tagen ist kein Slot frei.";
}

export function accountsTool(db: DB, project: Project): string {
  const accs = listAccounts(db, { projectId: project.id });
  if (!accs.length) return "Für dieses Projekt ist noch kein Konto verbunden.";
  return accs.map((a) => `- ${PLATFORM_LABEL[a.platform]}: ${a.name}${a.status !== "active" ? " (muss neu verbunden werden)" : ""}`).join("\n");
}

export async function importTool(db: DB, project: Project): Promise<string> {
  const r = await importBacklog(db, project);
  const lines = [`${r.added} neu, ${r.updated} aktualisiert${r.missing ? `, ${r.missing} fehlen` : ""}.`];
  for (const e of r.errors) lines.push(`Problem: ${e}`);
  return lines.join("\n");
}

/** Short zur Freigabe einplanen – landet in „Warteschlange → Zur Freigabe“, nie direkt online. */
export async function proposeTool(
  db: DB,
  project: Project,
  input: { slug: string; zeit?: string; plattformen?: string[] },
): Promise<string> {
  await importBacklog(db, project);
  const content = db
    .select()
    .from(contents)
    .where(and(eq(contents.projectId, project.id), eq(contents.slug, input.slug)))
    .get();
  if (!content) throw new Error(`Kein Short „${input.slug}“ im Backlog. Liegt video.mp4 im Ordner backlog/${input.slug}/?`);

  const wanted = (input.plattformen ?? []).map((p) => p.toLowerCase()).filter((p): p is Platform => (PLATFORMS as readonly string[]).includes(p));
  let at: Date | undefined;
  if (input.zeit && input.zeit !== "naechster_slot") {
    at = new Date(input.zeit);
    if (Number.isNaN(at.getTime())) throw new Error(`Ungültige Zeit: ${input.zeit} (erwartet ISO 8601, z. B. 2026-11-10T09:00:00+01:00)`);
  }
  const r = planIntoNextSlot(db, project, content.id, { createdBy: "agent", platforms: wanted, at });
  if (!r.ok) {
    throw new Error(r.reason === "keine freie Posting-Zeit" ? "Kein freier Slot – gib eine Zeit an (ISO 8601) oder lege Posting-Zeiten an." : `Nicht möglich: ${r.reason}.`);
  }
  const tz = getSettings(db).timezone;
  return `„${content.title}“ ist zur Freigabe eingeplant für ${describePlan(r, tz)}. Veröffentlicht wird erst nach Freigabe in der App.`;
}

/* ---------- Zahlen und Erkenntnisse (Phase 5) ---------- */

export function statsTool(db: DB, project: Project, days = 30): string {
  return statsText(db, project.id, days, getSettings(db).timezone);
}

export function learningsTool(db: DB, project: Project): string {
  const all = listLearnings(db, project.id);
  if (!all.length) return "Noch keine Erkenntnisse.";
  const group = (status: string, title: string) => {
    const list = all.filter((l) => l.status === status);
    return list.length ? [`${title}:`, ...list.map((l) => `- ${l.text}${l.reason ? ` (Begründung: ${l.reason})` : ""}`)].join("\n") : "";
  };
  return [
    group("accepted", "Bestätigt – gelten für jeden neuen Short"),
    group("proposed", "Vorgeschlagen – wartet auf Bestätigung"),
    group("rejected", "Abgelehnt – nicht erneut vorschlagen"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Vorschlag – gilt erst, wenn der Mensch ihn in der App bestätigt. */
export function proposeLearningTool(db: DB, project: Project, input: { text: string; begruendung: string }): string {
  const rejected = listLearnings(db, project.id, ["rejected"]).some((l) => l.text.toLowerCase() === input.text.trim().toLowerCase());
  if (rejected) return "Diese Erkenntnis wurde schon abgelehnt – bitte nicht erneut vorschlagen.";
  const l = proposeLearning(db, project.id, input.text, input.begruendung);
  if (!l) return "Gibt es schon (bestätigt oder vorgeschlagen).";
  return `Vorgeschlagen: „${l.text}“. Sie gilt erst, wenn der Mensch sie unter „Zahlen“ in der App bestätigt.`;
}

/* ---------- Stimmen (ElevenLabs) ---------- */

const NO_KEY = "Keine Stimmen eingerichtet: In der App unter Einstellungen → Stimmen einen ElevenLabs-API-Schlüssel hinterlegen. Bis dahin Shorts ohne Sprecher bauen.";

export async function voicesTool(db: DB, project: Project): Promise<string> {
  const key = await getElevenLabsKey(db);
  if (!key) return NO_KEY;
  const voices = await listVoices(key);
  const { main, second } = project.voices;
  const lines = [
    `Hauptstimme des Projekts (Erzähler, Assistent): ${main ? `${main.name} (${main.id})` : "nicht gewählt – Projekt → Einstellungen → Stimmen"}`,
    `Zweite Stimme (Gegenüber im Dialog, z. B. Anrufer): ${second ? `${second.name} (${second.id})` : "nicht gewählt"}`,
    "",
    `Alle Stimmen im ElevenLabs-Konto (${voices.length}):`,
    ...voices.slice(0, 60).map((v) => `- ${v.name} (${v.id})${describeVoice(v) ? ` – ${describeVoice(v)}` : ""}`),
  ];
  if (voices.length > 60) lines.push(`… und ${voices.length - 60} weitere`);
  return lines.join("\n");
}

/** Dateiname ohne Pfad und Sonderzeichen („../x y“ → „x-y“). */
export function voiceFileName(name: string | undefined): string {
  const base = (name ?? "")
    .toLowerCase()
    .replace(/\.mp3$/, "")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base || `stimme-${Date.now()}`;
}

async function resolveVoice(key: string, project: Project, wanted: string | undefined): Promise<{ id: string; name: string }> {
  const w = (wanted ?? "haupt").trim();
  if (w === "haupt" || w === "") {
    if (!project.voices.main) throw new VoiceError("Keine Hauptstimme gewählt (Projekt → Einstellungen → Stimmen). Gib eine Stimme aus stimmen_liste an.");
    return project.voices.main;
  }
  if (w === "zweit") {
    if (!project.voices.second) throw new VoiceError("Keine zweite Stimme gewählt (Projekt → Einstellungen → Stimmen). Gib eine Stimme aus stimmen_liste an.");
    return project.voices.second;
  }
  const voices: Voice[] = await listVoices(key);
  const v = voices.find((x) => x.id === w) ?? voices.find((x) => x.name.toLowerCase() === w.toLowerCase());
  if (!v) throw new VoiceError(`Stimme „${w}“ nicht gefunden. Nimm „haupt“, „zweit“ oder eine ID aus stimmen_liste.`);
  return { id: v.id, name: v.name };
}

const sec = (n: number) => n.toFixed(2).replace(".", ",");

/** Sprechertext erzeugen und als MP3 in studio/public/stimme/ ablegen. */
export async function speakTool(
  db: DB,
  project: Project,
  input: { text: string; datei: string; stimme?: string; tempo?: number },
): Promise<string> {
  const key = await getElevenLabsKey(db);
  if (!key) throw new VoiceError(NO_KEY);
  const voice = await resolveVoice(key, project, input.stimme);
  const model = getSettings(db).voice.model;
  const speech = await synthesize(key, { voiceId: voice.id, text: input.text, modelId: model, speed: input.tempo });

  const name = voiceFileName(input.datei);
  const dir = path.join(project.folder, "studio", "public", "stimme");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.mp3`);
  fs.writeFileSync(file, speech.audio);
  const duration = speech.durationSec ?? (await probeVideo(file)).durationSec;
  fs.writeFileSync(
    path.join(dir, `${name}.json`),
    JSON.stringify({ text: input.text.trim(), voice, model, durationSec: duration, words: speech.words }, null, 2) + "\n",
  );

  const lines = [
    `Gespeichert: studio/public/stimme/${name}.mp3 – in der Szenen-JSON: "voice": "stimme/${name}.mp3"`,
    duration != null ? `Dauer: ${sec(duration)} s → Szene bzw. Abstand zur nächsten Dialogzeile mindestens ${sec(duration + 0.4)} s.` : "Dauer unbekannt – mit ffprobe prüfen.",
    `Stimme: ${voice.name} · Modell: ${model}`,
  ];
  if (speech.words.length) {
    const shown = speech.words.slice(0, 80).map((w) => `${sec(w.start)} ${w.word}`);
    lines.push(`Wörter (Start in s): ${shown.join(" · ")}${speech.words.length > 80 ? " …" : ""}`);
  }
  lines.push("Denk an \"aiGenerated\": true in meta.json (KI-Stimme).");
  return lines.join("\n");
}
