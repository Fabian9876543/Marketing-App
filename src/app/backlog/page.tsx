import { desc } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { importBacklogAction, openContentFolderAction, schedulePostAction } from "@/app/actions";
import { SubmitButton } from "@/components/client";
import { Badge, Empty, Flash, PageHeader, PlatformChip, VideoPreview, flashFrom } from "@/components/ui";
import { listAccounts } from "@/lib/accounts";
import { backlogDir } from "@/lib/backlog";
import { getDb } from "@/lib/db/client";
import { contents, type Account, type Content } from "@/lib/db/schema";
import { formatWarnings } from "@/lib/media";
import { contentUsage, takenTimes } from "@/lib/posts";
import { getSettings } from "@/lib/settings";
import { listSlots, nextFreeSlot } from "@/lib/slots";
import { formatDateTime, toLocalInput } from "@/lib/time";

export default async function BacklogPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const db = getDb();
  const settings = getSettings(db);
  const items = db.select().from(contents).orderBy(desc(contents.available), desc(contents.createdAt)).all();
  const usage = contentUsage(db);
  const accounts = listAccounts(db).filter((a) => a.status !== "disabled");
  const nextSlot = nextFreeSlot(listSlots(db), takenTimes(db, new Date()), new Date(), settings.timezone);
  const defaultTime = toLocalInput(nextSlot ?? new Date(Date.now() + 3600_000), settings.timezone);

  return (
    <>
      <PageHeader
        title="Backlog"
        subtitle={
          <>
            Fertige Shorts aus <code className="rounded bg-surface-2 px-1 text-xs [overflow-wrap:anywhere]">{backlogDir(settings.contentDir)}</code> – ein Ordner pro Short.
          </>
        }
        actions={
          <>
            <form action={openContentFolderAction}>
              <input type="hidden" name="back" value="/backlog" />
              <SubmitButton>Ordner öffnen</SubmitButton>
            </form>
            <form action={importBacklogAction}>
              <input type="hidden" name="back" value="/backlog" />
              <SubmitButton className="btn btn-primary" pendingText="Lese ein …">
                Neu einlesen
              </SubmitButton>
            </form>
          </>
        }
      />
      <Flash {...await flashFrom(searchParams)} />

      <details className="card mb-6 p-4">
        <summary className="cursor-pointer text-sm font-medium">Video hochladen</summary>
        <form action="/api/backlog/upload" method="post" encType="multipart/form-data" className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="md:col-span-2">
            <label className="label" htmlFor="file">
              Videodatei (MP4/MOV, am besten 9:16)
            </label>
            <input id="file" name="file" type="file" accept="video/mp4,video/quicktime,.m4v" required className="input" />
          </div>
          <div>
            <label className="label" htmlFor="title">
              Titel
            </label>
            <input id="title" name="title" required maxLength={100} className="input" placeholder="z. B. Anruf um 22 Uhr – wer geht ran?" />
          </div>
          <div>
            <label className="label" htmlFor="hashtags">
              Hashtags
            </label>
            <input id="hashtags" name="hashtags" className="input" placeholder="#KI #Telefonassistent" />
          </div>
          <div className="md:col-span-2">
            <label className="label" htmlFor="description">
              Beschreibung
            </label>
            <textarea id="description" name="description" rows={3} className="input" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="aiGenerated" /> Enthält KI-Stimme oder realistische KI-Bilder (wird gekennzeichnet)
          </label>
          <div className="md:text-right">
            <button className="btn btn-primary">Hochladen</button>
          </div>
        </form>
      </details>

      {items.length === 0 ? (
        <Empty>
          Noch keine Shorts im Backlog. Lege einen Ordner mit <code>video.mp4</code> (und optional <code>meta.json</code>) im Backlog-Ordner an
          oder lade oben ein Video hoch.
        </Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((c) => (
            <ContentCard
              key={c.id}
              content={c}
              usage={usage.get(c.id)}
              accounts={accounts}
              defaultTime={defaultTime}
              nextSlotLabel={nextSlot ? formatDateTime(nextSlot, settings.timezone) : null}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ContentCard({
  content,
  usage,
  accounts,
  defaultTime,
  nextSlotLabel,
}: {
  content: Content;
  usage?: { planned: number; published: number };
  accounts: Account[];
  defaultTime: string;
  nextSlotLabel: string | null;
}) {
  const warnings = formatWarnings(content);
  return (
    <article className={`card flex flex-col overflow-hidden ${content.available ? "" : "opacity-60"}`}>
      <div className="flex gap-3 p-3">
        <div className="w-28 shrink-0">
          {content.available ? <VideoPreview contentId={content.id} /> : <div className="aspect-[9/16] rounded-lg bg-surface-2" />}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <h3 className="text-sm font-semibold leading-snug">{content.title}</h3>
          <p className="truncate text-xs text-muted" title={content.slug}>
            {content.slug}
          </p>
          <div className="flex flex-wrap gap-1">
            {!content.available && <Badge tone="bad">Datei fehlt</Badge>}
            {content.durationSec != null && <Badge>{Math.round(content.durationSec)} s</Badge>}
            {content.width && content.height && (
              <Badge>
                {content.width}×{content.height}
              </Badge>
            )}
            {content.aiGenerated && <Badge tone="info">KI-Kennzeichnung</Badge>}
            {usage?.published ? <Badge tone="ok">{usage.published}× veröffentlicht</Badge> : null}
            {usage?.planned ? <Badge tone="info">{usage.planned}× geplant</Badge> : null}
          </div>
          {warnings.map((w) => (
            <p key={w} className="text-xs text-warn">
              {w}
            </p>
          ))}
          {content.hashtags.length > 0 && <p className="text-xs text-muted">{content.hashtags.join(" ")}</p>}
        </div>
      </div>

      {content.available && (
        <form action={schedulePostAction} className="mt-auto space-y-3 border-t border-line bg-surface-2/50 p-3">
          <input type="hidden" name="contentId" value={content.id} />
          <input type="hidden" name="back" value="/backlog" />
          {accounts.length === 0 ? (
            <p className="text-xs text-muted">
              <Link href="/konten" className="underline">
                Verbinde zuerst ein Konto
              </Link>
              , um einzuplanen.
            </p>
          ) : (
            <>
              <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
                <legend className="label">Konten</legend>
                {accounts.map((a) => (
                  <label key={a.id} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" name="accountIds" value={a.id} defaultChecked={a.status === "active"} />
                    <PlatformChip platform={a.platform} /> {a.name}
                  </label>
                ))}
              </fieldset>
              <fieldset className="space-y-1.5 text-sm">
                <legend className="label">Wann</legend>
                <label className="flex items-center gap-2">
                  <input type="radio" name="mode" value="slot" defaultChecked={Boolean(nextSlotLabel)} disabled={!nextSlotLabel} />
                  Nächster freier Slot {nextSlotLabel ? <span className="text-muted">({nextSlotLabel})</span> : <span className="text-muted">(keine Slots angelegt)</span>}
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="mode" value="time" defaultChecked={!nextSlotLabel} />
                  <input type="datetime-local" name="at" defaultValue={defaultTime} className="input w-auto py-1" />
                </label>
              </fieldset>
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" name="approve" defaultChecked /> Direkt freigeben
                </label>
                <SubmitButton className="btn btn-primary">Einplanen</SubmitButton>
              </div>
            </>
          )}
        </form>
      )}
    </article>
  );
}
