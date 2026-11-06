/**
 * Erste Einrichtung: prüft Voraussetzungen, legt Ordner und Datenbank an.
 *   pnpm local:setup
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { backlogDir } from "../src/lib/backlog";
import { getDb } from "../src/lib/db/client";
import { PLATFORM_LABEL } from "../src/lib/accounts";
import { appBaseUrl, dataDir, loadDotEnv } from "../src/lib/env";
import { missingEnv } from "../src/lib/publishing/oauth";
import { oauthProviders } from "../src/lib/publishing/registry";
import { getEncryptionKey } from "../src/lib/secrets/keystore";
import { getSettings } from "../src/lib/settings";

loadDotEnv();

const ok = (m: string) => console.log(`  ✓ ${m}`);
const warn = (m: string) => console.log(`  ! ${m}`);

function has(cmd: string, args = ["-version"]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log("\nFokuspilot Studio – Einrichtung\n");

  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) ok(`Node.js ${process.versions.node}`);
  else warn(`Node.js ${process.versions.node} – bitte Version 22 oder neuer installieren`);

  if (has("ffprobe")) ok("ffmpeg/ffprobe gefunden");
  else warn("ffmpeg fehlt – auf dem Mac: brew install ffmpeg (nötig für Videoinfos und später fürs Rendern)");

  if (has("claude", ["--version"])) ok("Claude Code gefunden (ab Phase 2 nötig)");
  else warn("Claude Code nicht gefunden – wird ab Phase 2 (Studio) gebraucht");

  if (!fs.existsSync(".env")) {
    fs.copyFileSync(".env.example", ".env");
    ok(".env aus .env.example angelegt – trage dort deine Google-Zugangsdaten ein");
  } else ok(".env vorhanden");

  const db = getDb();
  ok(`Datenbank bereit: ${path.join(dataDir(), "studio.db")}`);

  const { source } = await getEncryptionKey();
  ok(source === "keychain" ? "Schlüssel für Zugangsdaten liegt in der macOS-Keychain" : `Schlüssel für Zugangsdaten liegt in ${path.join(dataDir(), "secret.key")}`);

  const settings = getSettings(db);
  fs.mkdirSync(backlogDir(settings.contentDir), { recursive: true });
  ok(`Content-Ordner: ${settings.contentDir}`);

  for (const provider of Object.values(oauthProviders)) {
    const missing = missingEnv(provider);
    const label = PLATFORM_LABEL[provider.platform];
    if (!missing.length) ok(`${label}: Zugangsdaten eingetragen`);
    else warn(`${label}: noch nicht eingerichtet (${missing.join(", ")}) – siehe docs/SETUP.md`);
  }

  console.log(`\nNächster Schritt: pnpm dev  →  ${appBaseUrl()}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
