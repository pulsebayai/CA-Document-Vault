import { createHash, randomBytes } from "node:crypto";

// Feature 10 — the link token (spec "Key definitions", NFR Security). Server-only.
// 32 random bytes, base64url (43 characters). Only its SHA-256 (hex) is stored. The raw token exists only in the
// value returned to the send action and in the message; it is never logged, never put in a URL path or query:
// the link carries it after "#", so browsers don't send it to our servers, Vercel logs or link-preview fetchers.

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  if (!TOKEN_PATTERN.test(token)) throw new Error("BAD_TOKEN");
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** `https://vault.example/u#<token>` — base is APP_PUBLIC_URL (no trailing slash, https only). */
export function buildLink(base: string, token: string): string {
  const url = new URL(base);
  if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error("LINK_BASE_NOT_HTTPS");
  if (!TOKEN_PATTERN.test(token)) throw new Error("BAD_TOKEN");
  return `${url.origin}/u#${token}`;
}

/** A new token and its hash, for one send. */
export function newLinkToken(): { token: string; hash: string } {
  const token = generateToken();
  return { token, hash: hashToken(token) };
}
