/**
 * Installiert Web-App und Worker als macOS-LaunchAgents:
 * starten beim Anmelden, starten nach einem Absturz neu, laufen im Hintergrund.
 *
 *   pnpm local:install    (baut die App und installiert beide Dienste)
 *   pnpm local:status
 *   pnpm local:uninstall
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_PORT, ensureDir, loadDotEnv, logDir } from "../src/lib/env";

export const LABELS = { web: "de.marketing-studio.web", worker: "de.marketing-studio.worker" } as const;
/** Dienste früherer Installationen (vor der Umbenennung) – werden beim Installieren entfernt. */
const LEGACY_LABELS = ["de.fokuspilot.studio.web", "de.fokuspilot.studio.worker"];

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function buildPlist(opts: {
  label: string;
  args: string[];
  cwd: string;
  logFile: string;
  env: Record<string, string>;
}): string {
  const args = opts.args.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");
  const env = Object.entries(opts.env)
    .map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(opts.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(opts.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(opts.logFile)}</string>
</dict>
</plist>
`;
}

export function agentDefinitions(repo: string, node: string, logs: string) {
  const env = {
    PATH: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", path.dirname(node)].join(":"),
    NODE_ENV: "production",
  };
  return [
    {
      label: LABELS.web,
      args: [node, path.join(repo, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(APP_PORT)],
      cwd: repo,
      logFile: path.join(logs, "web.log"),
      env,
    },
    {
      label: LABELS.worker,
      args: [node, path.join(repo, "node_modules/tsx/dist/cli.mjs"), path.join(repo, "worker/index.ts")],
      cwd: repo,
      logFile: path.join(logs, "worker.log"),
      env,
    },
  ];
}

const plistPath = (label: string) => path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
const domain = () => `gui/${process.getuid?.() ?? 501}`;

function launchctl(args: string[], allowFail = false): string {
  try {
    return execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (allowFail) return "";
    throw err;
  }
}

function install() {
  const repo = process.cwd();
  if (!fs.existsSync(path.join(repo, ".next", "BUILD_ID"))) {
    throw new Error("Kein Build gefunden – bitte `pnpm local:install` verwenden (baut vorher die App).");
  }
  const logs = ensureDir(logDir());
  for (const label of LEGACY_LABELS) {
    launchctl(["bootout", `${domain()}/${label}`], true);
    fs.rmSync(plistPath(label), { force: true });
  }
  for (const def of agentDefinitions(repo, process.execPath, logs)) {
    const file = plistPath(def.label);
    ensureDir(path.dirname(file));
    launchctl(["bootout", `${domain()}/${def.label}`], true);
    fs.writeFileSync(file, buildPlist(def));
    launchctl(["bootstrap", domain(), file]);
    console.log(`✓ ${def.label} installiert und gestartet`);
  }
  console.log(`\nOberfläche: http://localhost:${APP_PORT}\nLogs:       ${logs}`);
}

function uninstall() {
  for (const label of [...Object.values(LABELS), ...LEGACY_LABELS]) {
    launchctl(["bootout", `${domain()}/${label}`], true);
    fs.rmSync(plistPath(label), { force: true });
    console.log(`✓ ${label} entfernt`);
  }
}

function status() {
  for (const label of Object.values(LABELS)) {
    const out = launchctl(["print", `${domain()}/${label}`], true);
    const state = out.match(/state = (\w+)/)?.[1] ?? "nicht installiert";
    const pid = out.match(/pid = (\d+)/)?.[1];
    console.log(`${label}: ${state}${pid ? ` (PID ${pid})` : ""}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  loadDotEnv();
  if (process.platform !== "darwin") {
    console.error("Die Hintergrund-Dienste per launchd gibt es nur auf dem Mac. Zum Ausprobieren: `pnpm start`.");
    process.exit(1);
  }
  const cmd = process.argv[2];
  if (cmd === "install") install();
  else if (cmd === "uninstall") uninstall();
  else if (cmd === "status") status();
  else {
    console.error("Verwendung: tsx scripts/launchagent.ts install|uninstall|status");
    process.exit(1);
  }
}
