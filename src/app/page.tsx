import Link from "next/link";
import { connection } from "next/server";
import { Badge, Flash, PageHeader, PlatformChip, StateBadge, flashFrom } from "@/components/ui";
import { PLATFORM_LABEL, accountsExpiringSoon, listAccounts } from "@/lib/accounts";
import { getDb } from "@/lib/db/client";
import { recentEvents } from "@/lib/events";
import { listPostViews } from "@/lib/posts";
import { missingEnv } from "@/lib/publishing/oauth";
import { oauthProviders } from "@/lib/publishing/registry";
import { getSettings, readHeartbeat, workerAlive } from "@/lib/settings";
import { listSlots } from "@/lib/slots";
import { formatDateTime, relative } from "@/lib/time";

export default async function Overview({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const db = getDb();
  const settings = getSettings(db);
  const tz = settings.timezone;
  const now = new Date();
  const views = listPostViews(db, { from: new Date(now.getTime() - 30 * 86_400_000) });
  const upcoming = views.filter((v) => v.scheduledAt >= now && v.display !== "published").slice(0, 6);
  const planned = views.filter((v) => ["planned", "platform", "uploading"].includes(v.display)).length;
  const review = views.filter((v) => v.display === "review").length;
  const failed = views.filter((v) => v.display === "failed").length;
  const published7 = views.filter((v) => v.display === "published" && v.scheduledAt > new Date(now.getTime() - 7 * 86_400_000)).length;
  const accounts = listAccounts(db);
  const alive = workerAlive(db);
  const hb = readHeartbeat(db);
  const events = recentEvents(db, 12);

  const todo: { text: string; href: string }[] = [];
  if (!alive) todo.push({ text: "Der Worker läuft nicht – ohne ihn wird nichts veröffentlicht. Starte ihn mit „pnpm dev“ oder „pnpm local:install“.", href: "/einstellungen#worker" });
  if (!accounts.length) todo.push({ text: "Noch kein Konto verbunden. Verbinde YouTube oder lege zum Ausprobieren einen Test-Kanal an.", href: "/konten" });
  if (Object.values(oauthProviders).every((p) => missingEnv(p).length > 0)) {
    todo.push({ text: "Noch keine Plattform eingerichtet – trage die Zugangsdaten in die .env ein (Anleitung in docs/SETUP.md).", href: "/konten" });
  }
  for (const a of accountsExpiringSoon(accounts)) {
    todo.push({ text: `${a.name} (${PLATFORM_LABEL[a.platform]}) muss bis ${formatDateTime(a.reconnectBy!, tz)} neu verbunden werden.`, href: "/konten" });
  }
  if (!listSlots(db).length) todo.push({ text: "Lege Posting-Zeiten an, z. B. 09:00 und 19:00.", href: "/einstellungen#slots" });
  for (const a of accounts.filter((a) => a.status === "needs_reconnect")) {
    todo.push({ text: `${a.name} muss neu verbunden werden: ${a.statusMessage ?? ""}`, href: "/konten" });
  }

  return (
    <>
      <PageHeader title="Übersicht" subtitle="Was als Nächstes rausgeht und ob alles läuft." />
      <Flash {...await flashFrom(searchParams)} />

      {todo.length > 0 && (
        <section className="card mb-6 border-warn-bg p-4">
          <h2 className="h2 mb-2">Zu erledigen</h2>
          <ul className="space-y-1.5 text-sm">
            {todo.map((t) => (
              <li key={t.text}>
                <Link href={t.href} className="text-fg underline decoration-line underline-offset-4 hover:decoration-accent">
                  {t.text}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Zur Freigabe" value={review} href="/warteschlange" tone={review ? "warn" : undefined} />
        <Stat label="Geplant" value={planned} href="/warteschlange?tab=geplant" />
        <Stat label="Fehler" value={failed} href="/warteschlange?tab=fehler" tone={failed ? "bad" : undefined} />
        <Stat label="Veröffentlicht (7 Tage)" value={published7} href="/warteschlange?tab=veroeffentlicht" />
      </section>

      <div className="grid gap-6 lg:grid-cols-5">
        <section className="min-w-0 lg:col-span-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="h2">Als Nächstes</h2>
            <Link href="/kalender" className="text-sm text-muted hover:text-fg">
              Kalender →
            </Link>
          </div>
          {upcoming.length === 0 ? (
            <p className="card p-4 text-sm text-muted">
              Nichts geplant. Plane einen Short aus dem{" "}
              <Link href="/backlog" className="underline">
                Backlog
              </Link>{" "}
              ein.
            </p>
          ) : (
            <ul className="card divide-y divide-line">
              {upcoming.map((v) => (
                <li key={v.id}>
                  <Link href={`/posts/${v.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-surface-2 sm:flex-nowrap">
                    <div className="shrink-0 whitespace-nowrap text-sm tabular-nums text-muted">{formatDateTime(v.scheduledAt, tz)}</div>
                    <div className="min-w-0 flex-1 truncate text-sm font-medium">{v.content.title}</div>
                    <div className="flex gap-1">
                      {v.targets.map((t) => (
                        <PlatformChip key={t.id} platform={t.account.platform} title={t.account.name} />
                      ))}
                    </div>
                    <StateBadge state={v.display} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="min-w-0 lg:col-span-2">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="h2">Protokoll</h2>
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <span className={`h-2 w-2 rounded-full ${alive ? "bg-ok" : "bg-bad"}`} />
              {alive ? `Worker aktiv ${hb ? relative(hb.at) : ""}` : "Worker gestoppt"}
            </span>
          </div>
          <ul className="card max-h-96 divide-y divide-line overflow-y-auto text-xs">
            {events.length === 0 && <li className="p-4 text-muted">Noch keine Ereignisse.</li>}
            {events.map((e) => (
              <li key={e.id} className="flex gap-2 px-3 py-2">
                <span className="w-14 shrink-0 tabular-nums text-muted">{formatDateTime(e.at, tz).split(" · ")[1]}</span>
                {e.level !== "info" && <Badge tone={e.level === "error" ? "bad" : "warn"}>{e.level === "error" ? "Fehler" : "Hinweis"}</Badge>}
                <span className="min-w-0 [overflow-wrap:anywhere]">{e.message}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}

function Stat({ label, value, href, tone }: { label: string; value: number; href: string; tone?: "warn" | "bad" }) {
  const color = tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-fg";
  return (
    <Link href={href} className="card p-4 hover:bg-surface-2">
      <div className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </Link>
  );
}
