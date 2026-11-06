import fs from "node:fs";
import { contentVideoPath } from "../../backlog";
import { metaConfig } from "../../env";
import { captionFor } from "../captions";
import { readJson } from "../oauth";
import { MAX_PROCESSING_MS, PublishError, sleep, type Publisher } from "../types";
import { graph, toGraphError } from "./graph";

/** Instagram löscht nicht veröffentlichte Container nach 24 Stunden. */
const CONTAINER_MAX_AGE_MS = 23 * 3600_000;

type ContainerStatus = { status_code?: "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED"; status?: string };

export function createInstagramPublisher(opts: { pollMs?: number; waitMs?: number } = {}): Publisher {
  const pollMs = opts.pollMs ?? 5000;
  const waitMs = opts.waitMs ?? 2 * 60_000;

  return {
    platform: "instagram",
    maxDurationSec: () => 15 * 60,

    async publish(input) {
      const token = await input.accessToken();
      const igId = input.account.externalId;
      const now = input.now.getTime();

      let session = input.target.uploadSession?.remoteId ? input.target.uploadSession : null;
      if (session && now - session.createdAt > CONTAINER_MAX_AGE_MS) session = null;

      if (!session) {
        await checkQuota(igId, token);
        const file = contentVideoPath(input.content);
        if (!fs.existsSync(file)) throw new PublishError("fatal", `Videodatei fehlt: ${file}`);
        const data = fs.readFileSync(file);

        // 1) Container für einen Reel mit fortsetzbarem Upload anlegen
        const container = await graph<{ id: string; uri?: string }>(
          "POST",
          `${igId}/media`,
          {
            media_type: "REELS",
            upload_type: "resumable",
            caption: captionFor("instagram", input.content, input.settings),
            share_to_feed: String(input.settings.instagram.shareToFeed),
            access_token: token,
          },
          "Reel anlegen",
        );

        // 2) Datei direkt vom Rechner hochladen
        const c = metaConfig();
        const uploadUrl = container.uri ?? `${c.ruploadBase}/ig-api-upload/${c.version}/${container.id}`;
        const res = await fetch(uploadUrl, {
          method: "POST",
          headers: { Authorization: `OAuth ${token}`, offset: "0", file_size: String(data.length), "Content-Type": "application/octet-stream" },
          body: data,
        });
        const body = await readJson<{ success?: boolean; debug_info?: { message?: string } }>(res);
        if (!res.ok || body.success === false) {
          throw toGraphError(res.status, body as never, `Upload zu Instagram (${body.debug_info?.message ?? res.status})`);
        }
        session = { createdAt: now, remoteId: container.id };
        input.saveSession(session);
        input.log("Video hochgeladen, Instagram verarbeitet es");
      }

      // 3) Warten, bis Instagram das Video verarbeitet hat
      const containerId = session.remoteId!;
      const deadline = Date.now() + waitMs;
      let status: ContainerStatus = {};
      while (true) {
        status = await graph<ContainerStatus>("GET", containerId, { fields: "status_code,status", access_token: token }, "Verarbeitungsstand");
        if (status.status_code !== "IN_PROGRESS" || Date.now() >= deadline) break;
        await sleep(pollMs);
      }

      if (status.status_code === "IN_PROGRESS") {
        if (now - session.createdAt > MAX_PROCESSING_MS) {
          input.saveSession(null);
          throw new PublishError("fatal", "Instagram hat die Verarbeitung nach 6 Stunden nicht abgeschlossen");
        }
        throw new PublishError("processing", "Instagram verarbeitet das Video noch – schaue in einer Minute wieder nach");
      }
      if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
        input.saveSession(null);
        throw new PublishError(
          status.status_code === "EXPIRED" ? "retryable" : "fatal",
          `Instagram hat das Video nicht angenommen: ${status.status ?? status.status_code}. Prüfe Format (9:16, 3 s – 15 min, H.264/AAC).`,
        );
      }

      // 4) Veröffentlichen (bei PUBLISHED war das schon in einem früheren Versuch erfolgreich)
      let mediaId = containerId;
      if (status.status_code !== "PUBLISHED") {
        const published = await graph<{ id: string }>("POST", `${igId}/media_publish`, { creation_id: containerId, access_token: token }, "Reel veröffentlichen");
        mediaId = published.id;
      }
      input.saveSession(null);

      let permalink: string | undefined;
      try {
        permalink = (await graph<{ permalink?: string }>("GET", mediaId, { fields: "permalink", access_token: token }, "Link abrufen")).permalink;
      } catch {
        // Link ist nur Komfort
      }
      return { state: "published", externalId: mediaId, externalUrl: permalink };
    },
  };
}

/** Instagram erlaubt nur eine begrenzte Zahl API-Posts pro 24 Stunden. */
async function checkQuota(igId: string, token: string): Promise<void> {
  try {
    const limit = await graph<{ data?: { quota_usage?: number; config?: { quota_total?: number } }[] }>(
      "GET",
      `${igId}/content_publishing_limit`,
      { fields: "quota_usage,config", access_token: token },
      "Kontingent prüfen",
    );
    const entry = limit.data?.[0];
    const total = entry?.config?.quota_total;
    if (total && (entry?.quota_usage ?? 0) >= total) {
      throw new PublishError("quota", `Instagram-Limit von ${total} Posts in 24 Stunden erreicht – neuer Versuch in einer Stunde`, new Date(Date.now() + 3600_000));
    }
  } catch (err) {
    if (err instanceof PublishError && (err.kind === "quota" || err.kind === "auth")) throw err;
    // Kontingent-Abfrage ist nur eine Vorsichtsmaßnahme – bei anderen Fehlern trotzdem versuchen.
  }
}

export const instagramPublisher = createInstagramPublisher();
