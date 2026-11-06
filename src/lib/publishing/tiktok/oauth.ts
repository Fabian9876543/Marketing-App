import type { StoredTokens } from "../../accounts";
import { oauthRedirectUri, tiktokConfig } from "../../env";
import type { AppSettings } from "../../settings";
import { readJson, type OAuthProvider } from "../oauth";
import { PublishError } from "../types";

/** Entwürfe brauchen video.upload, direkte Posts zusätzlich video.publish. */
export function tiktokScopes(settings: AppSettings): string[] {
  const scopes = ["user.info.basic", "video.upload"];
  if (settings.tiktok.mode !== "draft") scopes.push("video.publish");
  return scopes;
}

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  open_id?: string;
  refresh_token?: string;
  refresh_expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse & { access_token: string }> {
  const c = tiktokConfig();
  const res = await fetch(`${c.apiBase}/v2/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: new URLSearchParams({ client_key: c.clientKey, client_secret: c.clientSecret, ...params }),
  });
  const json = await readJson<TokenResponse>(res);
  if (!res.ok || !json.access_token) {
    if (json.error === "invalid_grant" || json.error === "invalid_request") {
      throw new PublishError("auth", `TikTok-Anmeldung abgelaufen oder ungültig – bitte neu verbinden. (${json.error_description ?? json.error})`);
    }
    if (res.status >= 500) throw new PublishError("retryable", `TikTok-Anmeldung nicht erreichbar (${res.status})`);
    throw new PublishError("fatal", `TikTok-Token-Anfrage fehlgeschlagen: ${json.error_description ?? json.error ?? res.status}`);
  }
  return json as TokenResponse & { access_token: string };
}

const toTokens = (t: TokenResponse & { access_token: string }): StoredTokens => ({
  accessToken: t.access_token,
  refreshToken: t.refresh_token,
  expiresAt: Date.now() + (t.expires_in ?? 86_400) * 1000,
  scope: t.scope,
});

/** Access-Tokens gelten 24 Stunden, das Refresh-Token ein Jahr. */
export async function refreshTikTok(refreshToken: string): Promise<StoredTokens> {
  return toTokens(await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }));
}

export const tiktokOAuth: OAuthProvider = {
  platform: "tiktok",
  requiredEnv: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
  // Login Kit for Desktop: PKCE mit hex-codierter SHA-256-Prüfsumme
  pkce: "hex",
  redirectUri: () => oauthRedirectUri("tiktok"),

  authUrl({ state, codeChallenge, settings }) {
    const c = tiktokConfig();
    const url = new URL(c.authUrl);
    url.search = new URLSearchParams({
      client_key: c.clientKey,
      scope: tiktokScopes(settings).join(","),
      response_type: "code",
      redirect_uri: oauthRedirectUri("tiktok"),
      state,
      code_challenge: codeChallenge!,
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  },

  async connect({ code, codeVerifier }) {
    const t = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: oauthRedirectUri("tiktok"),
      code_verifier: codeVerifier,
    });
    const res = await fetch(`${tiktokConfig().apiBase}/v2/user/info/?fields=open_id,display_name,avatar_url`, {
      headers: { Authorization: `Bearer ${t.access_token}` },
    });
    const info = await readJson<{ data?: { user?: { open_id?: string; display_name?: string } } }>(res);
    const openId = info.data?.user?.open_id ?? t.open_id;
    if (!openId) throw new Error("TikTok hat keine Konto-ID geliefert");
    return [
      {
        externalId: openId,
        name: info.data?.user?.display_name || "TikTok-Konto",
        handle: null,
        tokens: toTokens(t),
        reconnectBy: t.refresh_expires_in ? new Date(Date.now() + t.refresh_expires_in * 1000) : null,
      },
    ];
  },
};
