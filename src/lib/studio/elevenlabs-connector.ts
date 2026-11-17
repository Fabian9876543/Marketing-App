import type { DB } from "../db/client";
import type { Project } from "../db/schema";
import { getSettings } from "../settings";
import { hasElevenLabsKey } from "../voice/elevenlabs";
import { addArgs, addConnectorToClaude, CONNECTORS, mcpToolPrefix, type ConnectorUse } from "./mcp-connectors";

/**
 * ElevenLabs ohne API-Schlüssel: Claude nutzt die ElevenLabs-Verbindung, die Claude Code selbst hat
 * (Connector aus claude.ai oder eigener MCP-Eintrag), und holt das Ergebnis mit datei_laden ins Projekt.
 * Ist in der App ein Schlüssel hinterlegt, bleibt es beim direkten Weg (stimme_erzeugen, mit Zeitstempeln je Wort).
 */

export const ELEVENLABS_MCP_URL = CONNECTORS.elevenlabs.url;
export const ELEVENLABS_ADD_ARGS = addArgs("elevenlabs");
export const addElevenLabsToClaude = (env?: NodeJS.ProcessEnv) => addConnectorToClaude("elevenlabs", env);

/** Ist die Verbindung eingeschaltet und erkannt? (unabhängig vom einzelnen Auftrag) */
export function elevenlabsConnectorReady(db: DB): string | null {
  const e = getSettings(db).elevenlabsMcp;
  return e.enabled && e.detected.server && e.detected.status !== "missing" ? e.detected.server : null;
}

/** Darf dieser Studio-Auftrag ElevenLabs über die Verbindung nutzen? */
export function elevenlabsFor(db: DB, project: Project, session: { automationId: number | null; analysis: boolean; research?: boolean }): ConnectorUse | null {
  const server = elevenlabsConnectorReady(db);
  if (!server || hasElevenLabsKey(db)) return null; // mit Schlüssel: direkter Weg über stimme_erzeugen
  if (session.analysis || session.research) return null;
  if (session.automationId && !getSettings(db).elevenlabsMcp.inAutomations) return null;
  const toolPrefix = mcpToolPrefix(server);
  return { toolPrefix, append: elevenlabsAppend(toolPrefix, project, getSettings(db).voice.model) };
}

/** Ablauf für Sprechertexte über die Verbindung – Zusatz zum Systemauftrag. */
export function elevenlabsAppend(toolPrefix: string, project: Pick<Project, "voices">, model: string): string {
  const { main, second } = project.voices;
  const voices = [main && `Hauptstimme „${main.name}“`, second && `zweite Stimme „${second.name}“`].filter(Boolean).join(", ");
  return [
    `ElevenLabs ist über die Verbindung freigegeben (Werkzeuge ${toolPrefix}__…) für Sprechertexte – nur wenn der Auftrag einen Sprecher braucht.`,
    "Ablauf pro Short: erst alle Sprechtexte fertig formulieren. creative_create_flow (Name = Ordnername des Shorts).",
    `Stimme mit creative_list_voices (languages ["de"]) finden${voices ? ` – ${voices} aus PROJEKT.md, per Name suchen` : ""}.`,
    `Je Szene bzw. Dialogzeile creative_generate_speech mit flow_id, voice_id, model_id "${model}" und generations_count 1.`,
    "Mit creative_get_flow_run_status warten, bis alles fertig ist, dann jede Audiodatei mit datei_laden (ordner \"stimme\") holen – das Ergebnis nennt Pfad und Dauer.",
    "Nie eine Erzeugung zum Wiederholen erneut aufrufen (kostet doppelt). In meta.json \"aiGenerated\": true.",
  ].join(" ");
}
