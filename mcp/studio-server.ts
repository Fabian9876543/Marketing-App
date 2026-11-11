/**
 * MCP-Server „studio“: Werkzeuge für Claude Code im Marketing Studio.
 * Wird pro Studio-Auftrag gestartet (stdio), mit STUDIO_PROJECT_ID für das Projekt.
 */
// stdout gehört dem MCP-Protokoll – alle Logs nach stderr.
console.log = console.error;

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getDb } from "../src/lib/db/client";
import { getProject } from "../src/lib/projects";
import { downloadTool, uploadTool } from "../src/lib/studio/files";
import { adLibraryTool, framesTool, instagramTool, patternTool, researchSourcesTool, transcriptTool, youtubeTool } from "../src/lib/studio/research-tools";
import {
  accountsTool,
  backlogTool,
  briefingTool,
  freeSlotsTool,
  importTool,
  learningsTool,
  proposeLearningTool,
  proposeTool,
  speakTool,
  statsTool,
  voicesTool,
} from "../src/lib/studio/tools";

const projectId = Number(process.env.STUDIO_PROJECT_ID);
const db = getDb();
const project = () => {
  const p = getProject(db, projectId);
  if (!p) throw new Error(`Projekt ${projectId} nicht gefunden`);
  return p;
};

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const safe = (fn: () => string | Promise<string>) => async () => {
  try {
    return text(await fn());
  } catch (err) {
    return { ...text(`Fehler: ${(err as Error).message}`), isError: true };
  }
};

const server = new McpServer({ name: "studio", version: "1.0.0" });

server.registerTool(
  "projekt_briefing",
  { title: "Projekt-Briefing", description: "Briefing, Regeln und Referenzen des Projekts (Inhalt von PROJEKT.md) plus wichtige Ordner." },
  safe(() => briefingTool(project())),
);

server.registerTool(
  "backlog_liste",
  { title: "Backlog", description: "Alle Shorts im Backlog des Projekts mit Status (geplant, veröffentlicht, noch nicht geplant)." },
  safe(() => backlogTool(db, project())),
);

server.registerTool(
  "backlog_einlesen",
  { title: "Backlog einlesen", description: "Liest den Backlog-Ordner neu ein, damit neue Shorts in der App erscheinen. Nach dem Rendern aufrufen." },
  safe(() => importTool(db, project())),
);

server.registerTool(
  "freie_slots",
  {
    title: "Freie Posting-Zeiten",
    description: "Die nächsten freien Posting-Zeiten des Projekts.",
    inputSchema: { anzahl: z.number().int().min(1).max(20).optional().describe("Wie viele (Standard 5)") },
  },
  async ({ anzahl }) => safe(() => freeSlotsTool(db, project(), anzahl ?? 5))(),
);

server.registerTool(
  "konten_liste",
  { title: "Verbundene Konten", description: "Welche Social-Media-Konten in diesem Projekt verbunden sind." },
  safe(() => accountsTool(db, project())),
);

server.registerTool(
  "zur_freigabe_einplanen",
  {
    title: "Zur Freigabe einplanen",
    description:
      "Plant einen Short aus dem Backlog zur Freigabe ein. Er erscheint in der App unter „Warteschlange → Zur Freigabe“ und wird erst veröffentlicht, wenn der Mensch ihn freigibt.",
    inputSchema: {
      slug: z.string().describe("Ordnername im Backlog, z. B. 2026-11-10-anruf-um-22-uhr"),
      zeit: z.string().optional().describe("ISO-8601-Zeit oder „naechster_slot“ (Standard)"),
      plattformen: z.array(z.string()).optional().describe("Nur diese Plattformen: youtube, instagram, tiktok, linkedin (Standard: alle verbundenen)"),
    },
  },
  async (args) => safe(() => proposeTool(db, project(), args))(),
);

server.registerTool(
  "statistik",
  {
    title: "Zahlen der Posts",
    description:
      "Views, Likes, Kommentare und Shares aller Posts des Projekts (alle Plattformen) mit Bewertung gegen den Median des jeweiligen Kanals: stark, normal, schwach oder zu frisch. Bei eigenen Shorts steht der Ordnername im Backlog dabei.",
    inputSchema: { tage: z.number().int().min(1).max(90).optional().describe("Zeitraum in Tagen (Standard 30, höchstens 90)") },
  },
  async ({ tage }) => safe(() => statsTool(db, project(), tage ?? 30))(),
);

