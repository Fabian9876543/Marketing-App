import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Pfad zum Claude-Code-Programm (überschreibbar, z. B. für Tests). */
export const claudeBin = () => process.env.CLAUDE_BIN || "claude";

export type ClaudeInfo = { available: boolean; version: string | null; flags: Set<string>; error?: string };

let cache: { at: number; info: ClaudeInfo } | null = null;

/** Prüft, ob Claude Code installiert ist und welche Optionen es kennt (60 s zwischengespeichert). */
export async function claudeInfo(force = false): Promise<ClaudeInfo> {
  if (!force && cache && Date.now() - cache.at < 60_000) return cache.info;
  let info: ClaudeInfo;
  try {
    const [{ stdout: version }, { stdout: help }] = await Promise.all([
      execFileAsync(claudeBin(), ["--version"], { timeout: 15_000 }),
      execFileAsync(claudeBin(), ["--help"], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }),
    ]);
    info = { available: true, version: version.trim().split("\n")[0], flags: new Set(help.match(/--[a-z][a-z-]+/g) ?? []) };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    info = {
      available: false,
      version: null,
      flags: new Set(),
      error: e.code === "ENOENT" ? "Claude Code ist nicht installiert (Befehl „claude“ nicht gefunden)." : e.message,
    };
  }
  cache = { at: Date.now(), info };
  return info;
}

/** Übersetzt typische Fehlermeldungen von Claude Code in verständliche Hinweise. */
export function explainClaudeError(text: string): string {
  if (/invalid api key|please run \/login|not logged in|authentication|oauth token/i.test(text)) {
    return "Claude Code ist nicht angemeldet. Öffne ein Terminal, starte „claude“ und melde dich an – danach den Auftrag erneut senden.";
  }
  if (/rate limit|usage limit|quota/i.test(text)) {
    return "Dein Claude-Kontingent ist gerade aufgebraucht. Später erneut versuchen.";
  }
  if (/no conversation found|session.*not found/i.test(text)) {
    return "Die Claude-Sitzung dieses Chats gibt es nicht mehr. Starte einen neuen Chat.";
  }
  return text.trim().split("\n").slice(-5).join("\n") || "Unbekannter Fehler";
}
