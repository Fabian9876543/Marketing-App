import type { StoredTokens } from "../accounts";
import type { Platform } from "../db/schema";
import { simulatorPublisher } from "./simulator";
import type { Publisher } from "./types";
import { refreshAccessToken as refreshYoutube } from "./youtube/oauth";
import { youtubePublisher } from "./youtube/publisher";

/** Plattformen, die in dieser Version schon veröffentlichen können. */
export const publishers: Partial<Record<Platform, Publisher>> = {
  youtube: youtubePublisher,
  simulator: simulatorPublisher,
};

/** Token-Erneuerung je Plattform. */
export const tokenRefreshers: Partial<Record<Platform, (refreshToken: string) => Promise<StoredTokens>>> = {
  youtube: refreshYoutube,
};
