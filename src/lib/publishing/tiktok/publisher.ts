import fs from "node:fs";
import path from "node:path";
import { contentVideoPath } from "../../backlog";
import { captionFor } from "../captions";
import { MAX_PROCESSING_MS, PublishError, sleep, type Publisher } from "../types";
import { chunkPlan, ttPost, uploadChunks } from "./api";

const MIME: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4" };

type InitData = { publish_id: string; upload_url?: string };
type CreatorInfo = {
  creator_nickname?: string;
  privacy_level_options?: string[];
  max_video_post_duration_sec?: number;
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
};
type StatusData = {
  status?: "PROCESSING_UPLOAD" | "PROCESSING_DOWNLOAD" | "SEND_TO_USER_INBOX" | "PUBLISH_COMPLETE" | "FAILED";
  fail_reason?: string;
  publicaly_available_post_id?: (string | number)[];
};

export function createTikTokPublisher(opts: { pollMs?: number; waitMs?: number } = {}): Publisher {
  const pollMs = opts.pollMs ?? 5000;
  const waitMs = opts.waitMs ?? 2 * 60_000;

  return {
    platform: "tiktok",
    maxDurationSec: () => 10 * 60,

    async publish(input) {
      const token = await input.accessToken();
      const mode = input.settings.tiktok.mode;
      const now = input.now.getTime();
      let session = input.target.uploadSession?.remoteId ? input.target.uploadSession : null;

      if (!session) {
        const file = contentVideoPath(input.content);
        if (!fs.existsSync(file)) throw new PublishError("fatal", `Videodatei fehlt: ${file}`);
        const data = fs.readFileSync(file);
        const plan = chunkPlan(data.length);
        const sourceInfo = { source: "FILE_UPLOAD", video_size: data.length, chunk_size: plan.chunkSize, total_chunk_count: plan.count };

        let init: InitData;
        if (mode === "draft") {
          // Entwurf: landet im Posteingang deiner TikTok-App, du postest dort selbst (kein Audit nötig).
          init = await ttPost<InitData>("/v2/post/publish/inbox/video/init/", token, { source_info: sourceInfo }, "TikTok-Entwurf anlegen");
        } else {
          const creator = await ttPost<CreatorInfo>("/v2/post/publish/creator_info/query/", token, {}, "TikTok-Konto prüfen");
          const privacy = mode === "direct_public" ? "PUBLIC_TO_EVERYONE" : "SELF_ONLY";
          if (creator.privacy_level_options && !creator.privacy_level_options.includes(privacy)) {
            throw new PublishError(
              "fatal",
              mode === "direct_public"
                ? "Öffentliche Direktposts erlaubt TikTok erst nach dem Audit deiner App. Bis dahin Modus „Entwurf in der App“ verwenden."
                : `TikTok erlaubt für dieses Konto nur: ${creator.privacy_level_options.join(", ")}`,
            );
          }
          const max = creator.max_video_post_duration_sec;
          if (max && input.content.durationSec && input.content.durationSec > max) {
            throw new PublishError("fatal", `Video ist ${Math.round(input.content.durationSec)} s lang – dieses TikTok-Konto erlaubt höchstens ${max} s`);
          }
          init = await ttPost<InitData>(
            "/v2/post/publish/video/init/",
            token,
            {
              post_info: {
                title: captionFor("tiktok", input.content, input.settings),
                privacy_level: privacy,
                disable_comment: creator.comment_disabled ?? false,
                disable_duet: creator.duet_disabled ?? false,
                disable_stitch: creator.stitch_disabled ?? false,
                is_aigc: input.content.aiGenerated,
                brand_content_toggle: false,
                brand_organic_toggle: false,
              },
              source_info: sourceInfo,
            },
            "TikTok-Post anlegen",
          );
        }
        if (!init.upload_url) throw new PublishError("retryable", "TikTok hat keine Upload-Adresse geliefert");
        await uploadChunks(init.upload_url, data, MIME[path.extname(file).toLowerCase()] ?? "video/mp4");
        session = { createdAt: now, remoteId: init.publish_id };
        input.saveSession(session);
        input.log("Video hochgeladen, TikTok verarbeitet es");
      }

      // Auf die Verarbeitung warten
      const publishId = session.remoteId!;
      const deadline = Date.now() + waitMs;
      let status: StatusData = {};
      while (true) {
        status = await ttPost<StatusData>("/v2/post/publish/status/fetch/", token, { publish_id: publishId }, "TikTok-Status");
        const busy = status.status === "PROCESSING_UPLOAD" || status.status === "PROCESSING_DOWNLOAD" || !status.status;
        if (!busy || Date.now() >= deadline) break;
        await sleep(pollMs);
      }

      switch (status.status) {
        case "SEND_TO_USER_INBOX":
          input.saveSession(null);
          return { state: "handed_off", externalId: publishId };
        case "PUBLISH_COMPLETE": {
          input.saveSession(null);
          const postId = status.publicaly_available_post_id?.[0];
          return { state: "published", externalId: postId ? String(postId) : publishId };
        }
        case "FAILED":
          input.saveSession(null);
          throw new PublishError("fatal", `TikTok hat das Video abgelehnt: ${status.fail_reason ?? "unbekannter Grund"}`);
        default:
          if (now - session.createdAt > MAX_PROCESSING_MS) {
            input.saveSession(null);
            throw new PublishError("fatal", "TikTok hat die Verarbeitung nach 6 Stunden nicht abgeschlossen");
          }
          throw new PublishError("processing", "TikTok verarbeitet das Video noch – schaue in einer Minute wieder nach");
      }
    },
  };
}

export const tiktokPublisher = createTikTokPublisher();
