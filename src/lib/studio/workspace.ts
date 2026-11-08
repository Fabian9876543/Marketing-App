import fs from "node:fs";
import path from "node:path";
import type { Project } from "../db/schema";
import { ensureProjectFolders } from "../projects";

/** Marker: Diese Datei verwaltet das Marketing Studio (sonst nicht überschreiben). */
const MARKER = "<!-- marketing-studio:auto -->";

const appDir = () => process.env.STUDIO_APP_DIR || process.cwd();
export const templateDir = () => path.join(appDir(), "vorlagen", "studio");
export const studioDir = (p: Pick<Project, "folder">) => path.join(p.folder, "studio");

/**
 * Befehle, die Claude im Studio ohne Rückfrage ausführen darf. Alles andere wird abgelehnt.
 * Kein „Bash(*)“, kein rm, kein git push, kein curl.
 */
export const ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "TodoWrite",
  "Bash(npm install*)",
  "Bash(npm run *)",
  "Bash(npx remotion *)",
  "Bash(ffmpeg *)",
  "Bash(ffprobe *)",
  "Bash(mkdir *)",
  "Bash(cp *)",
  "Bash(ls *)",
  "Bash(du *)",
  "Bash(node scripts/*)",
  "Bash(cd *)",
  "mcp__studio",
];

export const DENIED_TOOLS = ["Bash(rm *)", "Bash(git push*)", "Bash(curl *)", "Bash(wget *)", "Bash(sudo *)", "WebFetch", "WebSearch"];

export type StudioStatus = {
  /** Vorlage liegt in <projekt>/studio */
  template: boolean;
  /** npm install ist gelaufen */
  installed: boolean;
  /** CLAUDE.md und .claude/settings.json vorhanden */
  instructions: boolean;
};

export function studioStatus(project: Project): StudioStatus {
  const dir = studioDir(project);
  return {
    template: fs.existsSync(path.join(dir, "src", "Short.tsx")),
    installed: fs.existsSync(path.join(dir, "node_modules", "remotion")),
    instructions: fs.existsSync(path.join(project.folder, "CLAUDE.md")) && fs.existsSync(path.join(project.folder, ".claude", "settings.json")),
  };
}

/**
 * Richtet das Studio im Projektordner ein:
 * - studio/      Video-Vorlage (nur wenn noch nicht vorhanden – eigene Anpassungen bleiben erhalten)
 * - CLAUDE.md    Arbeitsanweisung für Claude Code (wird aktualisiert, solange der Marker drinsteht)
 * - .claude/settings.json  erlaubte und verbotene Befehle
 */
