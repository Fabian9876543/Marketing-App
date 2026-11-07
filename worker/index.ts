/**
 * Marketing Studio – Worker
 * Läuft im Hintergrund (auf dem Mac als LaunchAgent) und veröffentlicht fällige Posts.
 */
import { getDb } from "@/lib/db/client";
import { loadDotEnv } from "@/lib/env";
import { importBacklog } from "@/lib/backlog";
import { logEvent, pruneEvents } from "@/lib/events";
import { publishers } from "@/lib/publishing/registry";
import { getAccessToken } from "@/lib/publishing/tokens";
import { listProjects } from "@/lib/projects";
import { writeHeartbeat } from "@/lib/settings";
import { StudioQueue } from "@/lib/studio/runner";
import { KeepAwake } from "@/lib/worker/awake";
import { createEngine } from "@/lib/worker/engine";

loadDotEnv();

const TICK_MS = 15_000;
const BACKLOG_SCAN_MS = 5 * 60_000;
const AWAKE_BEFORE_MS = 10 * 60_000;

const db = getDb();
const awake = new KeepAwake();
const engine = createEngine({
  db,
  publishers,
  getAccessToken: (account) => getAccessToken(db, account),
  onBusy: () => awake.set(true),
});
const studio = new StudioQueue(db);
const startedAt = Date.now();
let running = false;
let stopping = false;
let lastScan = 0;

async function tick() {
  if (running || stopping) return;
  running = true;
  try {
    writeHeartbeat(db, { at: Date.now(), pid: process.pid, startedAt });

    if (Date.now() - lastScan > BACKLOG_SCAN_MS) {
      lastScan = Date.now();
      for (const project of listProjects(db)) {
        const r = await importBacklog(db, project);
        if (r.added) logEvent(db, "info", "backlog", `[${project.name}] ${r.added} neue Shorts im Backlog gefunden`);
        for (const e of r.errors) logEvent(db, "warn", "backlog", `[${project.name}] ${e}`);
      }
      pruneEvents(db);
    }

    const report = await engine.tick();
    const soon = report.nextDueAt && report.nextDueAt.getTime() - Date.now() < AWAKE_BEFORE_MS;
    awake.set(Boolean(soon) || studio.active > 0);
  } catch (err) {
    logEvent(db, "error", "worker", `Unerwarteter Fehler: ${(err as Error).stack ?? err}`);
    awake.set(false);
  } finally {
    running = false;
  }
}

function shutdown(signal: string) {
  stopping = true;
  awake.set(false);
  logEvent(db, "info", "worker", `Beendet (${signal})`);
  // Laufende Uploads sind fortsetzbar und werden beim nächsten Start wieder aufgenommen.
  setTimeout(() => process.exit(0), running ? 2000 : 0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

logEvent(db, "info", "worker", `Gestartet (PID ${process.pid})`);
engine.recoverStale();
studio.recover();
void tick();
setInterval(() => void tick(), TICK_MS);
// Studio-Aufträge zügig starten; sie laufen nebenher (Claude Code rendert oft mehrere Minuten).
setInterval(() => {
  if (stopping) return;
  try {
    studio.tick();
  } catch (err) {
    logEvent(db, "error", "studio", `Studio: ${(err as Error).message}`);
  }
}, 2000);
