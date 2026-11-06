import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { contentVideoPath } from "../../backlog";
import type { Content } from "../../db/schema";
import type { AppSettings } from "../../settings";
import { PublishError, type PublishInput, type Publisher } from "../types";
import {
  SessionExpiredError,
  deleteVideo,
  queryUpload,
  startUpload,
  updateVideoStatus,
  uploadFrom,
  type YtVideo,
  type YtVideoMetadata,
} from "./api";

const SESSION_MAX_AGE_MS = 6 * 86_400_000; // YouTube hält Sitzungen ca. eine Woche

const MIME: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/x-m4v" };

const clean = (s: string) => s.replace(/[<>]/g, "").trim();

export function buildMetadata(content: Content, settings: AppSettings, publishAt?: Date): YtVideoMetadata {
  const yt = content.platformTexts.youtube ?? {};
  const title = clean(yt.title || content.title).slice(0, 100) || "Neues Video";
  let description = yt.description ?? [content.description, content.hashtags.join(" ")].filter(Boolean).join("\n\n");
  if (settings.youtube.addShortsTag && !/#shorts\b/i.test(`${title} ${description}`)) {
    description = `${description}\n\n#Shorts`.trim();
  }
  const tags = (yt.tags ?? content.hashtags.map((h) => h.replace(/^#/, ""))).map(clean).filter(Boolean);
  const base = { selfDeclaredMadeForKids: false, containsSyntheticMedia: content.aiGenerated };
  return {
    snippet: {
      title,
      description: clean(description).slice(0, 5000),
      tags: tags.length ? tags : undefined,
      categoryId: settings.youtube.categoryId,
      defaultLanguage: "de",
      defaultAudioLanguage: "de",
    },
    status: publishAt
      ? { privacyStatus: "private", publishAt: publishAt.toISOString(), ...base }
      : { privacyStatus: settings.youtube.privacy, ...base },
  };
}

export function videoUrl(id: string, content: Content): string {
  const isShort =
    (content.durationSec == null || content.durationSec <= 180) &&
    (content.width == null || content.height == null || content.height >= content.width);
  return isShort ? `https://youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`;
}

export const youtubePublisher: Publisher = {
  platform: "youtube",

  // publishAt funktioniert nur für Videos, die öffentlich werden sollen.
  uploadAheadWindowMs: (s) => (s.youtube.privacy === "public" ? s.youtube.uploadAheadDays * 86_400_000 : 0),

  dailyLimit: (s) => s.youtube.dailyUploadLimit,

  // Das YouTube-Kontingent wird um Mitternacht pazifischer Zeit zurückgesetzt.
  quotaDayStart: (now) => DateTime.fromJSDate(now).setZone("America/Los_Angeles").startOf("day").toJSDate(),

  async publish(input, { publishAt }) {
    const file = contentVideoPath(input.content);
    if (!fs.existsSync(file)) throw new PublishError("fatal", `Videodatei fehlt: ${file}`);
    const size = fs.statSync(file).size;
    const mimeType = MIME[path.extname(file).toLowerCase()] ?? "video/mp4";
    const token = await input.accessToken();

    let session = input.target.uploadSession;
    if (session && (session.total !== size || input.now.getTime() - session.createdAt > SESSION_MAX_AGE_MS)) {
      session = null;
    }

    let offset = 0;
    let video: YtVideo | null = null;
    if (session) {
      try {
        const status = await queryUpload(session.url, size, token);
        if (status.done) video = status.video;
        else {
          offset = status.offset;
          input.log(`Setze Upload bei ${Math.round((offset / size) * 100)} % fort`);
        }
      } catch (err) {
        if (!(err instanceof SessionExpiredError)) throw err;
        session = null;
      }
    }

    if (!video) {
      if (!session) {
        const url = await startUpload({ accessToken: token, metadata: buildMetadata(input.content, input.settings, publishAt), size, mimeType });
        session = { url, total: size, createdAt: input.now.getTime() };
        input.saveSession(session);
        offset = 0;
      }
      try {
        video = await uploadFrom({ sessionUrl: session.url, filePath: file, size, offset, getToken: input.accessToken });
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          input.saveSession(null);
          throw new PublishError("retryable", "Upload-Sitzung abgelaufen – starte beim nächsten Versuch neu");
        }
        throw err;
      }
    }

    input.saveSession(null);
    if (video.status?.uploadStatus === "rejected" || video.status?.uploadStatus === "failed") {
      throw new PublishError("fatal", `YouTube hat das Video abgelehnt (${video.status.uploadStatus})`);
    }
    return { state: publishAt ? "scheduled" : "published", externalId: video.id, externalUrl: videoUrl(video.id, input.content) };
  },

  async updateSchedule(input, publishAt) {
    if (!input.target.externalId) return;
    const meta = buildMetadata(input.content, input.settings, publishAt);
    await updateVideoStatus(await input.accessToken(), input.target.externalId, meta.status);
  },

  async remove(input) {
    if (!input.target.externalId) return;
    await deleteVideo(await input.accessToken(), input.target.externalId);
  },
};
