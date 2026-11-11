import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { and, asc, eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { projectReferences, type Project } from "../db/schema";
import { listLearnings, proposeLearning } from "../learnings";
import { probeVideo } from "../media";
import { adLibraryTokens, days, searchAdsWithAnyToken } from "../research/meta";
import { instagramProfile, researchAccount, searchYoutubeShorts } from "../research/social";
import { getElevenLabsKey, transcribe } from "../voice/elevenlabs";
import { FileToolError, mimeOf, resolveProjectMedia, safeName } from "./files";

/**
 * Werkzeuge für die Recherche im Studio: Werbebibliothek, Konkurrenz auf Instagram, YouTube-Shorts,
 * Beispielvideos in Einzelbilder zerlegen und mitschreiben, Muster vorschlagen.
 * Fremde Inhalte werden nur ausgewertet, nie übernommen.
 */

const execFileAsync = promisify(execFile);
const fmt = (n: number | null | undefined) => (n == null ? "–" : n.toLocaleString("de-DE"));
const short = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const ratio = (r: number | null) => (r == null ? "" : ` · ×${r.toFixed(1).replace(".", ",")} des Kontos`);

/* ---------- Überblick ---------- */

export async function researchSourcesTool(db: DB, project: Project): Promise<string> {
  const r = project.research;
  const refs = db
    .select()
    .from(projectReferences)
    .where(and(eq(projectReferences.projectId, project.id), eq(projectReferences.category, "inspiration")))
    .orderBy(asc(projectReferences.id))
    .all();
  const meta = (await adLibraryTokens(db)).length > 0;
  const ig = Boolean(researchAccount(db, "instagram", project.id));
  const yt = Boolean(researchAccount(db, "youtube", project.id));
  const voice = Boolean(await getElevenLabsKey(db).catch(() => null));
  const lines = [
    `Stichwörter: ${r.keywords?.length ? r.keywords.join(", ") : "keine – im Briefing Kernbotschaften/Zielgruppe nutzen"}`,
    `Instagram-Konten: ${r.instagram?.length ? r.instagram.map((u) => `@${u}`).join(", ") : "keine"}`,
    `Facebook-Seiten (IDs für die Werbebibliothek): ${r.metaPages?.length ? r.metaPages.join(", ") : "keine"}`,
    "",
    "Verfügbar:",
    `- werbebibliothek_suchen: ${meta ? "ja" : "nein (kein Meta-Zugang)"}`,
    `- instagram_konto_ansehen: ${ig ? "ja" : "nein (kein Instagram-Konto verbunden)"}`,
    `- youtube_shorts_suchen: ${yt ? "ja" : "nein (kein YouTube-Konto verbunden)"}`,
    `- beispiel_transkript: ${voice ? "ja" : "nein (kein ElevenLabs-Schlüssel)"}`,
    "- beispiel_einzelbilder: ja",
    "",
    `Beispiele unter referenzen (Inspiration): ${refs.length ? "" : "keine"}`,
    ...refs.map((x) => `- ${x.title}: ${x.kind === "file" ? x.filePath : x.kind === "link" ? x.url : "Notiz"}${x.note ? ` – ${short(x.note, 200)}` : ""}`),
  ];
  const known = listLearnings(db, project.id).filter((l) => l.source === "research");
  if (known.length) {
    lines.push("", "Bisherige Muster:", ...known.map((l) => `- [${{ proposed: "vorgeschlagen", accepted: "bestätigt", rejected: "abgelehnt" }[l.status]}] ${l.text}`));
  }
  return lines.join("\n");
}

/* ---------- Werbebibliothek ---------- */

export async function adLibraryTool(
  db: DB,
  _project: Project,
  input: { suchbegriff?: string; seiten_ids?: string[]; nur_aktive?: boolean; anzahl?: number },
  now = new Date(),
): Promise<string> {
  const { ads, via } = await searchAdsWithAnyToken(db, {
    terms: input.suchbegriff,
    pageIds: input.seiten_ids,
    activeOnly: input.nur_aktive ?? true,
    limit: input.anzahl ?? 40,
  });
  if (!ads.length) return `Keine Anzeigen in Deutschland gefunden (${input.suchbegriff ?? input.seiten_ids?.join(", ")}).`;
  // Lange laufende Anzeigen zuerst: wer schlecht läuft, schaltet ab
  const runtime = (a: (typeof ads)[number]) => (a.start ? days(a.start, a.stop ?? now) : 0);
  const sorted = [...ads].sort((a, b) => runtime(b) - runtime(a));
  const byPage = new Map<string, number>();
  for (const a of ads) byPage.set(a.pageName, (byPage.get(a.pageName) ?? 0) + 1);
  const lines = [
    `${ads.length} Anzeigen in Deutschland (Zugang: ${via}). Sortiert nach Laufzeit – lange laufende Anzeigen funktionieren meist.`,
    `Werbetreibende: ${[...byPage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([p, c]) => `${p} (${c})`).join(", ")}`,
    "",
  ];
  for (const a of sorted) {
    lines.push(
      `- ${a.pageName} · läuft ${a.stop ? "lief" : "seit"} ${runtime(a)} Tagen${a.start ? ` (ab ${a.start.toISOString().slice(0, 10)})` : ""} · ${a.platforms.join("/").toLowerCase() || "?"}` +
        (a.euReach != null ? ` · EU-Reichweite ${fmt(a.euReach)}` : "") +
        (a.targetAges.length ? ` · Alter ${a.targetAges.join("–")}` : "") +
        (a.targetGender && a.targetGender !== "All" ? ` · ${a.targetGender}` : ""),
    );
    if (a.bodies[0]) lines.push(`  Text: „${short(a.bodies[0], 400)}“`);
    if (a.titles[0]) lines.push(`  Überschrift: „${short(a.titles[0], 120)}“`);
    if (a.bodies.length > 1) lines.push(`  (${a.bodies.length} Textvarianten – wird getestet)`);
    lines.push(`  Ansehen: ${a.link}`);
  }
  return lines.join("\n");
}

/* ---------- Instagram ---------- */

export async function instagramTool(db: DB, project: Project, input: { benutzername: string; anzahl?: number }): Promise<string> {
  const p = await instagramProfile(db, project.id, input.benutzername, input.anzahl ?? 30);
  const lines = [
    `@${p.username}${p.name ? ` (${p.name})` : ""} · ${fmt(p.followers)} Follower · ${fmt(p.mediaCount)} Beiträge`,
    p.biography ? `Bio: ${short(p.biography, 200)}` : "",
    `Letzte ${p.posts.length} Beiträge, sortiert nach Views bzw. Likes im Verhältnis zum Median des Kontos:`,
  ].filter(Boolean);
  const sorted = [...p.posts].sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));
  for (const m of sorted) {
    lines.push(
      `- ${m.timestamp.toISOString().slice(0, 10)} · ${m.type} · ${fmt(m.views)} Views · ${fmt(m.likes)} Likes · ${fmt(m.comments)} Kommentare${ratio(m.ratio)}`,
      `  „${short(m.caption || "(ohne Text)", 300)}“${m.permalink ? ` · ${m.permalink}` : ""}`,
    );
  }
  lines.push("", "Hinweis: Fremde Videos nicht herunterladen. Visuelle Analyse nur mit Beispielen, die der Mensch in referenzen/ abgelegt hat.");
  return lines.join("\n");
}

