import fs from "node:fs";
import { contentVideoPath } from "../../backlog";
import { captionFor } from "../captions";
import { MAX_PROCESSING_MS, PublishError, sleep, type Publisher } from "../types";
import { li, toLittleText } from "./api";

type InitResponse = {
  value: {
    video: string;
    uploadToken?: string;
    uploadInstructions: { uploadUrl: string; firstByte: number; lastByte: number }[];
  };
};
type VideoStatus = { status?: "WAITING_UPLOAD" | "PROCESSING" | "AVAILABLE" | "PROCESSING_FAILED" };

export function createLinkedInPublisher(opts: { pollMs?: number; waitMs?: number } = {}): Publisher {
  const pollMs = opts.pollMs ?? 5000;
  const waitMs = opts.waitMs ?? 2 * 60_000;

  return {
    platform: "linkedin",
    maxDurationSec: () => 30 * 60,

    async publish(input) {
      const token = await input.accessToken();
      const owner = `urn:li:person:${input.account.externalId}`;
      const now = input.now.getTime();
      let session = input.target.uploadSession?.remoteId ? input.target.uploadSession : null;

      if (!session) {
        const file = contentVideoPath(input.content);
        if (!fs.existsSync(file)) throw new PublishError("fatal", `Videodatei fehlt: ${file}`);
        const data = fs.readFileSync(file);

        // 1) Upload anmelden – LinkedIn liefert die Teile und Adressen vor
        const { data: init } = await li<InitResponse>("POST", "videos?action=initializeUpload", token, "LinkedIn-Upload anmelden", {
          initializeUploadRequest: { owner, fileSizeBytes: data.length, uploadCaptions: false, uploadThumbnail: false },
        });

        // 2) Teile hochladen und die ETags sammeln
        const etags: string[] = [];
        for (const part of init.value.uploadInstructions) {
          const res = await fetch(part.uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream" },
            body: data.subarray(part.firstByte, part.lastByte + 1),
          });
          const etag = res.headers.get("etag");
          if (!res.ok || !etag) {
            throw new PublishError(res.status >= 500 || res.status === 429 || res.ok ? "retryable" : "fatal", `Upload zu LinkedIn fehlgeschlagen (HTTP ${res.status})`);
          }
          etags.push(etag);
        }

        // 3) Upload abschließen
        await li("POST", "videos?action=finalizeUpload", token, "LinkedIn-Upload abschließen", {
          finalizeUploadRequest: { video: init.value.video, uploadToken: init.value.uploadToken ?? "", uploadedPartIds: etags },
        });
        session = { createdAt: now, remoteId: init.value.video };
        input.saveSession(session);
        input.log("Video hochgeladen, LinkedIn verarbeitet es");
      }

      // 4) Warten, bis das Video verfügbar ist
      const videoUrn = session.remoteId!;
      const deadline = Date.now() + waitMs;
      let status: VideoStatus = {};
      while (true) {
        status = (await li<VideoStatus>("GET", `videos/${encodeURIComponent(videoUrn)}`, token, "LinkedIn-Videostatus")).data;
        if (status.status === "AVAILABLE" || status.status === "PROCESSING_FAILED" || Date.now() >= deadline) break;
        await sleep(pollMs);
      }
      if (status.status === "PROCESSING_FAILED") {
        input.saveSession(null);
        throw new PublishError("fatal", "LinkedIn konnte das Video nicht verarbeiten – Format prüfen (MP4, 3 s – 30 min)");
      }
      if (status.status !== "AVAILABLE") {
        if (now - session.createdAt > MAX_PROCESSING_MS) {
          input.saveSession(null);
          throw new PublishError("fatal", "LinkedIn hat die Verarbeitung nach 6 Stunden nicht abgeschlossen");
        }
        throw new PublishError("processing", "LinkedIn verarbeitet das Video noch – schaue in einer Minute wieder nach");
      }

      // 5) Beitrag anlegen
      const { headers } = await li("POST", "posts", token, "LinkedIn-Beitrag anlegen", {
        author: owner,
        commentary: toLittleText(captionFor("linkedin", input.content, input.settings)),
        visibility: input.settings.linkedin.visibility,
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        content: { media: { title: input.content.title.slice(0, 200), id: videoUrn } },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      });
      input.saveSession(null);
      const postUrn = headers.get("x-restli-id") ?? headers.get("x-linkedin-id") ?? "";
      return {
        state: "published",
        externalId: postUrn || videoUrn,
        externalUrl: postUrn ? `https://www.linkedin.com/feed/update/${postUrn}/` : undefined,
      };
    },
  };
}

export const linkedinPublisher = createLinkedInPublisher();
