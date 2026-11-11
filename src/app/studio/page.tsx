import Link from "next/link";
import type { ReactNode } from "react";
import { connection } from "next/server";
import {
  cancelStudioAction,
  deleteStudioSessionAction,
  sendStudioMessageAction,
  setupStudioAction,
  startStudioAction,
  switchProjectAction,
} from "@/app/actions";
import { SubmitButton } from "@/components/client";
import { StudioChat } from "@/components/StudioChat";
import { Badge, ChooseProject, Flash, NoProject, PageHeader, flashFrom } from "@/components/ui";
import { getScope } from "@/lib/active-project";
import { listAutomations } from "@/lib/automation";
import { getDb } from "@/lib/db/client";
import type { Project, StudioRun } from "@/lib/db/schema";
import { getSettings, workerAlive, type AppSettings } from "@/lib/settings";
import { claudeInfo, type ClaudeInfo } from "@/lib/studio/claude";
import { QUICK_PROMPTS, getSession, listSessions, sessionMessages, sessionRuns, type SessionSummary } from "@/lib/studio/sessions";
import { studioStatus, type StudioStatus } from "@/lib/studio/workspace";
import { relative } from "@/lib/time";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function StudioPage({ searchParams }: { searchParams: SP }) {
  await connection();
  const db = getDb();
  const scope = await getScope(db);
  if (!scope.projects.length) return <NoProject />;
  if (!scope.active) {
    return (
      <>
        <PageHeader title="Studio" />
        <ChooseProject projects={scope.projects} back="/studio" action={switchProjectAction} what="Studio-Chats" />
      </>
    );
  }
  const project = scope.active;
  const sp = await searchParams;
  const sessions = listSessions(db, project.id);
  const chatParam = Number(sp.chat);
  const selected = sp.neu !== undefined ? undefined : (sessions.find((s) => s.id === chatParam) ?? (sp.chat ? undefined : sessions[0]));
  const status = studioStatus(project);
  const info = await claudeInfo();
  const alive = workerAlive(db);
  const automationCount = listAutomations(db, project.id).length;

  return (
    <>
      <PageHeader
        title={`Studio · ${project.name}`}
        subtitle="Claude Code baut Shorts aus Briefing und Referenzen. Nichts geht online, bevor du es freigibst."
        actions={
          <>
            <Link href="/studio/automationen" className="btn">
              Automationen{automationCount ? ` (${automationCount})` : ""}
            </Link>
            <Link href="/studio?neu" className="btn btn-primary">
              Neuer Auftrag
            </Link>
          </>
        }
      />
      <Flash {...await flashFrom(searchParams)} />
      <Readiness project={project} status={status} info={info} workerAlive={alive} higgsfield={getSettings(db).higgsfield} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_1fr]">
        <aside className="space-y-2">
          <h2 className="label">Chats</h2>
          {sessions.length === 0 && <p className="text-sm text-muted">Noch keine Chats.</p>}
          <ul className="space-y-1">
            {sessions.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/studio?chat=${s.id}`}
                  className={`block rounded-lg px-3 py-2 text-sm ${selected?.id === s.id ? "bg-surface font-medium shadow-sm ring-1 ring-line" : "text-muted hover:bg-surface hover:text-fg"}`}
                >
                  <span className="line-clamp-2">{s.title}</span>
                  <span className="mt-1 flex items-center gap-2 text-xs font-normal text-muted">
                    <RunBadge run={s.lastRun} />
                    {s.automationId && <Badge>Automation</Badge>}
                    {s.analysis && <Badge tone="info">Wochenanalyse</Badge>}
                    {s.research && <Badge tone="info">Recherche</Badge>}
                    {relative(s.updatedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </aside>

        <section className="min-w-0">
          {selected ? (
            <ChatView session={selected} />
          ) : (
            <NewTask project={project} />
          )}
        </section>
      </div>
    </>
  );
}

function RunBadge({ run }: { run: StudioRun | null }) {
  if (!run) return null;
  const map = {
    queued: ["info", "wartet"],
    running: ["info", "arbeitet"],
    done: ["ok", "fertig"],
    error: ["bad", "Fehler"],
    cancelled: ["neutral", "abgebrochen"],
  } as const;
  const [tone, label] = map[run.state];
  return <Badge tone={tone}>{label}</Badge>;
}

/** Was fehlt noch, damit das Studio arbeiten kann? */
function Readiness({
  project,
  status,
  info,
  workerAlive,
  higgsfield: hf,
}: {
  project: Project;
  status: StudioStatus;
  info: ClaudeInfo;
  workerAlive: boolean;
  higgsfield: AppSettings["higgsfield"];
}) {
  const items: { ok: boolean; text: ReactNode }[] = [
    {
      ok: info.available,
      text: info.available ? (
        <>Claude Code {info.version}</>
      ) : (
        <>
          Claude Code fehlt – installieren (docs.claude.com/claude-code), im Terminal <code>claude</code> starten und anmelden.
        </>
      ),
    },
    { ok: workerAlive, text: workerAlive ? "Worker läuft (führt die Aufträge aus)" : "Worker läuft nicht – ohne ihn bleiben Aufträge in der Warteschlange" },
    { ok: status.template && status.instructions, text: status.template && status.instructions ? "Vorlage und Anweisungen im Projektordner" : "Studio noch nicht eingerichtet" },
    {
      ok: Boolean(project.brief.audience || project.brief.messages),
      text: project.brief.audience || project.brief.messages ? "Briefing vorhanden" : <Link href={`/projekte/${project.id}?tab=briefing`} className="underline">Briefing ausfüllen – sonst rät Claude</Link>,
    },
    ...(hf.enabled
      ? [
          {
            ok: hf.detected.status === "ok",
            text:
              hf.detected.status === "ok" ? (
                `Higgsfield freigegeben (höchstens ${hf.maxCredits} Credits pro Auftrag)`
              ) : (
                <Link href="/einstellungen#higgsfield" className="underline">
                  Higgsfield eingeschaltet, aber nicht verbunden
                </Link>
              ),
          },
        ]
      : []),
  ];
  const allOk = items.every((i) => i.ok);
  return (
    <section className={`card mb-6 p-4 ${allOk ? "" : "border-warn-bg"}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          {items.map((i, n) => (
            <li key={n} className="flex items-center gap-1.5">
              <span className={i.ok ? "text-ok" : "text-warn"}>{i.ok ? "✓" : "!"}</span>
              <span className={i.ok ? "text-muted" : ""}>{i.text}</span>
            </li>
          ))}
        </ul>
        {!(status.template && status.instructions) && (
          <form action={setupStudioAction}>
            <input type="hidden" name="projectId" value={project.id} />
            <input type="hidden" name="back" value="/studio" />
            <SubmitButton className="btn btn-primary">Studio einrichten</SubmitButton>
          </form>
        )}
      </div>
      {!status.installed && status.template && (
        <p className="mt-2 text-xs text-muted">
          Beim ersten Auftrag installiert Claude die Video-Vorlage (<code>npm install</code> in <code>studio/</code>) – das dauert einmalig ein bis zwei Minuten.
        </p>
      )}
    </section>
  );
}

