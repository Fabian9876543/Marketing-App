import { NextResponse } from "next/server";
import { createBacklogFolder, importBacklog, normalizeHashtags } from "@/lib/backlog";
import { getDb } from "@/lib/db/client";
import { getSettings } from "@/lib/settings";

const back = (req: Request, params: Record<string, string>) => {
  const url = new URL("/backlog", req.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url, 303);
};

/** Video hochladen → neuer Ordner im Backlog. */
export async function POST(req: Request) {
  // Schutz gegen Formulare fremder Websites (CSRF): nur Anfragen von der eigenen Oberfläche.
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(req.url).host) {
    return new Response("Fremde Herkunft abgelehnt", { status: 403 });
  }
  try {
    const form = await req.formData();
    const file = form.get("file");
    const title = String(form.get("title") ?? "").trim();
    if (!(file instanceof File) || file.size === 0) return back(req, { fehler: "Bitte eine Videodatei auswählen" });
    if (!/\.(mp4|mov|m4v)$/i.test(file.name)) return back(req, { fehler: "Nur MP4-, MOV- oder M4V-Dateien" });
    if (!title) return back(req, { fehler: "Bitte einen Titel angeben" });

    const db = getDb();
    const { contentDir } = getSettings(db);
    const description = String(form.get("description") ?? "").trim();
    const hashtags = normalizeHashtags(String(form.get("hashtags") ?? "").split(/[\s,]+/));
    createBacklogFolder(contentDir, {
      title,
      fileName: file.name,
      data: Buffer.from(await file.arrayBuffer()),
      meta: { description, hashtags, aiGenerated: form.get("aiGenerated") === "on" },
    });
    await importBacklog(db, contentDir);
    return back(req, { ok: `„${title}“ liegt jetzt im Backlog` });
  } catch (err) {
    return back(req, { fehler: `Upload fehlgeschlagen: ${(err as Error).message}` });
  }
}
