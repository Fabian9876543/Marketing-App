import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { AutomationForm } from "@/components/AutomationForm";
import { Flash, PageHeader, flashFrom } from "@/components/ui";
import { getAutomation } from "@/lib/automation";
import { getDb } from "@/lib/db/client";
import { getProject } from "@/lib/projects";

export default async function EditAutomationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const db = getDb();
  const a = getAutomation(db, Number((await params).id));
  if (!a) notFound();
  const project = getProject(db, a.projectId);
  return (
    <>
      <PageHeader
        title={`Automation bearbeiten · ${a.name}`}
        subtitle={project?.name}
        actions={
          <Link href="/studio/automationen" className="btn">
            ← Automationen
          </Link>
        }
      />
      <Flash {...await flashFrom(searchParams)} />
      <AutomationForm projectId={a.projectId} automation={a} back={`/studio/automationen/${a.id}`} />
    </>
  );
}