function NewTask({ project }: { project: Project }) {
  return (
    <div className="space-y-5">
      <form action={startStudioAction} className="card space-y-3 p-4">
        <input type="hidden" name="projectId" value={project.id} />
        <input type="hidden" name="back" value="/studio?neu" />
        <h2 className="h2">Was soll Claude machen?</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {QUICK_PROMPTS.map((q) => (
            <button key={q.key} name="quick" value={q.key} className="btn h-auto justify-start py-2.5 text-left" title={q.prompt}>
              {q.label}
            </button>
          ))}
        </div>
      </form>
      <form action={startStudioAction} className="card space-y-3 p-4">
        <input type="hidden" name="projectId" value={project.id} />
        <input type="hidden" name="back" value="/studio?neu" />
        <label className="h2 block" htmlFor="prompt">
          Eigener Auftrag
        </label>
        <textarea
          id="prompt"
          name="prompt"
          rows={5}
          required
          className="input"
          placeholder={`z. B. „Mach einen 20-Sekunden-Short im Dialog-Format: Ein Anruf um 22 Uhr, der Assistent vereinbart einen Termin. Nutze die Screenshots aus den Referenzen.“`}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted">Claude arbeitet im Projektordner, nutzt PROJEKT.md und die Referenzen und legt fertige Shorts ins Backlog.</p>
          <SubmitButton className="btn btn-primary">Auftrag starten</SubmitButton>
        </div>
      </form>
    </div>
  );
}

function ChatView({ session }: { session: SessionSummary }) {
  const db = getDb();
  const fresh = getSession(db, session.id)!;
  const messages = sessionMessages(db, session.id).map(({ id, kind, text, toolName, isError }) => ({ id, kind, text, toolName, isError }));
  const last = sessionRuns(db, session.id).at(-1) ?? null;
  const run = last && { id: last.id, state: last.state, error: last.error, newShorts: last.newShorts, cancelRequested: last.cancelRequested };
  const busy = run?.state === "queued" || run?.state === "running";
  const canBecomeRecipe = !fresh.automationId && !fresh.analysis && !fresh.research && sessionRuns(db, session.id).some((r) => r.state === "done");
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{fresh.title}</h2>
        {!busy && canBecomeRecipe && (
          <Link href={`/studio/automationen/neu?chat=${session.id}`} className="btn ml-auto py-1 text-xs">
            Als Automation speichern
          </Link>
        )}
        {!busy && (
          <form action={deleteStudioSessionAction}>
            <input type="hidden" name="sessionId" value={session.id} />
            <SubmitButton className="btn btn-danger py-1 text-xs" confirm="Chat löschen? Fertige Shorts im Backlog bleiben erhalten.">
              Chat löschen
            </SubmitButton>
          </form>
        )}
      </div>
      <StudioChat sessionId={session.id} initialMessages={messages} initialRun={run} sendAction={sendStudioMessageAction} cancelAction={cancelStudioAction} />
    </div>
  );
}
