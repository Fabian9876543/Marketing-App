import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

/**
 * Liefert eine Datei aus, mit Range-Unterstützung (zum Spulen in Video/Audio).
 * Aufrufer prüfen vorher, dass der Pfad zu einem erlaubten Inhalt gehört.
 */
export function serveFile(req: Request, file: string, mime: string, opts: { download?: boolean } = {}): Response {
  if (!fs.existsSync(file)) return new Response("Datei fehlt", { status: 404 });
  const size = fs.statSync(file).size;
  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    // SVGs könnten Skripte enthalten – nie als eigene Seite ausführen.
    "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'",
  };
  if (opts.download) headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;

  const range = req.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }
  const stream = Readable.toWeb(fs.createReadStream(file)) as ReadableStream;
  return new Response(stream, { headers: { ...headers, "Content-Length": String(size) } });
}

/** Schutz gegen Formulare fremder Websites (CSRF) bei eigenen POST-Routen. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  return !origin || new URL(origin).host === new URL(req.url).host;
}