/* ---------- YouTube ---------- */

export async function youtubeTool(db: DB, project: Project, input: { suchbegriff: string; tage?: number }): Promise<string> {
  const list = await searchYoutubeShorts(db, project.id, input.suchbegriff, input.tage ?? 90);
  if (!list.length) return `Keine Shorts zu „${input.suchbegriff}“ gefunden.`;
  return [
    `${list.length} Shorts zu „${input.suchbegriff}“ (letzte ${input.tage ?? 90} Tage, Deutschland), nach Views:`,
    ...list.map(
      (v) =>
        `- ${fmt(v.views)} Views · ${fmt(v.likes)} Likes · ${fmt(v.comments)} Kommentare · ${v.durationSec ?? "?"} s · ${v.channel} · „${short(v.title, 120)}“ · ${v.url}`,
    ),
  ].join("\n");
}

/* ---------- Beispiele: Einzelbilder und Transkript ---------- */

const ANALYSIS_ROOTS = ["referenzen", "studio/public", "backlog"];

/** Zerlegt ein Beispielvideo in Bilder: die ersten Sekunden einzeln (Hook) und eine Übersicht über das ganze Video. */
export async function framesTool(project: Project, input: { datei: string }): Promise<string> {
  const { file, rel, ext } = resolveProjectMedia(project, input.datei, ANALYSIS_ROOTS);
  if (!mimeOf(ext).startsWith("video/")) throw new FileToolError("Einzelbilder gibt es nur von Videos – Bilder direkt mit Read ansehen.");
  const info = await probeVideo(file);
  const duration = info.durationSec ?? 0;
  const dir = path.join(project.folder, "recherche", "analyse", safeName(path.basename(file), "beispiel"));
  fs.mkdirSync(dir, { recursive: true });
  const ffmpeg = (args: string[]) => execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { timeout: 120_000 });

  const hook: string[] = [];
  for (const t of [0, 0.5, 1, 1.5, 2, 3]) {
    if (duration && t >= duration) break;
    const out = path.join(dir, `hook-${t.toFixed(1).replace(".", "_")}s.jpg`);
    try {
      await ffmpeg(["-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "4", out]);
      if (fs.existsSync(out)) hook.push(`${t.toFixed(1).replace(".", ",")} s: ${path.relative(project.folder, out)}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new FileToolError("ffmpeg fehlt (brew install ffmpeg)");
    }
  }
  let sheet: string | null = null;
  if (duration > 0) {
    const out = path.join(dir, "uebersicht.jpg");
    const fps = Math.max(0.05, 16 / duration);
    try {
      await ffmpeg(["-i", file, "-vf", `fps=${fps.toFixed(4)},scale=270:-2,tile=4x4`, "-frames:v", "1", "-q:v", "4", out]);
      if (fs.existsSync(out)) sheet = path.relative(project.folder, out);
    } catch {
      sheet = null;
    }
  }
  const step = duration ? duration / 16 : 0;
  return [
    `${rel}: ${duration ? `${duration.toFixed(1).replace(".", ",")} s` : "Dauer unbekannt"}${info.width && info.height ? `, ${info.width}×${info.height}` : ""}`,
    "Erste Sekunden (Hook) – mit Read ansehen:",
    ...hook.map((h) => `- ${h}`),
    sheet ? `Übersicht über das ganze Video (16 Bilder, alle ${step.toFixed(1).replace(".", ",")} s, von links oben zeilenweise): ${sheet}` : "Keine Übersicht erstellt.",
    "Achte auf: Hook in den ersten 2 Sekunden, Textgröße und -position, Schnitte pro Sekunde, Aufbau, Länge, Handlungsaufforderung am Ende.",
  ].join("\n");
}

const sec = (n: number) => n.toFixed(1).replace(".", ",");

/** Schreibt mit, was in einem Beispielvideo gesprochen wird (ElevenLabs), mit Zeitangaben. */
export async function transcriptTool(db: DB, project: Project, input: { datei: string }): Promise<string> {
  const key = await getElevenLabsKey(db);
  if (!key) throw new FileToolError("Für Transkripte unter Einstellungen → Stimmen einen ElevenLabs-Schlüssel hinterlegen.");
  const { file, rel, ext } = resolveProjectMedia(project, input.datei, ANALYSIS_ROOTS);
  if (mimeOf(ext).startsWith("image/")) throw new FileToolError("Bilder haben keinen Ton.");
  // Nur die Tonspur hochladen (kleiner); ohne ffmpeg die ganze Datei
  const dir = path.join(project.folder, "recherche", "analyse", safeName(path.basename(file), "beispiel"));
  fs.mkdirSync(dir, { recursive: true });
  const audio = path.join(dir, "ton.mp3");
  let upload = { data: fs.readFileSync(file), name: path.basename(file), mime: mimeOf(ext) };
  try {
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", audio], { timeout: 120_000 });
    if (fs.existsSync(audio)) upload = { data: fs.readFileSync(audio), name: "ton.mp3", mime: "audio/mpeg" };
  } catch {
    // ohne ffmpeg weiter mit der Originaldatei
  }
  const t = await transcribe(key, upload.data, upload.name, upload.mime);
  if (!t.text) return `${rel}: Kein gesprochener Text erkannt (nur Musik oder Stille).`;
  // In Abschnitte von etwa 3 Sekunden gliedern
  const parts: string[] = [];
  let start = t.words[0]?.start ?? 0;
  let buf: string[] = [];
  for (const w of t.words) {
    if (buf.length && w.start - start >= 3) {
      parts.push(`${sec(start)} s: ${buf.join(" ")}`);
      buf = [];
      start = w.start;
    }
    buf.push(w.word);
  }
  if (buf.length) parts.push(`${sec(start)} s: ${buf.join(" ")}`);
  fs.writeFileSync(path.join(dir, "transkript.txt"), `${t.text}\n`);
  return [`${rel} – Sprache: ${t.language ?? "?"}`, ...(parts.length ? parts : [t.text])].join("\n");
}

/* ---------- Muster ---------- */

export function patternTool(db: DB, project: Project, input: { text: string; begruendung: string }): string {
  const rejected = listLearnings(db, project.id, ["rejected"]).some((l) => l.text.toLowerCase() === input.text.trim().toLowerCase());
  if (rejected) return "Dieses Muster wurde schon abgelehnt – bitte nicht erneut vorschlagen.";
  const l = proposeLearning(db, project.id, input.text, input.begruendung, "research");
  if (!l) return "Gibt es schon (bestätigt oder vorgeschlagen).";
  return `Vorgeschlagen: „${l.text}“. Es gilt erst, wenn der Mensch es unter „Recherche“ in der App bestätigt.`;
}
