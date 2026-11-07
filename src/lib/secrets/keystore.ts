import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir, ensureDir } from "../env";

const SERVICE = "Marketing Studio";
/** Frühere Installationen speicherten den Schlüssel unter diesem Namen. */
const LEGACY_SERVICE = "Fokuspilot Studio";
const ACCOUNT = "token-encryption-key";

export type KeySource = "keychain" | "file";

let cached: { key: Buffer; source: KeySource } | null = null;

/**
 * Liefert den Schlüssel zum Verschlüsseln der Plattform-Tokens.
 * Auf dem Mac liegt er in der Keychain. Ohne Keychain (z. B. Linux-Server
 * ohne Schlüsselbund) in einer Datei, die nur der eigene Benutzer lesen darf.
 */
export async function getEncryptionKey(): Promise<{ key: Buffer; source: KeySource }> {
  if (cached) return cached;
  cached = (await fromKeyring()) ?? fromFile();
  return cached;
}

async function fromKeyring(): Promise<{ key: Buffer; source: KeySource } | null> {
  if ((process.env.STUDIO_KEYSTORE || process.env.FPS_KEYSTORE) === "file") return null;
  try {
    const { Entry } = await import("@napi-rs/keyring");
    const entry = new Entry(SERVICE, ACCOUNT);
    let value = entry.getPassword();
    if (!value) {
      // Schlüssel einer früheren Installation übernehmen, sonst wären gespeicherte Zugangsdaten unlesbar.
      let legacy: string | null = null;
      try {
        legacy = new Entry(LEGACY_SERVICE, ACCOUNT).getPassword();
      } catch {
        legacy = null;
      }
      value = legacy || crypto.randomBytes(32).toString("base64");
      entry.setPassword(value);
    }
    const key = Buffer.from(value, "base64");
    if (key.length !== 32) throw new Error("Schlüssel in der Keychain hat die falsche Länge");
    return { key, source: "keychain" };
  } catch (err) {
    if (process.platform === "darwin") {
      // Auf dem Mac soll die Keychain funktionieren – lieber laut scheitern als still auf Datei ausweichen.
      throw new Error(`Keychain nicht erreichbar: ${(err as Error).message}`);
    }
    return null;
  }
}

function fromFile(): { key: Buffer; source: KeySource } {
  const file = path.join(ensureDir(dataDir()), "secret.key");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
  }
  fs.chmodSync(file, 0o600);
  const key = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error(`Schlüsseldatei ${file} ist beschädigt`);
  return { key, source: "file" };
}

/** Nur für Tests. */
export function __setTestKey(key: Buffer | null): void {
  cached = key ? { key, source: "file" } : null;
}
