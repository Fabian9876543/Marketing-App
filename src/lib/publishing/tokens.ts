import { readTokens, saveTokens } from "../accounts";
import type { DB } from "../db/client";
import type { Account } from "../db/schema";
import { tokenRefreshers } from "./registry";
import { PublishError } from "./types";

/** Gültiges Access-Token für ein Konto; erneuert es bei Bedarf und speichert es verschlüsselt. */
export async function getAccessToken(db: DB, account: Account): Promise<string> {
  const tokens = await readTokens(account);
  if (!tokens) throw new PublishError("auth", "Keine Zugangsdaten gespeichert – bitte Konto neu verbinden.");
  if (!tokens.expiresAt || tokens.expiresAt - 60_000 > Date.now()) return tokens.accessToken;
  if (!tokens.refreshToken) throw new PublishError("auth", "Anmeldung abgelaufen – bitte Konto neu verbinden.");
  const refresh = tokenRefreshers[account.platform];
  if (!refresh) throw new PublishError("fatal", `Token-Erneuerung für ${account.platform} fehlt`);
  const fresh = await refresh(tokens.refreshToken);
  const merged = { ...tokens, ...fresh, refreshToken: fresh.refreshToken ?? tokens.refreshToken };
  await saveTokens(db, account.id, merged);
  return merged.accessToken;
}
