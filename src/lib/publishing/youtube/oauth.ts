import type { StoredTokens } from "../../accounts";
import { appBaseUrl, googleConfig } from "../../env";
import { PublishError } from "../types";

export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

export const youtubeRedirectUri = () => `${appBaseUrl()}/api/oauth/youtube/callback`;

export function buildAuthUrl(opts: { state: string; codeChallenge: string }): string {
  const c = googleConfig();
  const url = new URL(c.authUrl);
  url.search = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: youtubeRedirectUri(),
    response_type: "code",
    scope: YOUTUBE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function tokenRequest(params: Record<string, string>): Promise<StoredTokens> {
  const c = googleConfig();
  const res = await fetch(c.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...params }),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    if (json.error === "invalid_grant") {
      throw new PublishError(
        "auth",
        "Die Verbindung zu YouTube ist abgelaufen oder wurde widerrufen – bitte unter „Konten“ neu verbinden. " +
          "(Im Testmodus von Google passiert das nach 7 Tagen.)",
      );
    }
    if (json.error === "invalid_client" || json.error === "unauthorized_client") {
      throw new PublishError("fatal", `Google lehnt den OAuth-Client ab (${json.error}). GOOGLE_CLIENT_ID/SECRET in .env prüfen.`);
    }
    if (res.status >= 500) throw new PublishError("retryable", `Google-Anmeldung nicht erreichbar (${res.status})`);
    throw new PublishError("fatal", `Token-Anfrage fehlgeschlagen: ${json.error_description ?? json.error ?? res.status}`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    scope: json.scope,
  };
}

export function exchangeCode(code: string, codeVerifier: string): Promise<StoredTokens> {
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: youtubeRedirectUri(),
  });
}

export function refreshAccessToken(refreshToken: string): Promise<StoredTokens> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
}

export type ChannelInfo = { id: string; title: string; handle: string | null };

export async function fetchMyChannel(accessToken: string): Promise<ChannelInfo> {
  const res = await fetch(`${googleConfig().apiBase}/youtube/v3/channels?part=snippet&mine=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Kanal konnte nicht gelesen werden (${res.status})`);
  const json = (await res.json()) as { items?: { id: string; snippet?: { title?: string; customUrl?: string } }[] };
  const ch = json.items?.[0];
  if (!ch) throw new Error("Zu diesem Google-Konto gibt es keinen YouTube-Kanal");
  return { id: ch.id, title: ch.snippet?.title ?? "YouTube-Kanal", handle: ch.snippet?.customUrl ?? null };
}
