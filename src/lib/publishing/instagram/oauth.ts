import { metaConfig, oauthRedirectUri } from "../../env";
import type { ConnectedAccount, OAuthProvider } from "../oauth";
import { graph } from "./graph";

/** Rechte für Reels-Veröffentlichung über eine mit Instagram verknüpfte Facebook-Seite. */
export const INSTAGRAM_SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_insights",
  "pages_show_list",
  "pages_read_engagement",
  "business_management",
];

type Page = {
  id: string;
  name: string;
  access_token?: string;
  instagram_business_account?: { id: string; username?: string; name?: string };
};

export const instagramOAuth: OAuthProvider = {
  platform: "instagram",
  requiredEnv: ["META_APP_ID", "META_APP_SECRET"],
  pkce: null,
  redirectUri: () => oauthRedirectUri("instagram"),

  authUrl({ state }) {
    const c = metaConfig();
    const url = new URL(c.dialogUrl);
    const params: Record<string, string> = {
      client_id: c.appId,
      redirect_uri: oauthRedirectUri("instagram"),
      state,
      response_type: "code",
    };
    // Facebook Login for Business: Rechte kommen aus der Konfiguration.
    if (c.configId) Object.assign(params, { config_id: c.configId, override_default_response_type: "true" });
    else params.scope = INSTAGRAM_SCOPES.join(",");
    url.search = new URLSearchParams(params).toString();
    return url.toString();
  },

  async connect({ code }) {
    const c = metaConfig();
    const short = await graph<{ access_token: string }>(
      "GET",
      "oauth/access_token",
      { client_id: c.appId, client_secret: c.appSecret, redirect_uri: oauthRedirectUri("instagram"), code },
      "Anmeldung bei Meta",
    );
    // Kurzlebiges in langlebiges Nutzer-Token tauschen; daraus abgeleitete Seiten-Tokens laufen nicht ab.
    const long = await graph<{ access_token: string }>(
      "GET",
      "oauth/access_token",
      { grant_type: "fb_exchange_token", client_id: c.appId, client_secret: c.appSecret, fb_exchange_token: short.access_token },
      "Langlebiges Token",
    );
    const pages = await graph<{ data: Page[] }>(
      "GET",
      "me/accounts",
      { fields: "id,name,access_token,instagram_business_account{id,username,name}", limit: "100", access_token: long.access_token },
      "Facebook-Seiten lesen",
    );

    // Meta entzieht Datenzugriff nach ~90 Tagen ohne erneute Anmeldung – Erinnerung setzen.
    let reconnectBy: Date | null = null;
    let userTokenExpiresAt: number | null = null;
    try {
      const dbg = await graph<{ data?: { data_access_expires_at?: number; expires_at?: number } }>(
        "GET",
        "debug_token",
        { input_token: long.access_token, access_token: `${c.appId}|${c.appSecret}` },
        "Token prüfen",
      );
      if (dbg.data?.data_access_expires_at) reconnectBy = new Date(dbg.data.data_access_expires_at * 1000);
      if (dbg.data?.expires_at) userTokenExpiresAt = dbg.data.expires_at * 1000;
    } catch {
      // nicht kritisch
    }

    const found: ConnectedAccount[] = pages.data
      .filter((p) => p.instagram_business_account && p.access_token)
      .map((p) => {
        const ig = p.instagram_business_account!;
        return {
          externalId: ig.id,
          name: ig.name || ig.username || p.name,
          handle: ig.username ? `@${ig.username}` : null,
          tokens: { accessToken: p.access_token!, scope: `page:${p.id}` },
          reconnectBy,
          metaUserToken: { token: long.access_token, expiresAt: userTokenExpiresAt },
        };
      });
    if (!found.length) {
      throw new Error(
        "Kein Instagram-Business- oder Creator-Konto gefunden, das mit einer deiner Facebook-Seiten verknüpft ist. " +
          "Verknüpfe das Instagram-Konto in den Instagram-Einstellungen mit einer Facebook-Seite und erlaube bei der Anmeldung den Zugriff auf diese Seite.",
      );
    }
    return found;
  },
};
