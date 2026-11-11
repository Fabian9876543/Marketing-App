import Link from "next/link";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { and, eq } from "drizzle-orm";
import {
  addLearningAction,
  decideLearningAction,
  removeLearningAction,
  saveResearchSourcesAction,
  startResearchAction,
  switchProjectAction,
} from "@/app/actions";
import { SubmitButton } from "@/components/client";
import { ChooseProject, Flash, NoProject, PageHeader, flashFrom } from "@/components/ui";
import { getScope } from "@/lib/active-project";
import { getDb } from "@/lib/db/client";
import { projectReferences } from "@/lib/db/schema";
import { listLearnings } from "@/lib/learnings";
import { adLibraryTokens } from "@/lib/research/meta";
import { hasResearchSources, lastResearchSession, listReports, readReport, researchBusy } from "@/lib/research/run";
import { researchAccount } from "@/lib/research/social";
import { getSettings } from "@/lib/settings";
import { sessionRuns } from "@/lib/studio/sessions";
import { formatDateTime, relative } from "@/lib/time";
import { hasElevenLabsKey } from "@/lib/voice/elevenlabs";

const EVERY_LABEL = { off: "nur von Hand", week: "jede Woche", month: "alle 4 Wochen" } as const;

function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className={ok ? "text-ok" : "text-warn"}>{ok ? "✓" : "!"}</span>
      <span className={ok ? "text-muted" : ""}>{children}</span>
    </li>
  );
}

