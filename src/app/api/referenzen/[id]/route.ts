import { getDb } from "@/lib/db/client";
import { getProject } from "@/lib/projects";
import { getReference, referenceFile } from "@/lib/references";
import { serveFile } from "@/lib/serve";

/** Liefert eine Referenzdatei (Vorschau oder ?download=1). Nur per ID, nie per Pfad. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return new Response("Ungültig", { status: 400 });
  const db = getDb();
  const ref = getReference(db, id);
  const project = ref ? getProject(db, ref.projectId) : undefined;
  const file = ref && project ? referenceFile(project, ref) : null;
  if (!ref || !file) return new Response("Nicht gefunden", { status: 404 });
  return serveFile(req, file, ref.mime ?? "application/octet-stream", { download: new URL(req.url).searchParams.has("download") });
}
