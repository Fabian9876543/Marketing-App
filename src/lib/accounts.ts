import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { DB } from "./db/client";
import { accounts, postTargets, type Account, type Platform } from "./db/schema";
import { decrypt, encrypt } from "./secrets/cipher";
import { getEncryptionKey } from "./secrets/keystore";

export type StoredTokens = {
  accessToken: string;
  refreshToken?: string;
  /** Ablauf des Access-Tokens (ms seit Epoch) */
  expiresAt?: number;
  scope?: string;
};

export const PLATFORM_LABEL: Record<Platform, string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  simulator: "Test-Kanal",
};

export function listAccounts(db: DB, opts: { includeDisabled?: boolean } = {}): Account[] {
  const q = db.select().from(accounts);
  return (opts.includeDisabled ? q : q.where(ne(accounts.status, "disabled"))).orderBy(asc(accounts.id)).all();
}

export function getAccount(db: DB, id: number): Account | undefined {
  return db.select().from(accounts).where(eq(accounts.id, id)).get();
}

/** Konto anlegen oder (bei erneutem Verbinden) aktualisieren. */
export async function upsertAccount(
  db: DB,
  input: { platform: Platform; externalId: string; name: string; handle?: string | null; tokens?: StoredTokens | null },
): Promise<Account> {
  const tokens = input.tokens ? await sealTokens(input.tokens) : null;
  const values = {
    platform: input.platform,
    externalId: input.externalId,
    name: input.name,
    handle: input.handle ?? null,
    tokens,
    status: "active" as const,
    statusMessage: null,
  };
  return db
    .insert(accounts)
    .values(values)
    .onConflictDoUpdate({ target: [accounts.platform, accounts.externalId], set: values })
    .returning()
    .get();
}

export async function saveTokens(db: DB, accountId: number, tokens: StoredTokens): Promise<void> {
  db.update(accounts)
    .set({ tokens: await sealTokens(tokens) })
    .where(eq(accounts.id, accountId))
    .run();
}

export async function readTokens(account: Account): Promise<StoredTokens | null> {
  if (!account.tokens) return null;
  const { key } = await getEncryptionKey();
  return JSON.parse(decrypt(account.tokens, key)) as StoredTokens;
}

async function sealTokens(tokens: StoredTokens): Promise<string> {
  const { key } = await getEncryptionKey();
  return encrypt(JSON.stringify(tokens), key);
}

export function markNeedsReconnect(db: DB, accountId: number, message: string): void {
  db.update(accounts).set({ status: "needs_reconnect", statusMessage: message }).where(eq(accounts.id, accountId)).run();
}

/** Konto trennen: Tokens löschen, offene Veröffentlichungen auf diesem Konto abbrechen. */
export function disconnectAccount(db: DB, accountId: number): void {
  db.transaction((tx) => {
    tx.update(accounts)
      .set({ status: "disabled", tokens: null, statusMessage: "Getrennt" })
      .where(eq(accounts.id, accountId))
      .run();
    tx.update(postTargets)
      .set({ state: "cancelled", lastError: "Konto wurde getrennt" })
      .where(and(eq(postTargets.accountId, accountId), inArray(postTargets.state, ["pending", "failed", "missed"])))
      .run();
  });
}
