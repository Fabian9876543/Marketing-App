import Link from "next/link";
import { connection } from "next/server";
import { deleteAutomationAction, runAutomationNowAction, switchProjectAction, toggleAutomationAction } from "@/app/actions";
import { SubmitButton } from "@/components/client";
import { Badge, ChooseProject, Empty, Flash, NoProject, PageHeader, flashFrom } from "@/components/ui";
import { getScope } from "@/lib/active-project";
import { automationBusy, lastAutomationSession, listAutomations, nextRunAt, scheduleText, upcomingRuns } from "@/lib/automation";
import { getDb } from "@/lib/db/client";
import { getSettings } from "@/lib/settings";
import { sessionRuns } from "@/lib/studio/sessions";
import { formatDateTime, relative } from "@/lib/time";

export default async function AutomationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const db = getDb();
  const scope = await getScope(db);
  if (!scope.projects.length) return <NoProject />;
  if (!scope.active) {
    return (
      <>
        <PageHeader title="Automationen" />
        <ChooseProject projects={scope.projects} back="/studio/automationen" action={switchProjectAction} what="Automationen" />
      </>
    );
  }
  const project = scope.active;
  const tz = getSettings(db).timezone;
  const list = listAutomations(db, project.id);

  return (
    <>
      <PageHeader
        title={`Automationen · ${project.name}`}
        subtitle="Claude baut nach einem Rezept regelmäßig neue Shorts – du gibst sie in der Warteschlange frei."
        actions={
          <>
            <Link href="/studio" className="btn">
              ← Studio
            </Link>
            <Link href="/studio/automationen/neu" className="btn btn-primary">
              Neue Automation
            </Link>
          </>
        }
      />
      <Flash {...await flashFrom(searchParams)} />

      {list.length === 0 ? (
        <Empty
          action={
            <Link href="/studio" className="btn">
              Zum Studio
            </Link>
          }
        >
          Noch keine Automation. Am einfachsten: Im Studio einen Short bauen lassen, der dir gefällt, und dann im Chat auf „Als Automation speichern“ klicken.
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {list.map((a) => {
            const busy = automationBusy(db, a.id);
            const next = a.enabled ? nextRunAt(a, tz) : null;
            const week = a.enabled ? upcomingRuns(a, new Date(), tz, 5) : [];
            const last = lastAutomationSession(db, a.id);
            const lastRun = last ? sessionRuns(db, last.id).at(-1) : undefined;
            return (
              <article key={a.id} className="card flex flex-col gap-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="font-semibold">{a.name}</h2>
                    <p className="text-sm text-muted">{scheduleText(a)}</p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {a.enabled ? <Badge tone="ok">Aktiv</Badge> : <Badge>Pausiert</Badge>}
                    {busy && <Badge tone="info">Läuft gerade</Badge>}
                    {a.autoSchedule && <Badge tone="info">plant zur Freigabe ein</Badge>}
                  </div>
                </div>

                {a.enabled && next && (
                  <div>
                    <p className="text-sm">
                      Nächster Lauf: <span className="font-medium">{formatDateTime(next, tz)}</span> <span className="text-muted">({relative(next)})</span>
                    </p>
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {week.map((d) => (
                        <li key={d.getTime()} className="rounded-md border border-dashed border-line px-2 py-0.5 text-xs text-muted">
                          {formatDateTime(d, tz)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <p className="text-xs text-muted">
                  {last ? (
                    <>
                      Letzter Lauf {relative(last.createdAt)}
                      {lastRun && ` · ${{ queued: "wartet", running: "arbeitet", done: "fertig", error: "Fehler", cancelled: "abgebrochen" }[lastRun.state]}`}
                      {lastRun?.newShorts.length ? ` · ${lastRun.newShorts.length} neue Shorts` : ""} ·{" "}
                      <Link href={`/studio?chat=${last.id}`} className="underline">
                        ansehen
                      </Link>
                    </>
                  ) : (
                    "Noch nie gelaufen"
                  )}
                </p>

                <details className="text-sm">
                  <summary className="cursor-pointer text-xs text-muted hover:text-fg">Rezept anzeigen</summary>
                  <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-mono text-xs">{a.recipe}</pre>
                </details>

                <div className="mt-auto flex flex-wrap gap-2 border-t border-line pt-3">
                  <form action={runAutomationNowAction}>
                    <input type="hidden" name="automationId" value={a.id} />
                    <SubmitButton className="btn btn-primary" pendingText="Starte …">
                      Jetzt ausführen
                    </SubmitButton>
                  </form>
                  <form action={toggleAutomationAction}>
                    <input type="hidden" name="automationId" value={a.id} />
                    <input type="hidden" name="enabled" value={a.enabled ? "0" : "1"} />
                    <input type="hidden" name="back" value="/studio/automationen" />
                    <SubmitButton>{a.enabled ? "Pausieren" : "Aktivieren"}</SubmitButton>
                  </form>
                  <Link href={`/studio/automationen/${a.id}`} className="btn">
                    Bearbeiten
                  </Link>
                  <form action={deleteAutomationAction} className="ml-auto">
                    <input type="hidden" name="automationId" value={a.id} />
                    <input type="hidden" name="back" value="/studio/automationen" />
                    <SubmitButton className="btn btn-danger" confirm={`Automation „${a.name}“ löschen?`}>
                      Löschen
                    </SubmitButton>
                  </form>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <p className="mt-6 text-xs text-muted">
        Läufe startet der Worker. Ist der Rechner zur geplanten Zeit aus oder im Ruhezustand, wird der Lauf innerhalb von 6 Stunden nachgeholt, sonst
        übersprungen. Freie Posting-Zeiten automatisch mit Shorts aus dem Backlog füllen kannst du beim{" "}
        <Link href={`/projekte/${project.id}?tab=zeiten`} className="underline">
          Projekt unter Posting-Zeiten
        </Link>
        .
      </p>
    </>
  );
}
