import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** Lädt .env für Prozesse außerhalb von Next (Worker, Skripte). Next lädt .env selbst. */
export function loadDotEnv(cwd = process.cwd()): void {
  const file = path.join(cwd, ".env");
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

export const APP_PORT = 4321;

export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL || `http://127.0.0.1:${APP_PORT}`).replace(/\/+$/, "");
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
