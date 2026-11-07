import path from "node:path";
import { connection } from "next/server";
import { createProjectAction } from "@/app/actions";
import { SubmitButton } from "@/components/client";
import { Flash, PageHeader, flashFrom } from "@/components/ui";
import { getDb } from "@/lib/db/client";
import { PROJECT_COLORS, listProjects } from "@/lib/projects";
import { getSettings } from "@/lib/settings";

export default async function NewProjectPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const db = getDb();
  const { projectsDir } = getSettings(db);
  const color = PROJECT_COLORS[listProjects(db, { includeArchived: true }).length % PROJECT_COLORS.length];

  return (
    <>
      <PageHeader title="Neues Projekt" subtitle="Eine App, eine Marke oder ein Kunde – alles Weitere richtest du danach im Projekt ein." />
      <Flash {...await flashFrom(searchParams)} />
      <form action={createProjectAction} className="card max-w-2xl space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <div>
            <label className="label" htmlFor="name">
              Name
            </label>
            <input id="name" name="name" required maxLength={80} className="input" placeholder="z. B. Fokuspilot" autoFocus />
          </div>
          <div>
            <label className="label" htmlFor="color">
              Farbe
            </label>
            <input id="color" name="color" type="color" defaultValue={color} className="h-9 w-16 cursor-pointer rounded-lg border border-line bg-surface p-1" />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="description">
            Worum geht es? (ein, zwei Sätze)
          </label>
          <textarea id="description" name="description" rows={2} className="input" placeholder="z. B. KI-Telefonassistent für Praxen und Handwerksbetriebe" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="website">
              Website (optional)
            </label>
            <input id="website" name="website" className="input" placeholder="fokuspilot.de" />
          </div>
          <div>
            <label className="label" htmlFor="hashtags">
              Standard-Hashtags (optional)
            </label>
            <input id="hashtags" name="hashtags" className="input" placeholder="#KI #Telefonassistent" />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="folder">
            Projektordner (optional)
          </label>
          <input id="folder" name="folder" className="input font-mono text-xs" placeholder={path.join(projectsDir, "<projektname>")} />
          <p className="mt-1 text-xs text-muted">
            Leer lassen für einen neuen Ordner unter {projectsDir}. Darin entstehen <code>backlog/</code> für fertige Shorts, <code>referenzen/</code> für
            Logo, Screenshots &amp; Co. und <code>PROJEKT.md</code> mit dem Briefing.
          </p>
        </div>
        <div className="text-right">
          <SubmitButton className="btn btn-primary">Projekt anlegen</SubmitButton>
        </div>
      </form>
    </>
  );
}
