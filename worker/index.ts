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
import { autoFillProject } from "@/lib/autoplan";
import { runDueAutomations } from "@/lib/automation";
import { runDueAnalyses } from "@/lib/analysis";
import { runDueResearch } from "@/lib/research/run";
import { refreshDueInsights } from "@/lib/analytics/store";
import { StudioQueue } from "@/lib/studio/runner";
import { KeepAwake } from "@/lib/worker/awake";
import { createEngine } from "@/lib/worker/engine";

loadDotEnv();

const TICK_MS = 15_000;
const BACKLOG_SCAN_MS = 5 * 60_000;
const AWAKE_BEFORE_MS = 10 * 60_000;
const INSIGHTS_CHECK_MS = 60_000;

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
let insightsRunning = false;

async function tick() {
  if (running || stopping) return;
  running = true;
  try {
    writeHeartbeat(db, { at: Date.now(), pid: process.pid, startedAt });

    if (Date.now() - lastScan > BACKLOG_SCAN_MS) {
      lastScan = Date.now();
      for (const project of listProjects(db)) {
        const r = await importBacklog(db, project);
        // „Freie Slots füllen“ (nur Projekte, die das eingeschaltet haben) – immer zur Freigabe
        autoFillProject(db, project);
        if (r.added) logEvent(db, "info", "backlog", `[${project.name}] ${r.added} neue Shorts im Backlog gefunden`);
        for (const e of r.errors) logEvent(db, "warn", "backlog", `[${project.name}] ${e}`);
      }
      pruneEvents(db);
    }

    // Fällige Automationen und Wochenanalysen starten neue Studio-Aufträge
    runDueAutomations(db);
    runDueAnalyses(db);
    runDueResearch(db);
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
// Zahlen abrufen – eigene Schleife, damit langsame Plattform-APIs das Veröffentlichen nicht aufhalten
async function insightsTick() {
  if (insightsRunning || stopping) return;
  insightsRunning = true;
  try {
    const results = await refreshDueInsights(db);
    const fetched = results.filter((r) => !r.error).reduce((t, r) => t + r.items, 0);
    if (results.length && fetched) logEvent(db, "info", "analytics", `Zahlen aktualisiert: ${fetched} Beiträge aus ${results.filter((r) => !r.error).length} Konten`);
  } catch (err) {
    logEvent(db, "error", "analytics", `Zahlen abrufen: ${(err as Error).message}`);
  } finally {
    insightsRunning = false;
  }
}
setTimeout(() => void insightsTick(), 20_000);
setInterval(() => void insightsTick(), INSIGHTS_CHECK_MS);

// Studio-Aufträge zügig starten; sie laufen nebenher (Claude Code rendert oft mehrere Minuten).
setInterval(() => {
  if (stopping) return;
  try {
    studio.tick();
  } catch (err) {
    logEvent(db, "error", "studio", `Studio: ${(err as Error).message}`);
  }
}, 2000);
