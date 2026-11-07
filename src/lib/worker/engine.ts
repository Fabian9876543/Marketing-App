import { and, eq, gte, inArray } from "drizzle-orm";
import { markNeedsReconnect } from "../accounts";
import type { DB } from "../db/client";
import {
  accounts,
  contents,
  posts,
  postTargets,
  projects,
  type Account,
  type Content,
  type Platform,
  type Post,
  type PostTarget,
  type UploadSession,
} from "../db/schema";
import { logEvent } from "../events";
import { PublishError, toPublishError, type PublishInput, type Publisher } from "../publishing/types";
import { getSettings, type AppSettings } from "../settings";

/** Wartezeit vor dem 1., 2., 3. und 4. Wiederholungsversuch (Minuten). */
export const RETRY_DELAYS_MIN = [1, 5, 15, 60];
/** Vorab-Upload nur, wenn bis zur geplanten Zeit noch mindestens so viel Zeit bleibt. */
export const UPLOAD_AHEAD_MIN_LEAD_MS = 10 * 60_000;
const SYNC_RETRY_MS = 5 * 60_000;

export type EngineDeps = {
  db: DB;
  publishers: Partial<Record<Platform, Publisher>>;
  getAccessToken: (account: Account) => Promise<string>;
  now?: () => Date;
  /** Wird vor jedem Upload aufgerufen (z. B. um den Mac wach zu halten). */
  onBusy?: () => void;
};

export type TickReport = {
  published: number;
  scheduled: number;
  handedOff: number;
  retrying: number;
  failed: number;
  missed: number;
  synced: number;
  /** Nächster Zeitpunkt, an dem etwas fällig wird (für „wach bleiben“). */
  nextDueAt: Date | null;
};

type Job = { target: PostTarget; post: Post; account: Account; content: Content; projectName: string };

