import crypto from "node:crypto";

/**
 * AES-256-GCM. Format: "v1:<iv>:<tag>:<ciphertext>" (jeweils base64).
 * Der Schlüssel kommt aus der macOS-Keychain (siehe keystore.ts).
 */
export function encrypt(plaintext: string, key: Buffer): string {
  if (key.length !== 32) throw new Error("Schlüssel muss 32 Byte lang sein");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), data.toString("base64")].join(":");
}

export function decrypt(payload: string, key: Buffer): string {
  const [version, iv, tag, data] = payload.split(":");
  if (version !== "v1" || !iv || !tag || data === undefined) throw new Error("Unbekanntes Format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}
