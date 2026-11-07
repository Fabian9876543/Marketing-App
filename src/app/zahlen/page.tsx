import Link from "next/link";
import { connection } from "next/server";
import { addLearningAction, decideLearningAction, refreshInsightsAction, removeLearningAction, startAnalysisAction } from "@/app/actions";
import { SubmitButton } from "@/components/client";
import { Badge, Empty, Flash, NoProject, PageHeader, PlatformChip, ProjectBadge, Tabs, flashFrom } from "@/components/ui";
import { getScope, scopeFilter } from "@/lib/active-project";
import { PLATFORM_LABEL, listAccounts } from "@/lib/accounts";
import { analysisBusy, lastAnalysisSession, nextAnalysisAt } from "@/lib/analysis";
import { RATING_LABEL, STRONG_RATIO, WEAK_RATIO, bestHours, ratedItems, summarize, type RatedItem, type Rating } from "@/lib/analytics/stats";
import { insightsFetchers } from "@/lib/analytics/store";
import { getDb } from "@/lib/db/client";
import { listLearnings } from "@/lib/learnings";
import { getSettings } from "@/lib/settings";
import { sessionRuns } from "@/lib/studio/sessions";
import { formatDateTime, relative } from "@/lib/time";

const RANGES = [7, 30, 90] as const;

const compact = (n: number) => n.toLocaleString("de-DE", { notation: n >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 });
const pct = (n: number | null) => (n == null ? "–" : `${(n * 100).toFixed(1).replace(".", ",")} %`);
const ratio = (r: number) => `×${r.toFixed(1).replace(".", ",")}`;

const RATING_TONE: Record<Rating, "ok" | "bad" | "neutral" | "info"> = { stark: "ok", schwach: "bad", normal: "neutral", frisch: "info", ohne: "neutral" };

function RatingBadge({ item }: { item: RatedItem }) {
  const showRatio = item.ratio != null && item.rating !== "frisch";
  return (
    <Badge tone={RATING_TONE[item.rating]}>
      {item.rating === "stark" ? "▲ " : item.rating === "schwach" ? "▼ " : ""}
      {RATING_LABEL[item.rating]}
      {showRatio && <span className="ml-1 font-normal tabular-nums opacity-80">{ratio(item.ratio!)}</span>}
    </Badge>
  );
}