server.registerTool(
  "erkenntnisse",
  { title: "Erkenntnisse", description: "Bestätigte, vorgeschlagene und abgelehnte Erkenntnisse aus den Zahlen." },
  safe(() => learningsTool(db, project())),
);

server.registerTool(
  "erkenntnis_vorschlagen",
  {
    title: "Erkenntnis vorschlagen",
    description:
      "Schlägt eine Erkenntnis aus den Zahlen vor – als konkrete Anweisung für künftige Shorts. Sie gilt erst, wenn der Mensch sie in der App bestätigt; dann steht sie in PROJEKT.md.",
    inputSchema: {
      text: z.string().min(5).max(300).describe("Anweisung für künftige Shorts, z. B. „Hook als Frage in den ersten 2 Sekunden“"),
      begruendung: z.string().max(500).describe("Woran man es in den Zahlen sieht (welche Posts, welcher Faktor)"),
    },
  },
  async (args) => safe(() => proposeLearningTool(db, project(), args))(),
);

server.registerTool(
  "stimmen_liste",
  {
    title: "Stimmen",
    description: "Die Stimmen des Projekts (Hauptstimme, zweite Stimme) und alle Stimmen im ElevenLabs-Konto mit Beschreibung.",
  },
  safe(() => voicesTool(db, project())),
);

server.registerTool(
  "stimme_erzeugen",
  {
    title: "Sprechertext erzeugen",
    description:
      "Erzeugt mit ElevenLabs eine MP3 aus Text und legt sie in studio/public/stimme/ ab. Liefert den Pfad für die Szenen-JSON, die Dauer und Zeitstempel je Wort. Kostet Zeichen-Guthaben – erst den Text fertig formulieren, dann erzeugen.",
    inputSchema: {
      text: z.string().min(1).max(1000).describe("Was gesprochen wird (Deutsch, kurze Sätze, so wie man spricht)"),
      datei: z.string().min(1).max(100).describe("Dateiname ohne Endung, z. B. 2026-11-08-termin-hook oder 2026-11-08-termin-dialog-1"),
      stimme: z.string().optional().describe("„haupt“ (Standard), „zweit“ oder Name bzw. ID aus stimmen_liste"),
      tempo: z.number().min(0.7).max(1.2).optional().describe("Sprechtempo, 1 = normal"),
    },
  },
  async (args) => safe(() => speakTool(db, project(), args))(),
);

server.registerTool(
  "datei_laden",
  {
    title: "Bild/Video/Audio herunterladen",
    description:
      "Lädt ein Bild, Video oder Audio von einer https-Adresse (z. B. ein Higgsfield-Ergebnis) nach studio/public/ki/ und liefert den Pfad für die Szenen-JSON.",
    inputSchema: {
      url: z.string().url().describe("https-Adresse der Datei"),
      datei: z.string().min(1).max(100).describe("Dateiname ohne Endung, z. B. 2026-11-10-praxis-intro"),
    },
  },
  async (args) => safe(() => downloadTool(project(), args))(),
);

server.registerTool(
  "datei_hochladen",
  {
    title: "Datei hochladen",
    description:
      "Lädt ein Bild, Video oder Audio aus dem Projekt (referenzen/, backlog/ oder studio/public/) per PUT an eine vorbereitete Upload-Adresse, z. B. die upload_url von Higgsfields media_upload. Danach beim Dienst bestätigen (media_confirm).",
    inputSchema: {
      datei: z.string().min(1).describe("Pfad im Projektordner, z. B. referenzen/screenshot/start.png"),
      upload_url: z.string().url().describe("Vorbereitete https-Upload-Adresse"),
      content_type: z.string().optional().describe("MIME-Typ, wie bei media_upload angegeben (Standard: aus der Endung)"),
    },
  },
  async (args) => safe(() => uploadTool(project(), args))(),
);

/* ---------- Recherche ---------- */

server.registerTool(
  "recherche_quellen",
  {
    title: "Recherche-Quellen",
    description: "Stichwörter, Konkurrenz-Konten und Beispiele (referenzen, Inspiration) des Projekts – und welche Recherche-Werkzeuge verfügbar sind.",
  },
  safe(() => researchSourcesTool(db, project())),
);

