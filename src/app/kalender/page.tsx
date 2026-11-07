import { DateTime } from "luxon";
import Link from "next/link";
import { connection } from "next/server";
import { Flash, NoProject, PageHeader, PlatformChip, flashFrom } from "@/components/ui";
import { getScope, scopeFilter } from "@/lib/active-project";
import { getDb } from "@/lib/db/client";
import { listPostViews, type DisplayState, type PostView } from "@/lib/posts";
import { getSettings } from "@/lib/settings";
import { listSlots, slotOccurrences } from "@/lib/slots";

const BORDER: Record<DisplayState, string> = {
  review: "border-l-warn",
  planned: "border-l-info",
  platform: "border-l-info",
  uploading: "border-l-info",
  published: "border-l-ok",
  partial: "border-l-warn",
  failed: "border-l-bad",
  cancelled: "border-l-line",
};

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function CalendarPage({ searchParams }: { searchParams: SP }) {
  await connection();
  const sp = await searchParams;
  const db = getDb();
  const tz = getSettings(db).timezone;
  const scope = await getScope(db);
  if (!scope.projects.length) return <NoProject />;
  const view = sp.ansicht === "monat" ? "monat" : "woche";
  const today = DateTime.now().setZone(tz).startOf("day");
  const parsed = typeof sp.datum === "string" ? DateTime.fromISO(sp.datum, { zone: tz }) : null;
  const anchor = parsed?.isValid ? parsed.startOf("day") : today;

  const start = view === "woche" ? anchor.startOf("week") : anchor.startOf("month").startOf("week");
  const days = view === "woche" ? 7 : 42;
  const end = start.plus({ days });
  const posts = listPostViews(db, { from: start.toJSDate(), to: end.toJSDate(), projectId: scopeFilter(scope) });
  // Freie Slots nur, wenn ein einzelnes Projekt gewählt ist (jedes Projekt hat eigene Zeiten).
  const freeSlots = view === "woche" && scope.active ? slotOccurrences(listSlots(db, scope.active.id), new Date(), end.toJSDate(), tz) : [];

  const step = view === "woche" ? { weeks: 1 } : { months: 1 };
  const href = (d: DateTime, v = view) => `/kalender?ansicht=${v}&datum=${d.toISODate()}`;
  const title =
    view === "woche"
      ? `${start.setLocale("de").toFormat("d. LLL")} – ${end.minus({ days: 1 }).setLocale("de").toFormat("d. LLL yyyy")}`
      : anchor.setLocale("de").toFormat("LLLL yyyy");

  const byDay = new Map<string, PostView[]>();
  for (const p of posts) {
    const key = DateTime.fromJSDate(p.scheduledAt, { zone: tz }).toISODate()!;
    byDay.set(key, [...(byDay.get(key) ?? []), p]);
  }

  return (
    <>
      <PageHeader
        title={`Kalender · ${scope.all ? "Alle Projekte" : scope.active!.name}`}
        subtitle={title}
        actions={
          <>
            <div className="flex overflow-hidden rounded-lg border border-line text-sm">
              <Link href={href(anchor, "woche")} className={`px-3 py-1.5 ${view === "woche" ? "bg-surface font-medium" : "text-muted"}`}>
                Woche
              </Link>
              <Link href={href(anchor, "monat")} className={`px-3 py-1.5 ${view === "monat" ? "bg-surface font-medium" : "text-muted"}`}>
                Monat
              </Link>
            </div>
            <Link className="btn" href={href(anchor.minus(step))} aria-label="Zurück">
              ←
            </Link>
            <Link className="btn" href={href(today)}>
              Heute
            </Link>
            <Link className="btn" href={href(anchor.plus(step))} aria-label="Weiter">
              →
            </Link>
          </>
        }
      />
      <Flash {...await flashFrom(searchParams)} />

      {view === "woche" ? (
        <div className="grid gap-2 md:grid-cols-7">
          {Array.from({ length: 7 }, (_, i) => start.plus({ days: i })).map((day) => {
            const key = day.toISODate()!;
            const items = byDay.get(key) ?? [];
            const taken = new Set(items.map((p) => DateTime.fromJSDate(p.scheduledAt, { zone: tz }).toFormat("HH:mm")));
            const free = freeSlots
              .map((d) => DateTime.fromJSDate(d, { zone: tz }))
              .filter((d) => d.toISODate() === key && !taken.has(d.toFormat("HH:mm")));
            const isToday = day.hasSame(today, "day");
            return (
              <section key={key} className={`card p-2 md:min-h-40 ${isToday ? "ring-2 ring-accent" : ""}`}>
                <h2 className="flex items-baseline justify-between px-1 text-xs md:mb-2">
                  <span className="font-semibold uppercase text-muted">{day.setLocale("de").toFormat("ccc")}</span>
                  <span className={isToday ? "font-semibold text-accent" : "text-muted"}>{day.toFormat("dd.LL.")}</span>
                </h2>
                <ul className="space-y-1.5 [&:not(:empty)]:mt-2 md:[&:not(:empty)]:mt-0">
                  {[
                    ...items.map((p) => ({ at: p.scheduledAt.getTime(), node: <PostChip key={`p${p.id}`} post={p} tz={tz} showProject={scope.all} /> })),
                    ...free.map((d) => ({
                      at: d.toMillis(),
                      node: (
                        <li key={`s${d.toMillis()}`} className="rounded-md border border-dashed border-line px-2 py-1 text-xs text-muted">
                          {d.toFormat("HH:mm")} · freier Slot
                        </li>
                      ),
                    })),
                  ]
                    .sort((a, b) => a.at - b.at)
                    .map((x) => x.node)}
                </ul>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="grid grid-cols-7 border-b border-line bg-surface-2 text-center text-xs font-semibold uppercase text-muted">
            {["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map((d) => (
              <div key={d} className="py-1.5">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {Array.from({ length: 42 }, (_, i) => start.plus({ days: i })).map((day) => {
              const items = byDay.get(day.toISODate()!) ?? [];
              const inMonth = day.month === anchor.month;
              return (
                <Link
                  key={day.toISODate()}
                  href={href(day, "woche")}
                  className={`min-h-24 border-b border-r border-line p-1.5 text-xs hover:bg-surface-2 ${inMonth ? "" : "bg-surface-2/40 text-muted"}`}
                >
                  <div className={`mb-1 ${day.hasSame(today, "day") ? "font-bold text-accent" : ""}`}>{day.day}</div>
                  <ul className="space-y-0.5">
                    {items.slice(0, 3).map((p) => (
                      <li key={p.id} className={`flex items-center gap-1 truncate border-l-2 pl-1 ${BORDER[p.display]}`}>
                        {scope.all && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: p.project.color }} />}
                        <span className="truncate">
                          {DateTime.fromJSDate(p.scheduledAt, { zone: tz }).toFormat("HH:mm")} {p.content.title}
                        </span>
                      </li>
                    ))}
                    {items.length > 3 && <li className="text-muted">+{items.length - 3} weitere</li>}
                  </ul>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      <p className="mt-4 text-xs text-muted">
        Farben: <span className="text-warn">gelb</span> = wartet auf Freigabe, <span className="text-info">blau</span> = geplant,{" "}
        <span className="text-ok">grün</span> = veröffentlicht, <span className="text-bad">rot</span> = Fehler. Klick auf einen Post zum Verschieben,
        Freigeben oder Absagen.
      </p>
    </>
  );
}

function PostChip({ post, tz, showProject }: { post: PostView; tz: string; showProject: boolean }) {
  return (
    <li>
      <Link
        href={`/posts/${post.id}`}
        className={`block rounded-md border border-line border-l-4 bg-surface px-2 py-1.5 text-xs hover:bg-surface-2 ${BORDER[post.display]}`}
      >
        <div className="flex items-center justify-between gap-1">
          <span className="font-semibold tabular-nums">{DateTime.fromJSDate(post.scheduledAt, { zone: tz }).toFormat("HH:mm")}</span>
          <span className="flex gap-0.5">
            {post.targets.map((t) => (
              <PlatformChip key={t.id} platform={t.account.platform} title={t.account.name} />
            ))}
          </span>
        </div>
        <div className="mt-0.5 line-clamp-2 leading-snug">{post.content.title}</div>
        {showProject && (
          <div className="mt-1 flex items-center gap-1 text-[11px] text-muted">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: post.project.color }} />
            {post.project.name}
          </div>
        )}
      </Link>
    </li>
  );
}
