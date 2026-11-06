import type { StoredTokens } from "../../accounts";
import { linkedinConfig, oauthRedirectUri } from "../../env";
import { readJson, type OAuthProvider } from "../oauth";
import { PublishError } from "../types";

/** openid + profile für Name/ID, w_member_social zum Posten aufs persönliche Profil. */
export const LINKEDIN_SCOPES = ["openid", "profile", "w_member_social"];

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse & { access_token: string }> {
  const c = linkedinConfig();
  const res = await fetch(`${c.authBase}/accessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...params }),
  });
  const json = await readJson<TokenResponse>(res);
  if (!res.ok || !json.access_token) {
    if (json.error === "invalid_grant") throw new PublishError("auth", "LinkedIn-Anmeldung abgelaufen – bitte neu verbinden.");
    if (res.status >= 500) throw new PublishError("retryable", `LinkedIn-Anmeldung nicht erreichbar (${res.status})`);
    throw new PublishError("fatal", `LinkedIn-Token-Anfrage fehlgeschlagen: ${json.error_description ?? json.error ?? res.status}`);
  }
  return json as TokenResponse & { access_token: string };
}

const toTokens = (t: TokenResponse & { access_token: string }): StoredTokens => ({
  accessToken: t.access_token,
  refreshToken: t.refresh_token,
  expiresAt: Date.now() + (t.expires_in ?? 60 * 86_400) * 1000,
  scope: t.scope,
});

/** Nur für von LinkedIn freigeschaltete Apps gibt es Refresh-Tokens; sonst nach 60 Tagen neu verbinden. */
export async function refreshLinkedIn(refreshToken: string): Promise<StoredTokens> {
  return toTokens(await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }));
}

export const linkedinOAuth: OAuthProvider = {
  platform: "linkedin",
  requiredEnv: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
  pkce: null,
  redirectUri: () => oauthRedirectUri("linkedin"),

  authUrl({ state }) {
    const c = linkedinConfig();
    const url = new URL(`${c.authBase}/authorization`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: c.clientId,
      redirect_uri: oauthRedirectUri("linkedin"),
      state,
      scope: LINKEDIN_SCOPES.join(" "),
    }).toString();
    return url.toString();
  },

  async connect({ code }) {
    const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: oauthRedirectUri("linkedin") });
    const res = await fetch(`${linkedinConfig().apiBase}/v2/userinfo`, { headers: { Authorization: `Bearer ${t.access_token}` } });
    const me = await readJson<{ sub?: string; name?: string; given_name?: string; family_name?: string }>(res);
    if (!res.ok || !me.sub) throw new Error("LinkedIn-Profil konnte nicht gelesen werden – ist „Sign In with LinkedIn using OpenID Connect“ in der App aktiviert?");
    const tokens = toTokens(t);
    const validUntil = t.refresh_token && t.refresh_token_expires_in ? Date.now() + t.refresh_token_expires_in * 1000 : tokens.expiresAt!;
    return [
      {
        externalId: me.sub,
        name: me.name || [me.given_name, me.family_name].filter(Boolean).join(" ") || "LinkedIn-Profil",
        handle: "persönliches Profil",
        tokens,
        reconnectBy: new Date(validUntil),
      },
    ];
  },
};