server.registerTool(
  "werbebibliothek_suchen",
  {
    title: "Meta-Werbebibliothek durchsuchen",
    description:
      "Sucht Anzeigen auf Facebook und Instagram, die in Deutschland laufen oder liefen: Texte, Überschriften, Laufzeit, Plattformen, EU-Reichweite, Zielgruppe und ein Link zur Anzeige. Lange laufende Anzeigen funktionieren meist. Bilder und Videos liefert die Schnittstelle nicht.",
    inputSchema: {
      suchbegriff: z.string().max(100).optional().describe("Stichwort, z. B. „Telefonassistent Praxis“"),
      seiten_ids: z.array(z.string()).max(10).optional().describe("Facebook-Seiten-IDs eines Werbetreibenden"),
      nur_aktive: z.boolean().optional().describe("Nur laufende Anzeigen (Standard: ja)"),
      anzahl: z.number().int().min(1).max(100).optional().describe("Wie viele (Standard 40)"),
    },
  },
  async (args) => safe(() => adLibraryTool(db, project(), args))(),
);

server.registerTool(
  "instagram_konto_ansehen",
  {
    title: "Instagram-Konto ansehen",
    description:
      "Die letzten Beiträge eines öffentlichen Instagram-Business- oder Creator-Kontos mit Views, Likes und Kommentaren – sortiert danach, was im Verhältnis zum Konto am besten lief.",
    inputSchema: {
      benutzername: z.string().min(1).max(60).describe("Instagram-Name, z. B. praxis.digital"),
      anzahl: z.number().int().min(5).max(50).optional().describe("Wie viele Beiträge (Standard 30)"),
    },
  },
  async (args) => safe(() => instagramTool(db, project(), args))(),
);

server.registerTool(
  "youtube_shorts_suchen",
  {
    title: "YouTube-Shorts suchen",
    description: "Öffentliche YouTube-Shorts zu einem Suchbegriff (Deutschland), nach Views sortiert. Kostet einen Teil des YouTube-Tageskontingents – sparsam nutzen.",
    inputSchema: {
      suchbegriff: z.string().min(2).max(100),
      tage: z.number().int().min(7).max(365).optional().describe("Zeitraum in Tagen (Standard 90)"),
    },
  },
  async (args) => safe(() => youtubeTool(db, project(), args))(),
);

server.registerTool(
  "beispiel_einzelbilder",
  {
    title: "Beispielvideo in Bilder zerlegen",
    description:
      "Zerlegt ein Beispielvideo aus referenzen/ in Einzelbilder: die ersten Sekunden einzeln (Hook) und eine Übersicht über das ganze Video. Die Bilder danach mit Read ansehen.",
    inputSchema: { datei: z.string().min(1).describe("Pfad im Projekt, z. B. referenzen/inspiration/beispiel.mp4") },
  },
  async (args) => safe(() => framesTool(project(), args))(),
);

server.registerTool(
  "beispiel_transkript",
  {
    title: "Gesprochenes mitschreiben",
    description: "Schreibt mit, was in einem Beispielvideo oder einer Audiodatei aus referenzen/ gesprochen wird – mit Zeitangaben (ElevenLabs).",
    inputSchema: { datei: z.string().min(1).describe("Pfad im Projekt, z. B. referenzen/inspiration/beispiel.mp4") },
  },
  async (args) => safe(() => transcriptTool(db, project(), args))(),
);

server.registerTool(
  "muster_vorschlagen",
  {
    title: "Muster vorschlagen",
    description:
      "Schlägt ein Muster aus der Recherche vor – als konkrete Anweisung für eigene Shorts (z. B. „Demo-Anruf ab Sekunde 2 statt Erklärung“). Gilt erst, wenn der Mensch es bestätigt; dann steht es in PROJEKT.md.",
    inputSchema: {
      text: z.string().min(5).max(300),
      begruendung: z.string().max(600).describe("Welche Beispiele, welcher Hinweis auf Erfolg (Laufzeit, Views im Verhältnis zum Konto …)"),
    },
  },
  async (args) => safe(() => patternTool(db, project(), args))(),
);

await server.connect(new StdioServerTransport());