export function createEngine(deps: EngineDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  function log(level: "info" | "warn" | "error", message: string, targetId?: number) {
    logEvent(db, level, "worker", message, targetId);
  }

  function updateTarget(id: number, patch: Partial<PostTarget>) {
    db.update(postTargets).set(patch).where(eq(postTargets.id, id)).run();
  }

  function input(job: Job, settings: AppSettings, at: Date): PublishInput {
    const { projectName: _projectName, ...rest } = job;
    return {
      ...rest,
      settings,
      now: at,
      accessToken: () => deps.getAccessToken(job.account),
      saveSession: (session: UploadSession | null) => {
        updateTarget(job.target.id, { uploadSession: session });
        job.target.uploadSession = session;
      },
      log: (m) => log("info", `${label(job)}: ${m}`, job.target.id),
    };
  }

  function loadJobs(states: PostTarget["state"][], extra?: (t: PostTarget) => boolean): Job[] {
    const rows = db
      .select({ target: postTargets, post: posts, account: accounts, content: contents, projectName: projects.name })
      .from(postTargets)
      .innerJoin(posts, eq(posts.id, postTargets.postId))
      .innerJoin(accounts, eq(accounts.id, postTargets.accountId))
      .innerJoin(contents, eq(contents.id, posts.contentId))
      .innerJoin(projects, eq(projects.id, contents.projectId))
      .where(inArray(postTargets.state, states))
      .all();
    return extra ? rows.filter((r) => extra(r.target)) : rows;
  }

  /** Nach Absturz/Neustart: hängende Uploads wieder freigeben (die Upload-Sitzung bleibt erhalten). */
  function recoverStale(): number {
    const stale = db.select().from(postTargets).where(eq(postTargets.state, "uploading")).all();
    for (const t of stale) {
      updateTarget(t.id, { state: "pending", lockedAt: null, nextAttemptAt: now() });
      log("warn", `Upload nach Neustart wieder aufgenommen (Ziel #${t.id})`, t.id);
    }
    return stale.length;
  }

  async function tick(): Promise<TickReport> {
    const at = now();
    const settings = getSettings(db);
    const report: TickReport = { published: 0, scheduled: 0, handedOff: 0, retrying: 0, failed: 0, missed: 0, synced: 0, nextDueAt: null };

    // 1) Vorab hochgeladene Posts gelten zur geplanten Zeit als veröffentlicht (die Plattform schaltet sie frei).
    for (const job of loadJobs(["scheduled"], (t) => !t.syncNeeded)) {
      if (job.post.state === "approved" && job.post.scheduledAt <= at) {
        updateTarget(job.target.id, { state: "published", publishedAt: job.post.scheduledAt });
        log("info", `${label(job)}: von der Plattform veröffentlicht`, job.target.id);
        report.published++;
      } else {
        bumpNext(report, job.post.scheduledAt);
      }
    }

    // 2) Geänderte Zeiten bzw. Absagen an die Plattform übertragen.
    for (const job of loadJobs(["scheduled"], (t) => t.syncNeeded && (!t.nextAttemptAt || t.nextAttemptAt <= at))) {
      if (await syncJob(job, settings, at)) report.synced++;
    }

    // 3) Fällige Veröffentlichungen.
    const pending = loadJobs(["pending"])
      .filter((j) => j.post.state === "approved")
      .sort((a, b) => dueAt(a.target, a.post).getTime() - dueAt(b.target, b.post).getTime());

    for (const job of pending) {
      const publisher = deps.publishers[job.account.platform];
      const due = dueAt(job.target, job.post);
      const ahead = publisher ? aheadEligible(publisher, job, settings, at) : false;

      if (at < due && !ahead) {
        bumpNext(report, due);
        continue;
      }

      if (!publisher) {
        fail(job, `${platformName(job.account.platform)} wird in dieser Version noch nicht unterstützt`);
        report.failed++;
        continue;
      }
      if (job.account.status !== "active") {
        fail(job, "Das Konto muss unter „Konten“ neu verbunden werden");
        report.failed++;
        continue;
      }
      if (at >= due && at.getTime() - due.getTime() > settings.missedToleranceMinutes * 60_000) {
        updateTarget(job.target.id, {
          state: "missed",
          lastError: `Verpasst: Der Rechner war zur geplanten Zeit aus oder im Ruhezustand (Toleranz ${settings.missedToleranceMinutes} Min.).`,
        });
        log("warn", `${label(job)}: verpasst`, job.target.id);
        report.missed++;
        continue;
      }
      if (!job.content.available) {
        fail(job, "Die Videodatei fehlt im Backlog-Ordner");
        report.failed++;
        continue;
      }
      const maxSec = publisher.maxDurationSec?.(settings);
      if (maxSec && job.content.durationSec && job.content.durationSec > maxSec) {
        fail(job, `Video ist ${Math.round(job.content.durationSec)} s lang – ${platformName(job.account.platform)} erlaubt höchstens ${maxSec} s`);
        report.failed++;
        continue;
      }

      // Tageslimit der Plattform (gemeinsam für alle Konten dieser Plattform)
      if (publisher.dailyLimit && publisher.quotaDayStart) {
        const dayStart = publisher.quotaDayStart(at);
        const used = uploadsSince(job.account.platform, dayStart);
        if (used >= publisher.dailyLimit(settings)) {
          const next = new Date(dayStart.getTime() + 86_400_000 + 60_000);
          updateTarget(job.target.id, { nextAttemptAt: next, lastError: "Tageslimit erreicht – wird morgen hochgeladen" });
          log("warn", `${label(job)}: Tageslimit von ${publisher.dailyLimit(settings)} Uploads erreicht`, job.target.id);
          continue;
        }
      }

      const publishAt = ahead && at < new Date(job.post.scheduledAt.getTime() - UPLOAD_AHEAD_MIN_LEAD_MS) ? job.post.scheduledAt : undefined;
      const outcome = await run(job, publisher, settings, at, publishAt);
      if (outcome) report[outcome]++;
    }

    return report;
  }

  async function run(
    job: Job,
    publisher: Publisher,
    settings: AppSettings,
    at: Date,
    publishAt: Date | undefined,
  ): Promise<keyof Omit<TickReport, "nextDueAt" | "synced"> | null> {
    const attempts = job.target.attempts + 1;
    deps.onBusy?.();
    updateTarget(job.target.id, { state: "uploading", lockedAt: at, attempts });
    job.target.attempts = attempts;
    log("info", `${label(job)}: ${publishAt ? "lade vorab hoch" : "veröffentliche"} (Versuch ${attempts})`, job.target.id);

    try {
      const result = await publisher.publish(input(job, settings, at), { publishAt });
      const done = now();
      updateTarget(job.target.id, {
        state: result.state,
        externalId: result.externalId,
        externalUrl: result.externalUrl ?? null,
        uploadedAt: done,
        publishedAt: result.state === "published" ? done : null,
        lastError: null,
        lockedAt: null,
        nextAttemptAt: null,
        uploadSession: null,
      });
      const message = {
        published: "veröffentlicht",
        scheduled: "hochgeladen, die Plattform veröffentlicht zur geplanten Zeit",
        handed_off: "als Entwurf in der App abgelegt – dort fertigstellen und posten",
      }[result.state];
      log("info", `${label(job)}: ${message}`, job.target.id);
      return result.state === "handed_off" ? "handedOff" : result.state;
    } catch (err) {
      return handleFailure(job, toPublishError(err));
    }
  }

  function handleFailure(job: Job, err: PublishError): "retrying" | "failed" | null {
    const at = now();
    const base = { lockedAt: null, lastError: err.message };
    switch (err.kind) {
      case "auth":
        markNeedsReconnect(db, job.account.id, err.message);
        updateTarget(job.target.id, { ...base, state: "failed" });
        log("error", `${label(job)}: ${err.message}`, job.target.id);
        return "failed";
      case "processing":
        // Die Plattform verarbeitet noch – zählt nicht als Versuch, gleich wieder nachsehen.
        updateTarget(job.target.id, {
          lockedAt: null,
          lastError: null,
          state: "pending",
          attempts: Math.max(0, job.target.attempts - 1),
          nextAttemptAt: err.retryAt ?? new Date(at.getTime() + 60_000),
        });
        log("info", `${label(job)}: ${err.message}`, job.target.id);
        return null;
      case "quota":
        // Zählt nicht als Versuch.
        updateTarget(job.target.id, {
          ...base,
          state: "pending",
          attempts: Math.max(0, job.target.attempts - 1),
          nextAttemptAt: err.retryAt ?? new Date(at.getTime() + 60 * 60_000),
        });
        log("warn", `${label(job)}: ${err.message}`, job.target.id);
        return null;
      case "fatal":
        updateTarget(job.target.id, { ...base, state: "failed" });
        log("error", `${label(job)}: ${err.message}`, job.target.id);
        return "failed";
      case "retryable": {
        const delay = RETRY_DELAYS_MIN[job.target.attempts - 1];
        if (delay === undefined) {
          updateTarget(job.target.id, {
            ...base,
            state: "failed",
            lastError: `Nach ${job.target.attempts} Versuchen aufgegeben: ${err.message}`,
          });
          log("error", `${label(job)}: aufgegeben – ${err.message}`, job.target.id);
          return "failed";
        }
        updateTarget(job.target.id, { ...base, state: "pending", nextAttemptAt: new Date(at.getTime() + delay * 60_000) });
        log("warn", `${label(job)}: ${err.message} – neuer Versuch in ${delay} Min.`, job.target.id);
        return "retrying";
      }
    }
  }

  async function syncJob(job: Job, settings: AppSettings, at: Date): Promise<boolean> {
    const publisher = deps.publishers[job.account.platform];
    const cancel = job.post.state === "cancelled";
    try {
      if (cancel) {
        await publisher?.remove?.(input(job, settings, at));
        updateTarget(job.target.id, { state: "cancelled", syncNeeded: false, nextAttemptAt: null, lastError: null });
        log("info", `${label(job)}: bei der Plattform entfernt (Post abgesagt)`, job.target.id);
      } else {
        // publishAt muss in der Zukunft liegen.
        const when = new Date(Math.max(job.post.scheduledAt.getTime(), at.getTime() + 2 * 60_000));
        await publisher?.updateSchedule?.(input(job, settings, at), when);
        updateTarget(job.target.id, { syncNeeded: false, nextAttemptAt: null, lastError: null });
        log("info", `${label(job)}: neue Zeit an die Plattform übertragen`, job.target.id);
      }
      return true;
    } catch (e) {
      const err = toPublishError(e);
      if (err.kind === "auth") markNeedsReconnect(db, job.account.id, err.message);
      updateTarget(job.target.id, { nextAttemptAt: new Date(at.getTime() + SYNC_RETRY_MS), lastError: err.message });
      log("error", `${label(job)}: Änderung nicht übertragen – ${err.message}`, job.target.id);
      return false;
    }
  }

  function fail(job: Job, message: string) {
    updateTarget(job.target.id, { state: "failed", lastError: message, lockedAt: null });
    log("error", `${label(job)}: ${message}`, job.target.id);
  }

  function uploadsSince(platform: Platform, since: Date): number {
    return db
      .select({ id: postTargets.id })
      .from(postTargets)
      .innerJoin(accounts, eq(accounts.id, postTargets.accountId))
      .where(and(eq(accounts.platform, platform), gte(postTargets.uploadedAt, since)))
      .all().length;
  }

  return { tick, recoverStale };
}

/** Bezugszeit für „fällig“: nächster Versuch, sonst geplante Zeit. */
export function dueAt(target: PostTarget, post: Post): Date {
  return target.nextAttemptAt ?? post.scheduledAt;
}

function aheadEligible(publisher: Publisher, job: Job, settings: AppSettings, at: Date): boolean {
  const window = publisher.uploadAheadWindowMs?.(settings) ?? 0;
  if (window <= 0) return false;
  if (job.target.nextAttemptAt && job.target.nextAttemptAt > at) return false;
  const lead = job.post.scheduledAt.getTime() - at.getTime();
  return lead > UPLOAD_AHEAD_MIN_LEAD_MS && lead <= window;
}

function bumpNext(report: TickReport, d: Date) {
  if (!report.nextDueAt || d < report.nextDueAt) report.nextDueAt = d;
}

function platformName(p: Platform): string {
  return { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok", linkedin: "LinkedIn", simulator: "Test-Kanal" }[p];
}

function label(job: Job): string {
  const platform = platformName(job.account.platform);
  const account = job.account.name === platform ? "" : ` (${job.account.name})`;
  return `[${job.projectName}] „${job.content.title}“ → ${platform}${account}`;
}
