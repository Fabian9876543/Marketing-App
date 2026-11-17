import type { DB } from "../db/client";
import { getSettings } from "../settings";
import { addArgs, addConnectorToClaude, checkConnectors, CONNECTORS, findConnector, mcpToolPrefix, type ConnectorCheck, type McpEntry } from "./mcp-connectors";

/**
 * Higgsfield (KI-Bilder und -Videos) läuft im Studio über den offiziellen MCP-Server von Higgsfield,
 * den Claude Code selbst verbindet (Anmeldung per Browser, Abrechnung über dein Higgsfield-Abo).
 */

export { mcpToolPrefix, parseMcpList, type McpEntry, type McpStatus } from "./mcp-connectors";

export const HIGGSFIELD_MCP_URL = CONNECTORS.higgsfield.url;
export const HIGGSFIELD_ADD_ARGS = addArgs("higgsfield");
export type HiggsfieldCheck = ConnectorCheck;

export const findHiggsfield = (entries: McpEntry[]) => findConnector(entries, "higgsfield");

/** Prüft die Verbindungen von Claude Code (Higgsfield und ElevenLabs) und liefert das Ergebnis für Higgsfield. */
export async function checkHiggsfield(db: DB, opts: { env?: NodeJS.ProcessEnv; now?: Date } = {}): Promise<HiggsfieldCheck> {
  return (await checkConnectors(db, opts)).higgsfield;
}

export const addHiggsfieldToClaude = (env?: NodeJS.ProcessEnv) => addConnectorToClaude("higgsfield", env);

export type HiggsfieldUse = { toolPrefix: string; maxCredits: number; unlim: boolean } | null;

/** Darf dieser Studio-Auftrag Higgsfield nutzen? (eingeschaltet, erkannt, und bei Automationen ausdrücklich erlaubt) */
export function higgsfieldFor(db: DB, session: { automationId: number | null; analysis: boolean; research?: boolean }): HiggsfieldUse {
  const h = getSettings(db).higgsfield;
  if (!h.enabled || !h.detected.server || h.detected.status === "missing") return null;
  if (session.analysis || session.research) return null;
  if (session.automationId && !h.inAutomations) return null;
  return { toolPrefix: mcpToolPrefix(h.detected.server), maxCredits: h.maxCredits, unlim: h.unlim };
}

/** Zusatz zum Systemauftrag, wenn Higgsfield freigegeben ist. */
export function higgsfieldAppend(use: NonNullable<HiggsfieldUse>): string {
  return [
    `Higgsfield ist freigegeben (Werkzeuge ${use.toolPrefix}__…) für KI-Bilder und -Videos.`,
    `Budget: höchstens ${use.maxCredits} Credits für diesen Auftrag – vor jeder Generierung die Kosten mit get_cost:true prüfen und mitzählen.`,
    use.unlim
      ? "Setze use_unlim:true (unbegrenzte Generierungen des Abos). Wird das abgelehnt, nimm Credits (use_unlim:false), solange das Budget reicht."
      : "Setze immer use_unlim:false.",
    "Ergebnisse mit datei_laden nach studio/public/ki/ holen; eigene Dateien für Referenzen mit media_upload, datei_hochladen und media_confirm hochladen. Videos im Format 9:16.",
  ].join(" ");
}
