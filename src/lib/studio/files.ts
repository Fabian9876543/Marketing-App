import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Project } from "../db/schema";
import { probeVideo } from "../media";

/**
 * Dateien zwischen Projekt und KI-Diensten (z. B. Higgsfield) bewegen – für Claude im Studio,
 * das selbst kein curl/wget darf. Nur Bilder, Videos und Audio, nur https, keine lokalen Adressen.
 */

export class FileToolError extends Error {}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
};
const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
};

export const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export type FileToolOptions = {
  /** Nur für Tests: lokale http-Adressen erlauben */
  allowPrivate?: boolean;
};

function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (net.isIPv4(h)) {
    const [a, b] = h.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(h)) return h === "::" || h === "::1" || /^(fc|fd|fe8|fe9|fea|feb)/.test(h) || h.startsWith("::ffff:");
  return !h.includes(".");
}

/** Nur https und keine Adressen im eigenen Netz (der Mac, der Router, die App selbst). */
export function checkRemoteUrl(raw: string, opts: FileToolOptions = {}): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FileToolError(`Keine gültige Adresse: ${raw.slice(0, 80)}`);
  }
  const httpOk = opts.allowPrivate && u.protocol === "http:";
  if (u.protocol !== "https:" && !httpOk) throw new FileToolError("Nur https-Adressen sind erlaubt");
  if (u.username || u.password) throw new FileToolError("Adressen mit Zugangsdaten sind nicht erlaubt");
  if (!opts.allowPrivate && isPrivateHost(u.hostname)) throw new FileToolError("Lokale oder interne Adressen sind nicht erlaubt");
  return u;
}

/** Dateiname ohne Pfad, Endung und Sonderzeichen. */
export function safeName(name: string | undefined, fallback = "datei"): string {
  const base = path
    .basename(name ?? "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, "")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base || `${fallback}-${Date.now()}`;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
const sec = (n: number) => n.toFixed(1).replace(".", ",");

/** Holt ein Bild, Video oder Audio aus dem Netz nach studio/public/ki/. */
export async function downloadTool(project: Project, input: { url: string; datei: string }, opts: FileToolOptions = {}): Promise<string> {
  let url = checkRemoteUrl(input.url, opts);
  let res: Response | null = null;
  for (let hop = 0; hop < 5; hop++) {
    res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10 * 60_000) });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      url = checkRemoteUrl(new URL(loc, url).toString(), opts);
      continue;
    }
    break;
  }
  if (!res || !res.ok || !res.body) throw new FileToolError(`Download fehlgeschlagen (HTTP ${res?.status ?? "?"})`);

  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const urlExt = path.extname(url.pathname).slice(1).toLowerCase();
  const ext = MIME_EXT[type] ?? (EXT_MIME[urlExt] ? (urlExt === "jpeg" ? "jpg" : urlExt) : null);
  if (!ext) throw new FileToolError(`Keine Bild-, Video- oder Audiodatei (${type || "unbekannter Typ"})`);
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_DOWNLOAD_BYTES) throw new FileToolError(`Datei zu groß (${mb(length)}, höchstens ${mb(MAX_DOWNLOAD_BYTES)})`);

  const dir = path.join(project.folder, "studio", "public", "ki");
  fs.mkdirSync(dir, { recursive: true });
  const name = `${safeName(input.datei, "ki")}.${ext}`;
  const file = path.join(dir, name);
  const tmp = `${file}.teil`;
  let bytes = 0;
  const out = fs.createWriteStream(tmp);
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > MAX_DOWNLOAD_BYTES) throw new FileToolError(`Datei zu groß (höchstens ${mb(MAX_DOWNLOAD_BYTES)})`);
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    fs.renameSync(tmp, file);
  } catch (err) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw err;
  }

  const info = await probeVideo(file);
  const details = [mb(bytes)];
  if (info.width && info.height) details.push(`${info.width}×${info.height}`);
  if (info.durationSec && !ext.match(/png|jpg|webp/)) details.push(`${sec(info.durationSec)} s`);
  const lines = [`Gespeichert: studio/public/ki/${name} (${details.join(", ")}) – in der Szenen-JSON: "src": "ki/${name}"`];
  if (info.width && info.height && info.width > info.height) lines.push("Achtung: Querformat – für Shorts besser 9:16 erzeugen.");
  lines.push("KI-Bild oder -Video: in meta.json \"aiGenerated\": true setzen.");
  return lines.join("\n");
}

/**
 * Pfad im Projektordner prüfen: nur unterhalb der erlaubten Ordner, keine versteckten Dateien, nur Bilder/Videos/Audio.
 * Liefert absoluten Pfad, relativen Pfad und Endung.
 */
export function resolveProjectMedia(
  project: Pick<Project, "folder">,
  datei: string,
  roots: string[] = ["referenzen", "backlog", "studio/public"],
): { file: string; rel: string; ext: string } {
  const root = path.resolve(project.folder);
  const file = path.resolve(root, datei.replace(/^\/+/, ""));
  const rel = path.relative(root, file);
  const relPosix = rel.split(path.sep).join("/");
  const allowed = roots.some((r) => relPosix === r || relPosix.startsWith(`${r}/`));
  if (rel.startsWith("..") || path.isAbsolute(rel) || !allowed || relPosix.split("/").some((p) => p.startsWith("."))) {
    throw new FileToolError(`Nur Dateien aus ${roots.map((r) => `${r}/`).join(", ")} dieses Projekts`);
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new FileToolError(`Datei nicht gefunden: ${relPosix}`);
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!EXT_MIME[ext]) throw new FileToolError("Nur Bilder, Videos und Audio");
  return { file, rel: relPosix, ext };
}

export const mimeOf = (ext: string) => EXT_MIME[ext] ?? "application/octet-stream";

/** Lädt eine Projektdatei (Referenz, Bild aus studio/public, Short) per PUT an eine vorbereitete Upload-Adresse. */
export async function uploadTool(
  project: Project,
  input: { datei: string; upload_url: string; content_type?: string },
  opts: FileToolOptions = {},
): Promise<string> {
  const { file, rel, ext } = resolveProjectMedia(project, input.datei);
  const size = fs.statSync(file).size;
  if (size > MAX_UPLOAD_BYTES) throw new FileToolError(`Datei zu groß (${mb(size)}, höchstens ${mb(MAX_UPLOAD_BYTES)})`);
  const url = checkRemoteUrl(input.upload_url, opts);

  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": input.content_type || EXT_MIME[ext], "Content-Length": String(size) },
    body: fs.readFileSync(file),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    throw new FileToolError(`Hochladen fehlgeschlagen (HTTP ${res.status})${text ? `: ${text}` : ""}`);
  }
  return `Hochgeladen: ${rel} (${mb(size)}). Jetzt beim Dienst bestätigen (bei Higgsfield: media_confirm).`;
}
