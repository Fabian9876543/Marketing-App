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
import { accountsTool, backlogTool, briefingTool, freeSlotsTool, importTool, proposeTool } from "../src/lib/studio/tools";

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

await server.connect(new StdioServerTransport());
