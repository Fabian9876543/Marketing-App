import Link from "next/link";
import { connection } from "next/server";
import { approveAllAction, approvePostAction, cancelPostAction, retryTargetAction } from "@/app/actions";
import { SubmitButton } from "@/components/client";
import { Empty, Flash, NoProject, PageHeader, ProjectBadge, PlatformChip, StateBadge, Tabs, TargetBadge, VideoPreview, flashFrom } from "@/components/ui";
import { getScope, scopeFilter } from "@/lib/active-project";
import { getDb } from "@/lib/db/client";
import { listPostViews, type PostView } from "@/lib/posts";
import { getSettings } from "@/lib/settings";
import { formatDateTime, relative } from "@/lib/time";

const TABS = [
  { key: "freigabe", label: "Zur Freigabe" },
  { key: "geplant", label: "Geplant" },
  { key: "veroeffentlicht", label: "Veröffentlicht" },
  { key: "fehler", label: "Fehler" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default async function QueuePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const sp = await searchParams;
  const tab: TabKey = TABS.some((t) => t.key === sp.tab) ? (sp.tab as TabKey) : "freigabe";
  const db = getDb();
  const tz = getSettings(db).timezone;
  const scope = await getScope(db);
  if (!scope.projects.length) return <NoProject />;
  const projectId = scopeFilter(scope);
  const all = listPostViews(db, { from: new Date(Date.now() - 60 * 86_400_000), projectId });

  const groups: Record<TabKey, PostView[]> = {
    freigabe: all.filter((v) => v.display === "review"),
    geplant: all.filter((v) => ["planned", "platform", "uploading", "partial"].includes(v.display)),
    veroeffentlicht: all.filter((v) => v.display === "published").reverse(),
    fehler: all.filter((v) => v.display === "failed"),
  };
  const list = groups[tab];
  const back = `/warteschlange?tab=${tab}`;

  return (
    <>
      <PageHeader
        title={`Warteschlange · ${scope.all ? "Alle Projekte" : scope.active!.name}`}
        subtitle="Nichts geht online, bevor du es freigegeben hast."
        actions={
          tab === "freigabe" && list.length > 1 ? (
            <form action={approveAllAction}>
              {projectId && <input type="hidden" name="projectId" value={projectId} />}
              <input type="hidden" name="back" value={back} />
              <SubmitButton className="btn btn-primary" confirm={`Alle ${list.length} Posts freigeben?`}>
                Alle freigeben
              </SubmitButton>
            </form>
          ) : null
        }
      />
      <Flash {...await flashFrom(searchParams)} />
      <Tabs active={tab} tabs={TABS.map((t) => ({ ...t, href: `/warteschlange?tab=${t.key}`, count: groups[t.key].length }))} />

      {list.length === 0 ? (
        <Empty>
          {
            {
              freigabe: "Nichts wartet auf deine Freigabe.",
              geplant: "Keine geplanten Posts.",
              veroeffentlicht: "In den letzten 60 Tagen wurde nichts veröffentlicht.",
              fehler: "Keine Fehler – alles gut.",
            }[tab]
          }
        </Empty>
      ) : (
        <ul className="space-y-3">
          {list.map((v) => (
            <QueueItem key={v.id} view={v} tz={tz} back={back} showProject={scope.all} />
          ))}
        </ul>
      )}
    </>
  );
}

function QueueItem({ view, tz, back, showProject }: { view: PostView; tz: string; back: string; showProject: boolean }) {
  const overdue = view.display === "review" && view.scheduledAt < new Date();
  const caption = view.content.platformTexts.youtube?.description ?? view.content.description;
  return (
    <li className="card flex flex-col gap-4 p-4 sm:flex-row">
      {view.display === "review" && (
        <div className="w-32 shrink-0">
          <VideoPreview contentId={view.contentId} />
        </div>
      )}
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/posts/${view.id}`} className="font-semibold hover:underline">
            {view.content.title}
          </Link>
          <StateBadge state={view.display} />
          {view.createdBy === "agent" && <span className="text-xs text-muted">von Claude eingeplant</span>}
          {view.createdBy === "auto" && <span className="text-xs text-muted">automatisch eingeplant</span>}
          {showProject && <ProjectBadge project={view.project} link />}
        </div>
        <p className={`text-sm ${overdue ? "text-bad" : "text-muted"}`}>
          {formatDateTime(view.scheduledAt, tz)} ({relative(view.scheduledAt)}){overdue && " – Zeit überschritten"}
        </p>
        {view.display === "review" && caption && <p className="line-clamp-3 whitespace-pre-line text-sm">{caption}</p>}
        <ul className="space-y-1.5">
          {view.targets.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-2 text-sm">
              <PlatformChip platform={t.account.platform} />
              <span>{t.account.name}</span>
              <TargetBadge state={t.state} />
              {t.externalUrl && (
                <a href={t.externalUrl} target="_blank" rel="noreferrer" className="text-accent underline">
                  ansehen
                </a>
              )}
              {t.lastError && <span className="w-full text-xs text-bad [overflow-wrap:anywhere]">{t.lastError}</span>}
              {t.state === "handed_off" && <span className="w-full text-xs text-muted">Als Entwurf in der TikTok-App – dort Text einfügen und posten.</span>}
              {(t.state === "failed" || t.state === "missed") && (
                <form action={retryTargetAction}>
                  <input type="hidden" name="targetId" value={t.id} />
                  <input type="hidden" name="back" value={back} />
                  <SubmitButton className="btn py-1 text-xs">Jetzt erneut versuchen</SubmitButton>
                </form>
              )}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex shrink-0 flex-row gap-2 sm:flex-col">
        {view.display === "review" && (
          <form action={approvePostAction}>
            <input type="hidden" name="postId" value={view.id} />
            <input type="hidden" name="back" value={back} />
            <SubmitButton className="btn btn-primary w-full" confirm={overdue ? "Die Zeit ist schon vorbei – jetzt sofort veröffentlichen?" : undefined}>
              {overdue ? "Jetzt veröffentlichen" : "Freigeben"}
            </SubmitButton>
          </form>
        )}
        <Link href={`/posts/${view.id}`} className="btn">
          {view.display === "failed" ? "Neu planen" : "Bearbeiten"}
        </Link>
        {view.display !== "published" && (
          <form action={cancelPostAction}>
            <input type="hidden" name="postId" value={view.id} />
            <input type="hidden" name="back" value={back} />
            <SubmitButton className="btn btn-danger w-full" confirm="Post absagen?">
              Absagen
            </SubmitButton>
          </form>
        )}
      </div>
    </li>
  );
}