export default async function ResearchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const db = getDb();
  const scope = await getScope(db);
  if (!scope.projects.length) return <NoProject />;
  if (!scope.active) {
    return (
      <>
        <PageHeader title="Recherche" />
        <ChooseProject projects={scope.projects} back="/recherche" action={switchProjectAction} what="Recherchen" />
      </>
    );
  }
  const project = scope.active;
  const sp = await searchParams;
  const settings = getSettings(db);
  const tz = settings.timezone;
  const r = project.research;

  const metaTokens = await adLibraryTokens(db).catch(() => []);
  const ig = researchAccount(db, "instagram", project.id);
  const yt = researchAccount(db, "youtube", project.id);
  const examples = db
    .select()
    .from(projectReferences)
    .where(and(eq(projectReferences.projectId, project.id), eq(projectReferences.category, "inspiration")))
    .all();
  const busy = researchBusy(db, project.id);
  const ready = hasResearchSources(db, project);
  const last = lastResearchSession(db, project.id);
  const lastRun = last ? sessionRuns(db, last.id).at(-1) : undefined;

  const patterns = listLearnings(db, project.id).filter((l) => l.source === "research");
  const proposed = patterns.filter((l) => l.status === "proposed");
  const accepted = patterns.filter((l) => l.status === "accepted");
  const rejected = patterns.filter((l) => l.status === "rejected");

  const reports = listReports(project);
  const shown = (typeof sp.bericht === "string" && reports.includes(sp.bericht) ? sp.bericht : reports[0]) ?? null;
  const report = shown ? readReport(project, shown) : null;
  const back = "/recherche";

  return (
    <>
      <PageHeader
        title={`Recherche · ${project.name}`}
        subtitle="Claude sieht sich erfolgreiche Anzeigen und Beiträge anderer an und leitet Muster ab – als Orientierung, nie zum Kopieren."
        actions={
          <form action={startResearchAction}>
            <input type="hidden" name="projectId" value={project.id} />
            <input type="hidden" name="back" value={back} />
            <SubmitButton className="btn btn-primary" pendingText="Starte …" disabled={busy || !ready}>
              {busy ? "Recherche läuft …" : "Recherche jetzt starten"}
            </SubmitButton>
          </form>
        }
      />
      <Flash {...await flashFrom(searchParams)} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
        <form action={saveResearchSourcesAction} className="card space-y-4 p-4">
          <input type="hidden" name="projectId" value={project.id} />
          <input type="hidden" name="back" value={back} />
          <h2 className="h2">Quellen</h2>
          <div>
            <label className="label" htmlFor="keywords">
              Stichwörter – für Werbebibliothek und YouTube, eins pro Zeile
            </label>
            <textarea id="keywords" name="keywords" rows={3} defaultValue={(r.keywords ?? []).join("\n")} className="input" placeholder={"KI Telefonassistent\nPraxis Telefon\nTerminvergabe automatisch"} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="instagram">
                Instagram-Konten (Konkurrenz, Vorbilder)
              </label>
              <textarea id="instagram" name="instagram" rows={3} defaultValue={(r.instagram ?? []).join("\n")} className="input" placeholder={"@konkurrent\n@vorbild.marke"} />
            </div>
            <div>
              <label className="label" htmlFor="metaPages">
                Facebook-Seiten für die Werbebibliothek (Seiten-ID)
              </label>
              <textarea id="metaPages" name="metaPages" rows={3} defaultValue={(r.metaPages ?? []).join("\n")} className="input font-mono text-xs" placeholder="123456789012345" />
            </div>
          </div>
          <p className="text-xs text-muted">
            Die Seiten-ID steht in der Werbebibliothek (facebook.com/ads/library) in der Adresse hinter „view_all_page_id=“, wenn du einen Werbetreibenden öffnest –
            du kannst auch die ganze Adresse einfügen. Instagram geht nur bei Business- und Creator-Konten.
          </p>
          <div className="text-right">
            <SubmitButton className="btn btn-primary">Speichern</SubmitButton>
          </div>
        </form>

        <section className="card space-y-3 p-4 lg:self-start">
          <h2 className="h2">Voraussetzungen</h2>
          <ul className="space-y-1.5 text-sm">
            <Check ok={metaTokens.length > 0}>
              Werbebibliothek:{" "}
              {metaTokens.length ? (
                <>
                  Zugang über {metaTokens.map((t) => t.label).join(" oder ")} –{" "}
                  <Link href="/einstellungen#recherche" className="underline">
                    prüfen
                  </Link>
                </>
              ) : (
                <Link href="/einstellungen#recherche" className="underline">
                  Zugang einrichten
                </Link>
              )}
            </Check>
            <Check ok={Boolean(ig)}>
              Instagram-Konkurrenz:{" "}
              {ig ? (
                `über ${ig.name}`
              ) : (
                <Link href="/konten" className="underline">
                  Instagram-Konto verbinden
                </Link>
              )}
            </Check>
            <Check ok={Boolean(yt)}>
              YouTube-Suche:{" "}
              {yt ? (
                `über ${yt.name}`
              ) : (
                <Link href="/konten" className="underline">
                  YouTube-Konto verbinden
                </Link>
              )}
            </Check>
            <Check ok={examples.length > 0}>
              Beispiele:{" "}
              <Link href={`/projekte/${project.id}?tab=referenzen`} className="underline">
                {examples.length ? `${examples.length} unter Referenzen → Inspiration` : "Videos oder Screenshots unter Referenzen → Inspiration ablegen"}
              </Link>
            </Check>
            <Check ok={hasElevenLabsKey(db)}>
              Gesprochenes mitschreiben:{" "}
              {hasElevenLabsKey(db) ? (
                "über ElevenLabs"
              ) : (
                <Link href="/einstellungen#stimmen" className="underline">
                  ElevenLabs verbinden (optional)
                </Link>
              )}
            </Check>
          </ul>
          <p className="border-t border-line pt-3 text-xs text-muted">
            {last ? (
              <>
                Letzte Recherche {relative(last.createdAt)}
                {lastRun && ` · ${{ queued: "wartet", running: "läuft", done: "fertig", error: "Fehler", cancelled: "abgebrochen" }[lastRun.state]}`} ·{" "}
                <Link href={`/studio?chat=${last.id}`} className="underline">
                  ansehen
                </Link>
              </>
            ) : (
              "Noch keine Recherche."
            )}{" "}
            Automatisch:{" "}
            <Link href="/einstellungen#recherche" className="underline">
              {EVERY_LABEL[settings.research.every]}
            </Link>
            .
          </p>
        </section>
      </div>

      <section className="card mt-6 space-y-4 p-4" id="muster">
        <h2 className="h2">Muster</h2>
        <p className="text-sm text-muted">
          Bestätigte Muster stehen in <code>PROJEKT.md</code> und gelten für jeden neuen Short – im Studio und in allen Automationen. Claude schlägt sie vor,
          übernommen wird nur, was du bestätigst.
        </p>
        {proposed.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Vorschläge ({proposed.length})</h3>
            {proposed.map((l) => (
              <div key={l.id} className="rounded-lg border border-line p-3">
                <form action={decideLearningAction} className="space-y-2">
                  <input type="hidden" name="learningId" value={l.id} />
                  <input type="hidden" name="back" value={`${back}#muster`} />
                  <label className="sr-only" htmlFor={`pattern-${l.id}`}>
                    Muster (änderbar)
                  </label>
                  <textarea id={`pattern-${l.id}`} name="text" defaultValue={l.text} rows={2} maxLength={300} className="input" />
                  {l.reason && <p className="text-xs text-muted [overflow-wrap:anywhere]">Begründung: {l.reason}</p>}
                  <div className="flex flex-wrap gap-2">
                    <SubmitButton className="btn btn-primary" name="decision" value="accepted">
                      Übernehmen
                    </SubmitButton>
                    <SubmitButton className="btn" name="decision" value="rejected">
                      Ablehnen
                    </SubmitButton>
                  </div>
                </form>
              </div>
            ))}
          </div>
        )}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Gilt für neue Shorts ({accepted.length})</h3>
          {accepted.length ? (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {accepted.map((l) => (
                <li key={l.id} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{l.text}</span>
                  <form action={removeLearningAction} className="shrink-0">
                    <input type="hidden" name="learningId" value={l.id} />
                    <input type="hidden" name="back" value={`${back}#muster`} />
                    <SubmitButton className="btn py-1 text-xs" confirm="Muster entfernen? Es gilt dann nicht mehr für neue Shorts.">
                      Entfernen
                    </SubmitButton>
                  </form>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">Noch keine. Starte eine Recherche oder trag selbst ein Muster ein.</p>
          )}
        </div>
        <form action={addLearningAction} className="flex flex-col gap-2 sm:flex-row">
          <input type="hidden" name="projectId" value={project.id} />
          <input type="hidden" name="source" value="research" />
          <input type="hidden" name="back" value={`${back}#muster`} />
          <label className="sr-only" htmlFor="new-pattern">
            Eigenes Muster
          </label>
          <input id="new-pattern" name="text" required minLength={5} maxLength={300} placeholder="Eigenes Muster, z. B. „Demo-Anruf in den ersten 3 Sekunden zeigen“" className="input" />
          <SubmitButton className="btn shrink-0">Hinzufügen</SubmitButton>
        </form>
        {rejected.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-xs text-muted hover:text-fg">Abgelehnt ({rejected.length}) – Claude schlägt sie nicht erneut vor</summary>
            <ul className="mt-2 space-y-1 text-muted">
              {rejected.map((l) => (
                <li key={l.id} className="flex items-start justify-between gap-3">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{l.text}</span>
                  <form action={removeLearningAction} className="shrink-0">
                    <input type="hidden" name="learningId" value={l.id} />
                    <input type="hidden" name="back" value={`${back}#muster`} />
                    <SubmitButton className="btn py-1 text-xs">Vergessen</SubmitButton>
                  </form>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="card mt-6 space-y-3 p-4" id="berichte">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="h2">Berichte</h2>
          {reports.length > 1 && (
            <ul className="flex flex-wrap gap-1.5 text-xs">
              {reports.slice(0, 12).map((f) => (
                <li key={f}>
                  <Link
                    href={`/recherche?bericht=${encodeURIComponent(f)}#berichte`}
                    className={`rounded-md border px-2 py-0.5 ${f === shown ? "border-accent text-fg" : "border-line text-muted hover:text-fg"}`}
                  >
                    {f.replace(/\.md$/, "")}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        {report ? (
          <article className="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-4 text-sm leading-relaxed [overflow-wrap:anywhere]">{report}</article>
        ) : (
          <p className="text-sm text-muted">
            Noch kein Bericht. Nach einer Recherche liegt er hier und im Projektordner unter <code>recherche/berichte/</code>.
          </p>
        )}
        {last && lastRun?.endedAt && <p className="text-xs text-muted">Stand: {formatDateTime(lastRun.endedAt, tz)}</p>}
      </section>
    </>
  );
}
