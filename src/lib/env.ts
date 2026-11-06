import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** Lädt .env für Prozesse außerhalb von Next (Worker, Skripte). Next lädt .env selbst. */
export function loadDotEnv(cwd = process.cwd()): void {
  const file = path.join(cwd, ".env");
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

export const APP_PORT = 4321;

/**
 * Adresse, unter der die Oberfläche erreichbar ist. Daraus entstehen die OAuth-Weiterleitungen.
 * „localhost“ statt 127.0.0.1, weil Meta im Entwicklungsmodus nur localhost akzeptiert.
 */
export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL || `http://localhost:${APP_PORT}`).replace(/\/+$/, "");
}

/** Weiterleitungs-URI für die Anmeldung bei einer Plattform (überschreibbar, z. B. für eine HTTPS-Weiterleitungsseite). */
export function oauthRedirectUri(platform: string): string {
  return process.env[`${platform.toUpperCase()}_REDIRECT_URI`] || `${appBaseUrl()}/api/oauth/${platform}/callback`;
}

/** Ordner für Datenbank, Schlüsseldatei (nur ohne Keychain) und Logs. */
export function dataDir(): string {
  if (process.env.FPS_DATA_DIR) return path.resolve(process.env.FPS_DATA_DIR);
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "FokuspilotStudio");
  }
  return path.join(os.homedir(), ".local", "share", "fokuspilot-studio");
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const dbFile = () => path.join(dataDir(), "studio.db");
export const logDir = () => path.join(dataDir(), "logs");
export const defaultContentDir = () => path.join(os.homedir(), "Fokuspilot-Social");

export const googleConfig = () => ({
  clientId: process.env.GOOGLE_CLIENT_ID ?? "",
  clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  authUrl: process.env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token",
  apiBase: process.env.YOUTUBE_API_BASE || "https://www.googleapis.com",
});

export const youtubeConfigured = () => {
  const c = googleConfig();
  return Boolean(c.clientId && c.clientSecret);
};

export const metaConfig = () => {
  const version = process.env.META_GRAPH_VERSION || "v24.0";
  return {
    appId: process.env.META_APP_ID ?? "",
    appSecret: process.env.META_APP_SECRET ?? "",
    /** Konfigurations-ID aus „Facebook Login for Business“ (nötig für fortsetzbare Reels-Uploads) */
    configId: process.env.META_CONFIG_ID ?? "",
    version,
    dialogUrl: process.env.META_DIALOG_URL || `https://www.facebook.com/${version}/dialog/oauth`,
    graphBase: (process.env.META_GRAPH_BASE || "https://graph.facebook.com").replace(/\/+$/, ""),
    ruploadBase: (process.env.META_RUPLOAD_BASE || "https://rupload.facebook.com").replace(/\/+$/, ""),
  };
};

export const tiktokConfig = () => ({
  clientKey: process.env.TIKTOK_CLIENT_KEY ?? "",
  clientSecret: process.env.TIKTOK_CLIENT_SECRET ?? "",
  authUrl: process.env.TIKTOK_AUTH_URL || "https://www.tiktok.com/v2/auth/authorize/",
  apiBase: (process.env.TIKTOK_API_BASE || "https://open.tiktokapis.com").replace(/\/+$/, ""),
});

export const linkedinConfig = () => ({
  clientId: process.env.LINKEDIN_CLIENT_ID ?? "",
  clientSecret: process.env.LINKEDIN_CLIENT_SECRET ?? "",
  authBase: (process.env.LINKEDIN_AUTH_BASE || "https://www.linkedin.com/oauth/v2").replace(/\/+$/, ""),
  apiBase: (process.env.LINKEDIN_API_BASE || "https://api.linkedin.com").replace(/\/+$/, ""),
  /** Monatsversion der LinkedIn-API (JJJJMM); LinkedIn unterstützt jede Version etwa ein Jahr. */
  version: process.env.LINKEDIN_API_VERSION || "202605",
});
