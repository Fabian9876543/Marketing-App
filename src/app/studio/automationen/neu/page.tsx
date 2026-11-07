import Link from "next/link";
import { connection } from "next/server";
import { AutomationForm } from "@/components/AutomationForm";
import { Flash, NoProject, PageHeader, flashFrom } from "@/components/ui";
import { getScope } from "@/lib/active-project";
import { recipeFromSession } from "@/lib/automation";
import { getDb } from "@/lib/db/client";

const BLANK_RECIPE = `## Auftrag

Mach einen Short im Format … (z. B. Dialog, Vorher/Nachher, Quiz).
Länge 15–25 Sekunden, Hook höchstens 8 Wörter, am Ende die Handlungsaufforderung aus PROJEKT.md.

## Rückmeldungen, die immer gelten

- …`;

export default async function NewAutomationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const db = getDb();
  const scope = await getScope(db);
  if (!scope.projects.length) return <NoProject />;
  const sp = await searchParams;
  const chatId = Number(sp.chat);

  let draft: { name: string; recipe: string; sourceSessionId?: number } = { name: "", recipe: BLANK_RECIPE };
  let projectId = scope.active?.id;
  let fromChat = false;
  if (Number.isInteger(chatId) && chatId > 0) {
    try {
      const r = recipeFromSession(db, chatId);
      draft = { name: r.name, recipe: r.recipe, sourceSessionId: chatId };
      projectId = r.projectId;
      fromChat = true;
    } catch {
      // Chat gibt es nicht mehr – leeres Rezept
    }
  }
  const project = scope.projects.find((p) => p.id === projectId);
  if (!project) {
    return (
      <>
        <PageHeader title="Neue Automation" />
        <p className="card p-4 text-sm text-muted">Bitte oben ein Projekt wählen.</p>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={`Neue Automation · ${project.name}`}
        subtitle={fromChat ? "Das Rezept stammt aus deinem Chat – prüfe und ergänze es." : "Beschreibe, wie die Shorts aussehen sollen."}
        actions={
          <Link href="/studio/automationen" className="btn">
            Abbrechen
          </Link>
        }
      />
      <Flash {...await flashFrom(searchParams)} />
      <AutomationForm projectId={project.id} draft={draft} back={`/studio/automationen/neu${fromChat ? `?chat=${chatId}` : ""}`} />
    </>
  );
}
