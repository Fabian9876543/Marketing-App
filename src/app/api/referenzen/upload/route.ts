import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { getProject } from "@/lib/projects";
import { addFileReference, isCategory } from "@/lib/references";
import { sameOrigin } from "@/lib/serve";

/** Eine oder mehrere Dateien als Referenzen zu einem Projekt hochladen. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return new Response("Fremde Herkunft abgelehnt", { status: 403 });
  const form = await req.formData();
  const projectId = Number(form.get("projectId"));
  const back = (params: Record<string, string>) => {
    const url = new URL(`/projekte/${projectId}`, req.url);
    url.searchParams.set("tab", "referenzen");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return NextResponse.redirect(url, 303);
  };

  const db = getDb();
  const project = Number.isInteger(projectId) ? getProject(db, projectId) : undefined;
  if (!project) return NextResponse.redirect(new URL("/projekte?fehler=Projekt+nicht+gefunden", req.url), 303);

  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return back({ fehler: "Bitte mindestens eine Datei auswählen" });
  const category = String(form.get("category") ?? "auto");
  const note = String(form.get("note") ?? "");

  const errors: string[] = [];
  let saved = 0;
  for (const file of files) {
    try {
      addFileReference(db, project, {
        fileName: file.name,
        data: Buffer.from(await file.arrayBuffer()),
        category: isCategory(category) ? category : "auto",
        title: files.length === 1 ? String(form.get("title") ?? "") : undefined,
        note,
      });
      saved++;
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  if (errors.length) return back({ fehler: `${saved} gespeichert, ${errors.length} abgelehnt: ${errors.join(" · ")}` });
  return back({ ok: saved === 1 ? "Referenz gespeichert" : `${saved} Referenzen gespeichert` });
}