function StatTile({ label, value, delta, hint }: { label: string; value: string; delta?: { text: string; good: boolean | null }; hint?: string }) {
  return (
    <div className="card min-w-0 p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {delta && (
        <p className={`mt-0.5 text-xs tabular-nums ${delta.good == null ? "text-muted" : delta.good ? "text-ok" : "text-bad"}`}>{delta.text}</p>
      )}
      {hint && !delta && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

function deltaOf(now: number, before: number, days: number): { text: string; good: boolean | null } | undefined {
  if (!before) return undefined;
  const change = (now - before) / before;
  const sign = change > 0 ? "+" : change < 0 ? "−" : "±";
  return { text: `${sign}${Math.abs(Math.round(change * 100))} % ggü. den ${days} Tagen davor`, good: Math.abs(change) < 0.005 ? null : change > 0 };
}

export default async function NumbersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const db = getDb();
  const scope = await getScope(db);
  if (!scope.projects.length) return <NoProject />;
  const sp = await searchParams;
  const days = RANGES.find((r) => String(r) === sp.tage) ?? 30;
  const projectId = scopeFilter(scope);
  const project = scope.active;
  const settings = getSettings(db);
  const tz = settings.timezone;
  const now = new Date();

  const accounts = listAccounts(db, { projectId }).filter((a) => insightsFetchers[a.platform]);
  // Ein Abruf über 2 Zeiträume: aktueller Zeitraum + der davor (für die Veränderung)
  const wide = ratedItems(db, { projectId, days: Math.min(90, days * 2), now });
  const since = now.getTime() - days * 86_400_000;
  const items = wide.filter((i) => i.publishedAt.getTime() >= since);
  const previous = days * 2 <= 90 ? wide.filter((i) => i.publishedAt.getTime() < since) : [];
  const s = summarize(items);
  const p = summarize(previous);
  const strong = items.filter((i) => i.rating === "stark").length;
  const weak = items.filter((i) => i.rating === "schwach").length;
  const top = items
    .filter((i) => i.ratio != null && i.rating !== "frisch")
    .sort((a, b) => b.ratio! - a.ratio!)
    .slice(0, 3);
  const hours = bestHours(items, tz);
  const maxPlatformViews = Math.max(1, ...s.byPlatform.map((b) => b.views));
  const lastFetch = accounts.map((a) => a.insightsAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
  const problems = accounts.filter((a) => a.insightsError);

  const learnings = project ? listLearnings(db, project.id) : [];
  const proposed = learnings.filter((l) => l.status === "proposed");
  const accepted = learnings.filter((l) => l.status === "accepted");
  const rejected = learnings.filter((l) => l.status === "rejected");
  const lastAnalysis = project ? lastAnalysisSession(db, project.id) : undefined;
  const lastAnalysisRun = lastAnalysis ? sessionRuns(db, lastAnalysis.id).at(-1) : undefined;
  const busy = project ? analysisBusy(db, project.id) : false;
  const nextAnalysis =
    project && settings.analytics.weekly
      ? nextAnalysisAt(project.analysisAt ?? new Date(now.getTime() - 7 * 86_400_000), settings.analytics.weekday, settings.analytics.time, tz)
      : null;

  return (
    <>
      <PageHeader
        title={project ? `Zahlen · ${project.name}` : "Zahlen · alle Projekte"}
        subtitle={
          <>
            Jeder Beitrag wird mit dem Median seines Kanals (letzte 90 Tage) verglichen: stark ab {ratio(STRONG_RATIO)}, schwach bis {ratio(WEAK_RATIO)}.
            {lastFetch ? ` Zuletzt abgerufen ${relative(lastFetch)}.` : ""}
          </>
        }
        actions={
          <>
            <form action={refreshInsightsAction}>
              {projectId && <input type="hidden" name="projectId" value={projectId} />}
              <input type="hidden" name="back" value={`/zahlen?tage=${days}`} />
              <SubmitButton className="btn" pendingText="Rufe ab …">
                Jetzt aktualisieren
              </SubmitButton>
            </form>
            {project && (
              <form action={startAnalysisAction}>
                <input type="hidden" name="projectId" value={project.id} />
                <input type="hidden" name="back" value={`/zahlen?tage=${days}`} />
                <SubmitButton className="btn btn-primary" pendingText="Starte …" disabled={busy}>
                  {busy ? "Analyse läuft …" : "Wochenanalyse jetzt starten"}
                </SubmitButton>
              </form>
            )}
          </>
        }
      />
      <Flash {...await flashFrom(searchParams)} />

      <Tabs active={String(days)} tabs={RANGES.map((r) => ({ key: String(r), label: `${r} Tage`, href: `/zahlen?tage=${r}` }))} />

      {problems.length > 0 && (
        <div className="mb-5 space-y-1 rounded-lg bg-warn-bg px-4 py-2.5 text-sm text-warn">
          {problems.map((a) => (
            <p key={a.id} className="[overflow-wrap:anywhere]">
              <strong>{a.name}</strong> ({PLATFORM_LABEL[a.platform]}): {a.insightsError}
            </p>
          ))}
          <p>
            <Link href="/konten" className="underline">
              Zu den Konten
            </Link>
          </p>
        </div>
      )}

      {accounts.length === 0 ? (
        <Empty
          action={
            <Link href="/konten" className="btn btn-primary">
              Konto verbinden
            </Link>
          }
        >
          Noch kein Konto verbunden. Sobald Konten verbunden sind, holt der Worker alle {settings.analytics.fetchEveryHours} Stunden die Zahlen.
        </Empty>
      ) : items.length === 0 ? (
        <Empty>
          Keine Beiträge aus den letzten {days} Tagen{lastFetch ? "" : " – die Zahlen wurden noch nicht abgerufen"}. Mit „Jetzt aktualisieren“ holst du sie sofort.
        </Empty>
      ) : (
        <div className="space-y-6">
          <section aria-label="Kennzahlen" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Beiträge" value={compact(s.posts)} delta={previous.length ? deltaOf(s.posts, p.posts, days) : undefined} />
            <StatTile label="Views" value={compact(s.views)} delta={previous.length ? deltaOf(s.views, p.views, days) : undefined} hint="aller Beiträge aus dem Zeitraum" />
            <StatTile label="Interaktionsrate" value={pct(s.engagement)} hint={`${compact(s.likes)} Likes · ${compact(s.comments)} Kommentare · ${compact(s.shares)} Shares`} />
            <StatTile label="Stark / schwach" value={`${strong} / ${weak}`} hint={`von ${items.filter((i) => i.rating !== "frisch" && i.rating !== "ohne").length} bewerteten`} />
          </section>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <section className="card space-y-3 p-4">
              <h2 className="h2">Views nach Plattform</h2>
              <ul className="space-y-3">
                {s.byPlatform.map((b) => (
                  <li key={b.platform} title={`${PLATFORM_LABEL[b.platform]}: ${b.views.toLocaleString("de-DE")} Views aus ${b.posts} Beiträgen`}>
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <PlatformChip platform={b.platform} />
                        <span className="truncate">{PLATFORM_LABEL[b.platform]}</span>
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {compact(b.views)} <span className="text-xs text-muted">· {b.posts}</span>
                      </span>
                    </div>
                    <div className="mt-1.5 h-2 w-full">
                      <div className="h-2 rounded-r bg-accent" style={{ width: `${Math.max(1, (b.views / maxPlatformViews) * 100)}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted">Zahl hinter den Views: Anzahl Beiträge.</p>
            </section>

            <section className="card space-y-3 p-4">
              <h2 className="h2">Stärkste Beiträge</h2>
              {top.length ? (
                <ol className="space-y-2.5">
                  {top.map((i) => (
                    <li key={i.id} className="min-w-0 text-sm">
                      <div className="flex items-center gap-2">
                        <PlatformChip platform={i.platform} />
                        <span className="truncate font-medium">{i.title || "(ohne Titel)"}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted tabular-nums">
                        {ratio(i.ratio!)} des Kanals · {i.views?.toLocaleString("de-DE") ?? "–"} Views · {formatDateTime(i.publishedAt, tz)}
                      </p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-muted">Noch nichts zu vergleichen: Pro Kanal braucht es mindestens 3 Beiträge, die älter als 48 Stunden sind.</p>
              )}
            </section>

            <section className="card space-y-3 p-4">
              <h2 className="h2">Beste Uhrzeiten</h2>
              {hours.length ? (
                <ul className="space-y-1.5 text-sm">
                  {hours.map((h) => (
                    <li key={h.hour} className="flex justify-between gap-2 tabular-nums">
                      <span>
                        {String(h.hour).padStart(2, "0")}:00–{String(h.hour).padStart(2, "0")}:59
                      </span>
                      <span className="text-muted">
                        {ratio(h.medianRatio)} · {h.posts} Beiträge
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">Braucht mindestens zwei bewertete Beiträge pro Uhrzeit.</p>
              )}
              <p className="text-xs text-muted">Median im Verhältnis zum Kanal, Uhrzeit der Veröffentlichung ({tz}).</p>
            </section>
          </div>
        </div>
      )}

      {project ? (
        <section className="card mt-6 space-y-4 p-4" id="erkenntnisse">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="h2">Erkenntnisse</h2>
            <p className="text-xs text-muted">
              {lastAnalysis ? (
                <>
                  Letzte Analyse {relative(lastAnalysis.createdAt)}
                  {lastAnalysisRun && ` · ${{ queued: "wartet", running: "läuft", done: "fertig", error: "Fehler", cancelled: "abgebrochen" }[lastAnalysisRun.state]}`} ·{" "}
                  <Link href={`/studio?chat=${lastAnalysis.id}`} className="underline">
                    ansehen
                  </Link>
                </>
              ) : (
                "Noch keine Analyse"
              )}
              {nextAnalysis && ` · nächste ${formatDateTime(nextAnalysis, tz)}`}
            </p>
          </div>
          <p className="text-sm text-muted">
            Bestätigte Erkenntnisse stehen in <code>PROJEKT.md</code> und gelten für jeden neuen Short – im Studio und in allen Automationen. Claude schlägt neue
            vor, übernommen wird nur, was du bestätigst.
          </p>

          {proposed.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Vorschläge ({proposed.length})</h3>
              {proposed.map((l) => (
                <div key={l.id} className="rounded-lg border border-line p-3">
                  <form action={decideLearningAction} className="space-y-2">
                    <input type="hidden" name="learningId" value={l.id} />
                    <input type="hidden" name="back" value={`/zahlen?tage=${days}#erkenntnisse`} />
                    <label className="sr-only" htmlFor={`learning-${l.id}`}>
                      Erkenntnis (änderbar)
                    </label>
                    <textarea id={`learning-${l.id}`} name="text" defaultValue={l.text} rows={2} maxLength={300} className="input" />
                    {l.reason && <p className="text-xs text-muted">Begründung: {l.reason}</p>}
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
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {l.text}
                      {l.source === "manual" && <span className="ml-2 text-xs text-muted">(von dir)</span>}
                    </span>
                    <form action={removeLearningAction} className="shrink-0">
                      <input type="hidden" name="learningId" value={l.id} />
                      <input type="hidden" name="back" value={`/zahlen?tage=${days}#erkenntnisse`} />
                      <SubmitButton className="btn py-1 text-xs" confirm="Erkenntnis entfernen? Sie gilt dann nicht mehr für neue Shorts.">
                        Entfernen
                      </SubmitButton>
                    </form>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Noch keine. Starte eine Wochenanalyse oder trag selbst eine ein.</p>
            )}
          </div>

          <form action={addLearningAction} className="flex flex-col gap-2 sm:flex-row">
            <input type="hidden" name="projectId" value={project.id} />
            <input type="hidden" name="back" value={`/zahlen?tage=${days}#erkenntnisse`} />
            <label className="sr-only" htmlFor="new-learning">
              Eigene Erkenntnis
            </label>
            <input id="new-learning" name="text" required minLength={5} maxLength={300} placeholder="Eigene Erkenntnis, z. B. „Untertitel immer groß und mittig“" className="input" />
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
                      <input type="hidden" name="back" value={`/zahlen?tage=${days}#erkenntnisse`} />
                      <SubmitButton className="btn py-1 text-xs">Vergessen</SubmitButton>
                    </form>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      ) : (
        <p className="mt-6 text-sm text-muted">Erkenntnisse und Wochenanalyse gibt es pro Projekt – wähle links ein Projekt.</p>
      )}

      {items.length > 0 && (
        <section className="mt-6">
          <h2 className="h2 mb-3">Alle Beiträge ({items.length})</h2>
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b border-line text-left text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Veröffentlicht</th>
                  <th className="px-3 py-2 font-medium">Beitrag</th>
                  <th className="px-3 py-2 font-medium">Bewertung</th>
                  <th className="px-3 py-2 text-right font-medium">Views</th>
                  <th className="px-3 py-2 text-right font-medium">Likes</th>
                  <th className="px-3 py-2 text-right font-medium">Komm.</th>
                  <th className="px-3 py-2 text-right font-medium">Shares</th>
                  <th className="px-3 py-2 text-right font-medium">Interaktion</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((i) => (
                  <tr key={i.id} className="align-top">
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted">{formatDateTime(i.publishedAt, tz)}</td>
                    <td className="max-w-[320px] px-3 py-2">
                      <div className="flex items-center gap-2">
                        <PlatformChip platform={i.platform} title={`${PLATFORM_LABEL[i.platform]} · ${i.account.name}`} />
                        {i.url ? (
                          <a href={i.url} target="_blank" rel="noreferrer" className="truncate hover:underline">
                            {i.title || "(ohne Titel)"}
                          </a>
                        ) : (
                          <span className="truncate">{i.title || "(ohne Titel)"}</span>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                        {scope.all && <ProjectBadge project={scope.projects.find((x) => x.id === i.projectId) ?? { id: i.projectId, name: "?", color: "#888" }} />}
                        {i.contentSlug ? (
                          <span className="font-mono [overflow-wrap:anywhere]" title="Über das Studio veröffentlicht – Ordner im Backlog">
                            {i.contentSlug}
                          </span>
                        ) : i.targetId ? (
                          <span>über das Studio</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <RatingBadge item={i} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{i.views?.toLocaleString("de-DE") ?? "–"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{i.likes?.toLocaleString("de-DE") ?? "–"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{i.comments?.toLocaleString("de-DE") ?? "–"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{i.shares?.toLocaleString("de-DE") ?? "–"}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">{pct(i.engagement)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">
            Median pro Kanal:{" "}
            {[...new Map(items.map((i) => [i.accountId, i])).values()]
              .map((i) => `${i.account.name} (${PLATFORM_LABEL[i.platform]}) ${i.channelMedian == null ? "–" : Math.round(i.channelMedian).toLocaleString("de-DE")} Views`)
              .join(" · ")}
            . LinkedIn liefert Zahlen nur mit einer gesonderten Freigabe – siehe Einrichtung.
          </p>
        </section>
      )}
    </>
  );
}
