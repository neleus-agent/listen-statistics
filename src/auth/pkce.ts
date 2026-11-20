import { createHash, randomBytes } from "node:crypto";

/**
 * PKCE (RFC 7636) helpers for Authorization Code + PKCE with S256.
 * base64url = base64 with +/ -> -_ and padding stripped.
 */
export function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Random high-entropy verifier (43-128 chars). 32 bytes -> 43 base64url chars. */
export function generateVerifier(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

/** S256 challenge = base64url(SHA256(verifier)). Deterministic — the unit test pins a known pair. */
export function challengeFromVerifier(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** A random URL-safe state value for CSRF protection on the auth round-trip. */
export function generateState(): string {
  return base64url(randomBytes(16));
}
