import crypto from "node:crypto";

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** PKCE nach RFC 7636 (base64url). TikTok verlangt abweichend die Hex-Darstellung. */
export function pkcePair(encoding: "base64url" | "hex" = "base64url"): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  const challenge = crypto.createHash("sha256").update(verifier).digest(encoding);
  return { verifier, challenge };
}
