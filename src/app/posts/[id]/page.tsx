import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { approvePostAction, cancelPostAction, deletePostAction, reschedulePostAction, retryTargetAction } from "@/app/actions";
import { SubmitButton } from "@/components/client";
import { Badge, Flash, PageHeader, PlatformChip, StateBadge, TargetBadge, VideoPreview, flashFrom } from "@/components/ui";
import { getDb } from "@/lib/db/client";
import { getPostView } from "@/lib/posts";
import { captionFor } from "@/lib/publishing/captions";
import { buildMetadata } from "@/lib/publishing/youtube/publisher";
import { getSettings } from "@/lib/settings";
import { formatDateTime, relative, toLocalInput } from "@/lib/time";

export default async function PostPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const id = Number((await params).id);
  const db = getDb();
  const view = Number.isInteger(id) ? getPostView(db, id) : undefined;
  if (!view) notFound();
  const settings = getSettings(db);
  const tz = settings.timezone;
  const back = `/posts/${view.id}`;
  const editable = view.state !== "cancelled" && view.display !== "published" && view.display !== "uploading";
  const hasYoutube = view.targets.some((t) => t.account.platform === "youtube");
  const yt = hasYoutube ? buildMetadata(view.content, settings) : null;
  const captionPlatforms = (["instagram", "tiktok", "linkedin"] as const).filter((p) => view.targets.some((t) => t.account.platform === p));
  const canDelete = !view.targets.some((t) => ["uploading", "scheduled", "published", "handed_off"].includes(t.state));

  return (
    <>
      <PageHeader
        title={view.content.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StateBadge state={view.display} />
            {formatDateTime(view.scheduledAt, tz)} · {relative(view.scheduledAt)}
          </span>
        }
        actions={
          <Link href="/kalender" className="btn">
            ← Kalender
          </Link>
        }
      />
      <Flash {...await flashFrom(searchParams)} />

      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <div className="mx-auto w-full max-w-[220px]">
          <VideoPreview contentId={view.contentId} />
          <p className="mt-2 break-all text-xs text-muted">{view.content.slug}</p>
        </div>

        <div className="min-w-0 space-y-6">
          <section className="card p-4">
            <h2 className="h2 mb-3">Veröffentlichung</h2>
            <ul className="divide-y divide-line">
              {view.targets.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <PlatformChip platform={t.account.platform} />
                  <span className="font-medium">{t.account.name}</span>
                  <TargetBadge state={t.state} />
                  {t.attempts > 0 && <span className="text-xs text-muted">{t.attempts} Versuch(e)</span>}
                  {t.syncNeeded && <Badge tone="info">Änderung wird übertragen</Badge>}
                  {t.nextAttemptAt && t.state === "pending" && (
                    <span className="text-xs text-muted">nächster Versuch {relative(t.nextAttemptAt)}</span>
                  )}
                  {t.externalUrl && (
                    <a href={t.externalUrl} target="_blank" rel="noreferrer" className="text-accent underline">
                      ansehen
                    </a>
                  )}
                  {(t.state === "failed" || t.state === "missed") && (
                    <form action={retryTargetAction} className="ml-auto">
                      <input type="hidden" name="targetId" value={t.id} />
                      <input type="hidden" name="back" value={back} />
                      <SubmitButton className="btn py-1 text-xs">Jetzt erneut versuchen</SubmitButton>
                    </form>
                  )}
                  {t.lastError && <p className="w-full text-xs text-bad [overflow-wrap:anywhere]">{t.lastError}</p>}
                  {t.state === "handed_off" && (
                    <p className="w-full text-xs text-muted">Liegt als Entwurf in deiner TikTok-App – Text unten kopieren, dort einfügen und posten.</p>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {editable && (
            <section className="card space-y-4 p-4">
              <h2 className="h2">Ändern</h2>
              <form action={reschedulePostAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="postId" value={view.id} />
                <input type="hidden" name="back" value={back} />
                <div>
                  <label className="label" htmlFor="at">
                    Neue Zeit ({tz})
                  </label>
                  <input id="at" type="datetime-local" name="at" defaultValue={toLocalInput(view.scheduledAt, tz)} className="input w-auto" required />
                </div>
                <SubmitButton>Verschieben</SubmitButton>
              </form>
              <div className="flex flex-wrap gap-2 border-t border-line pt-4">
                {view.state === "review" && (
                  <form action={approvePostAction}>
                    <input type="hidden" name="postId" value={view.id} />
                    <input type="hidden" name="back" value={back} />
                    <SubmitButton className="btn btn-primary">Freigeben</SubmitButton>
                  </form>
                )}
                <form action={cancelPostAction}>
                  <input type="hidden" name="postId" value={view.id} />
                  <input type="hidden" name="back" value={back} />
                  <SubmitButton
                    className="btn btn-danger"
                    confirm={
                      view.targets.some((t) => t.state === "scheduled")
                        ? "Post absagen? Das bereits bei YouTube eingeplante (private) Video wird dort gelöscht."
                        : "Post absagen?"
                    }
                  >
                    Absagen
                  </SubmitButton>
                </form>
              </div>
            </section>
          )}

          {canDelete && (view.state === "cancelled" || view.state === "review") && (
            <form action={deletePostAction}>
              <input type="hidden" name="postId" value={view.id} />
              <input type="hidden" name="back" value={back} />
              <SubmitButton className="btn btn-danger" confirm="Post endgültig löschen? Das Video im Backlog bleibt erhalten.">
                Post löschen
              </SubmitButton>
            </form>
          )}

          <section className="card p-4">
            <h2 className="h2 mb-3">Texte je Plattform</h2>
            <div className="space-y-4">
              {yt && (
                <div>
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <PlatformChip platform="youtube" />
                    <span className="text-sm font-medium">{yt.snippet.title}</span>
                    <Badge>Sichtbarkeit: {{ public: "öffentlich", unlisted: "nicht gelistet", private: "privat" }[settings.youtube.privacy]}</Badge>
                    <Badge tone={view.content.aiGenerated ? "info" : "neutral"}>
                      {view.content.aiGenerated ? "Als KI-Inhalt gekennzeichnet" : "Keine KI-Kennzeichnung"}
                    </Badge>
                  </div>
                  <p className="whitespace-pre-line text-sm text-muted">{yt.snippet.description || "–"}</p>
                </div>
              )}
              {captionPlatforms.map((p) => (
                <div key={p}>
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <PlatformChip platform={p} />
                    {p === "tiktok" && settings.tiktok.mode === "draft" && (
                      <span className="text-xs text-muted">Entwurf: Text in der TikTok-App einfügen, KI-Label dort setzen</span>
                    )}
                  </div>
                  <textarea readOnly rows={6} className="input text-sm" defaultValue={captionFor(p, view.content, settings)} />
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted">
              Texte änderst du in der <code>meta.json</code> im Backlog-Ordner (Feld <code>platforms</code>), danach „Neu einlesen“.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