export function setupStudio(project: Project): StudioStatus {
  ensureProjectFolders(project);
  const dir = studioDir(project);
  if (!fs.existsSync(path.join(dir, "src", "Short.tsx"))) {
    fs.cpSync(templateDir(), dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
    // Markenfarbe aus dem Projekt übernehmen
    const brandFile = path.join(dir, "brand.json");
    const brand = JSON.parse(fs.readFileSync(brandFile, "utf8"));
    Object.assign(brand, { name: project.name, primary: project.color, url: project.website ? new URL(project.website).hostname.replace(/^www\./, "") : "" });
    fs.writeFileSync(brandFile, JSON.stringify(brand, null, 2) + "\n");
  }

  const claudeMd = path.join(project.folder, "CLAUDE.md");
  if (!fs.existsSync(claudeMd) || fs.readFileSync(claudeMd, "utf8").includes(MARKER)) {
    fs.writeFileSync(claudeMd, agentInstructions(project));
  }

  const settingsFile = path.join(project.folder, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  let existing: { permissions?: { allow?: string[]; deny?: string[] } } = {};
  try {
    existing = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  } catch {
    existing = {};
  }
  const merged = {
    ...existing,
    permissions: {
      ...existing.permissions,
      allow: [...new Set([...(existing.permissions?.allow ?? []), ...ALLOWED_TOOLS])],
      deny: [...new Set([...(existing.permissions?.deny ?? []), ...DENIED_TOOLS])],
    },
  };
  fs.writeFileSync(settingsFile, JSON.stringify(merged, null, 2) + "\n");
  return studioStatus(project);
}

/** Arbeitsanweisung für Claude Code im Projektordner. */
export function agentInstructions(project: Project): string {
  return `${MARKER}
# ${project.name} – Arbeitsanweisung für Claude Code

Du arbeitest im Projektordner von **${project.name}** für das Marketing Studio. Deine Aufgabe: kurze Hochkant-Videos (Shorts)
für Instagram Reels, TikTok, YouTube Shorts und LinkedIn – plus die Texte dazu. Veröffentlicht wird erst, wenn ein Mensch in der App freigibt.

> Diese Datei erzeugt das Marketing Studio. Wenn du sie selbst pflegen willst, entferne die erste Zeile (Marker) – dann bleibt sie unverändert.

## Lies zuerst
- \`PROJEKT.md\` – Briefing (Zielgruppe, Tonalität, Kernbotschaften, Regeln, Handlungsaufforderung) und alle Referenzen.
- \`referenzen/\` – Logo, Screenshots, Bildschirmaufnahmen, Musik, Dokumente. Echte Screens schlagen erfundene Grafiken.
- \`studio/README.md\` – wie die Video-Vorlage funktioniert (Szenen: hook, text, bild, video, dialog, cta).

## So entsteht ein Short
1. **Idee und Hook**: eine Botschaft pro Short, Hook höchstens ~8 Wörter. Passend zu Zielgruppe und Tonalität.
2. **Vorlage vorbereiten** (nur beim ersten Mal): \`cd studio && npm install\`. Marke in \`studio/brand.json\` prüfen (Farben, Logo, URL aus den Referenzen).
3. **Dateien kopieren**: benötigte Bilder/Videos/Musik aus \`referenzen/\` nach \`studio/public/\` kopieren (Originale nicht verschieben).
4. **Szenen schreiben**: JSON-Datei in \`studio/props/<slug>.json\` (Format: \`studio/README.md\`).
5. **Rendern**: \`cd studio && npx remotion render src/index.ts Short ../backlog/<ordner>/video.mp4 --props=props/<slug>.json\`
6. **Prüfen**: \`ffprobe\` – 1080 × 1920, 5–60 Sekunden. Bei Fehlern korrigieren und neu rendern.
7. **Texte**: \`meta.json\` in denselben Ordner schreiben (siehe unten).
8. **Einlesen**: Werkzeug \`backlog_einlesen\` aufrufen, damit der Short in der App erscheint.

## Befehle im Terminal – sonst werden sie blockiert
Im Studio beantwortet niemand Rückfragen. Jeder Befehl außerhalb dieser Liste wird automatisch abgelehnt:
\`npm install\`, \`npm run …\`, \`npx remotion …\`, \`ffmpeg …\`, \`ffprobe …\`, \`mkdir …\`, \`cp …\`, \`ls …\`, \`du …\`, \`node scripts/…\`, \`cd <ordner>\`.
- **Dateien nur mit den Werkzeugen Write und Edit anlegen oder ändern** – nie per python, \`node -e\`, sed, awk, \`cat >\` oder Heredoc.
- Pro Aufruf ein einfacher Befehl, höchstens \`cd <ordner> && <befehl>\`. Keine Variablen (\`$NAME\`, \`$(…)\`), keine Schleifen, keine Pipes (\`|\`) in andere Programme.
- Pfade und Namen immer ausschreiben, z. B. \`cd studio && npx remotion render src/index.ts Short ../backlog/2026-11-08-termin/video.mp4 --props=props/2026-11-08-termin.json\`.
- Suchen und Lesen mit den Werkzeugen Read, Glob und Grep statt mit cat, find oder grep im Terminal.

## Ausgabe-Vertrag
Jeder Short ist ein eigener Ordner: \`backlog/<JJJJ-MM-TT>-<kurzer-slug>/\` mit
- \`video.mp4\` (Pflicht)
- \`meta.json\` (Pflicht):
\`\`\`json
{
  "title": "Kurzer Titel (max. 100 Zeichen)",
  "description": "1–3 Sätze, die zum Video passen",
  "hashtags": ["Thema", "Marke"],
  "aiGenerated": false,
  "platforms": {
    "youtube": { "title": "…", "description": "…" },
    "instagram": { "caption": "…" },
    "tiktok": { "caption": "…" },
    "linkedin": { "text": "Etwas sachlicher, für Entscheider" }
  }
}
\`\`\`
- \`aiGenerated: true\`, sobald eine KI-Stimme oder realistische KI-Bilder vorkommen (Pflicht zur Kennzeichnung).
- \`cover.jpg\` (optional)

## Regeln
- **Nichts veröffentlichen.** Höchstens mit \`zur_freigabe_einplanen\` zur Freigabe vorschlagen – und nur, wenn darum gebeten wird.
- Nur Fakten aus \`PROJEKT.md\` und den Referenzen. Keine erfundenen Zahlen, Kundenstimmen, Preise oder Versprechen.
- Keine echten Personen, fremden Marken oder Musik ohne Lizenz. Gesprächsbeispiele sind erkennbar gestellt.
- Arbeite nur in diesem Projektordner. \`referenzen/\` nur lesen und kopieren, nie ändern oder löschen.
- Löschen ist nicht erlaubt. Alte Versionen eines Shorts einfach überschreiben.
- Antworte auf Deutsch und kurz: was du gemacht hast, welche Shorts (Ordner) entstanden sind, was offen ist.

## Aus den Zahlen lernen
- Der Abschnitt „Erkenntnisse aus den Zahlen“ in \`PROJEKT.md\` ist vom Menschen bestätigt und gilt für jeden neuen Short.
- Mit \`statistik\` siehst du, welche Posts im Vergleich zum Kanal stark oder schwach liefen – nutze das bei der Themenwahl.
- Neue Erkenntnisse nur mit \`erkenntnis_vorschlagen\` vorschlagen. Sie gelten erst nach Bestätigung in der App.

## Werkzeuge (MCP-Server „studio“)
- \`projekt_briefing\` – Briefing und Referenzen
- \`backlog_liste\` – vorhandene Shorts mit Status (doppelte Themen vermeiden)
- \`backlog_einlesen\` – nach dem Rendern aufrufen
- \`freie_slots\` – nächste freie Posting-Zeiten
- \`konten_liste\` – verbundene Plattformen
- \`zur_freigabe_einplanen\` – Short zur Freigabe vorschlagen (nie direkt online)
- \`statistik\` – Zahlen der Posts mit Bewertung gegen den Median des Kanals
- \`erkenntnisse\` – bestätigte, vorgeschlagene und abgelehnte Erkenntnisse
- \`erkenntnis_vorschlagen\` – neue Erkenntnis zur Bestätigung vorschlagen
`;
}
