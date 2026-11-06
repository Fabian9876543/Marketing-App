import fs from "node:fs";
import path from "node:path";
import { contentVideoPath } from "../backlog";
import { dataDir, ensureDir } from "../env";
import { PublishError, type Publisher } from "./types";

/**
 * Test-Kanal: „veröffentlicht“ in einen lokalen Ordner statt ins Internet.
 * So lässt sich der ganze Ablauf ohne echte Konten ausprobieren.
 */
export const simulatorPublisher: Publisher = {
  platform: "simulator",
  async publish(input) {
    const src = contentVideoPath(input.content);
    if (!fs.existsSync(src)) throw new PublishError("fatal", `Videodatei fehlt: ${src}`);
    const outDir = ensureDir(path.join(dataDir(), "test-kanal"));
    const dest = path.join(outDir, `${input.target.id}-${input.content.slug}${path.extname(src)}`);
    await new Promise((r) => setTimeout(r, 300));
    fs.copyFileSync(src, dest);
    input.log(`Kopie gespeichert: ${dest}`);
    return { state: "published", externalId: `test-${input.target.id}` };
  },
};
