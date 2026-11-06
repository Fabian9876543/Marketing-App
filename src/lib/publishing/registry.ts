import type { StoredTokens } from "../accounts";
import type { Platform } from "../db/schema";
import { instagramOAuth } from "./instagram/oauth";
import { instagramPublisher } from "./instagram/publisher";
import { linkedinOAuth, refreshLinkedIn } from "./linkedin/oauth";
import { linkedinPublisher } from "./linkedin/publisher";
import type { OAuthProvider } from "./oauth";
import { simulatorPublisher } from "./simulator";
import { refreshTikTok, tiktokOAuth } from "./tiktok/oauth";
import { tiktokPublisher } from "./tiktok/publisher";
import type { Publisher } from "./types";
import { refreshAccessToken as refreshYoutube, youtubeOAuth } from "./youtube/oauth";
import { youtubePublisher } from "./youtube/publisher";

/** Plattformen, die veröffentlichen können. */
export const publishers: Partial<Record<Platform, Publisher>> = {
  youtube: youtubePublisher,
  instagram: instagramPublisher,
  tiktok: tiktokPublisher,
  linkedin: linkedinPublisher,
  simulator: simulatorPublisher,
};

/** Anmeldung je Plattform. */
export const oauthProviders: Partial<Record<Platform, OAuthProvider>> = {
  youtube: youtubeOAuth,
  instagram: instagramOAuth,
  tiktok: tiktokOAuth,
  linkedin: linkedinOAuth,
};

/** Token-Erneuerung je Plattform. Instagram-Seiten-Tokens laufen nicht ab. */
export const tokenRefreshers: Partial<Record<Platform, (refreshToken: string) => Promise<StoredTokens>>> = {
  youtube: refreshYoutube,
  tiktok: refreshTikTok,
  linkedin: refreshLinkedIn,
};
