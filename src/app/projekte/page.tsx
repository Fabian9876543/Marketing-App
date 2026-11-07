import Link from "next/link";
import { connection } from "next/server";
import { archiveProjectAction, switchProjectAction } from "@/app/actions";
import { SubmitButton } from "@/components/client";
import { Badge, Flash, NoProject, PageHeader, flashFrom } from "@/components/ui";
import { getDb } from "@/lib/db/client";
import { listProjects, projectStats } from "@/lib/projects";

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const db = getDb();
  const all = listProjects(db, { includeArchived: true });
  const stats = projectStats(db);
  const active = all.filter((p) => !p.archived);
  const archived = all.filter((p) => p.archived);

  return (
    <>
      <PageHeader
        title="Projekte"
        subtitle="Jedes Projekt hat eigenen Ordner, eigene Konten, Posting-Zeiten und Referenzen."
        actions={
          <Link href="/projekte/neu" className="btn btn-primary">
            Neues Projekt
          </Link>
        }
      />
      <Flash {...await flashFrom(searchParams)} />

      {all.length === 0 ? (
        <NoProject />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {active.map((p) => {
            const s = stats.get(p.id);
            return (
              <article key={p.id} className="card flex flex-col overflow-hidden">
                <div className="h-1.5" style={{ backgroundColor: p.color }} />
                <div className="flex flex-1 flex-col gap-2 p-4">
                  <h2 className="text-base font-semibold">{p.name}</h2>
                  {p.description && <p className="line-clamp-2 text-sm text-muted">{p.description}</p>}
                  <p className="truncate font-mono text-xs text-muted" title={p.folder}>
                    {p.folder}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    <Badge>{s?.shorts ?? 0} Shorts</Badge>
                    <Badge>{s?.accounts ?? 0} Konten</Badge>
                    {s?.planned ? <Badge tone="info">{s.planned} geplant</Badge> : null}
                    {s?.published ? <Badge tone="ok">{s.published} veröffentlicht</Badge> : null}
                  </div>
                  <form action={switchProjectAction} className="mt-auto pt-2">
                    <input type="hidden" name="projekt" value={p.id} />
                    <input type="hidden" name="back" value={`/projekte/${p.id}`} />
                    <button className="btn w-full">Öffnen</button>
                  </form>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {archived.length > 0 && (
        <section className="mt-8">
          <h2 className="h2 mb-3">Archiviert</h2>
          <ul className="card divide-y divide-line">
            {archived.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: p.color }} />
                <Link href={`/projekte/${p.id}?tab=einstellungen`} className="flex-1 text-sm font-medium hover:underline">
                  {p.name}
                </Link>
                <form action={archiveProjectAction}>
                  <input type="hidden" name="projectId" value={p.id} />
                  <input type="hidden" name="archived" value="0" />
                  <input type="hidden" name="back" value="/projekte" />
                  <SubmitButton>Wieder aktivieren</SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
