import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type VideoInfo = { durationSec: number | null; width: number | null; height: number | null };

/** Liest Dauer und Auflösung mit ffprobe. Ohne ffprobe: null-Werte statt Fehler. */
export async function probeVideo(file: string): Promise<VideoInfo> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file],
      { timeout: 20_000 },
    );
    const json = JSON.parse(stdout) as { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };
    const stream = json.streams?.[0];
    const duration = json.format?.duration ? Number(json.format.duration) : NaN;
    return {
      durationSec: Number.isFinite(duration) ? duration : null,
      width: stream?.width ?? null,
      height: stream?.height ?? null,
    };
  } catch {
    return { durationSec: null, width: null, height: null };
  }
}

/** Hinweise zum Format eines Shorts (z. B. zu lang, nicht hochkant). */
export function formatWarnings(info: { durationSec: number | null; width: number | null; height: number | null }): string[] {
  const warnings: string[] = [];
  if (info.durationSec != null && info.durationSec > 180) warnings.push("Länger als 3 Minuten – kein YouTube Short");
  else if (info.durationSec != null && info.durationSec > 90) warnings.push("Länger als 90 Sekunden");
  if (info.width && info.height && info.width > info.height) warnings.push("Querformat – Shorts sollten 9:16 sein");
  return warnings;
}
