import path from "node:path";
import { eq } from "drizzle-orm";
import { contentVideoPath } from "@/lib/backlog";
import { getDb } from "@/lib/db/client";
import { contents } from "@/lib/db/schema";
import { serveFile } from "@/lib/serve";

const MIME: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/x-m4v" };

/** Liefert das Video eines Shorts (mit Range-Unterstützung zum Spulen). Nur per ID, nie per Pfad. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return new Response("Ungültig", { status: 400 });
  const content = getDb().select().from(contents).where(eq(contents.id, id)).get();
  if (!content) return new Response("Nicht gefunden", { status: 404 });
  const file = contentVideoPath(content);
  return serveFile(req, file, MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream");
}
