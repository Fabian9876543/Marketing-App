import type { StoredTokens } from "../accounts";
import type { Platform } from "../db/schema";
import type { AppSettings } from "../settings";

/** Ein Konto, das nach der Anmeldung verbunden wird (Instagram kann mehrere liefern). */
export type ConnectedAccount = {
  externalId: string;
  name: string;
  handle?: string | null;
  tokens: StoredTokens;
  /** Bis wann neu verbunden werden muss; null = unbegrenzt */
  reconnectBy?: Date | null;
};

/** Anmeldung bei einer Plattform (OAuth 2.0 Authorization Code). */
export interface OAuthProvider {
  platform: Platform;
  /** Env-Variablen, ohne die die Anmeldung nicht funktioniert */
  requiredEnv: string[];
  /** PKCE-Codierung der Prüfsumme; null = ohne PKCE */
  pkce: "base64url" | "hex" | null;
  redirectUri(): string;
  authUrl(opts: { state: string; codeChallenge: string | null; settings: AppSettings }): string;
  /** Code gegen Tokens tauschen und das/die Konto(en) ermitteln. */
  connect(opts: { code: string; codeVerifier: string; settings: AppSettings }): Promise<ConnectedAccount[]>;
}

export const missingEnv = (provider: OAuthProvider): string[] => provider.requiredEnv.filter((k) => !process.env[k]);

/** Liest eine JSON-Antwort, ohne bei leerem/kaputtem Body zu werfen. */
export async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    return { raw: text } as T;
  }
}
