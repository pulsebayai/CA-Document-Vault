import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Feature 14 (spec AC-6, Q3; architecture "Secrets at rest") — DSC token PINs / passwords are encrypted HERE, in the
// server, before they reach the database, and decrypted here only after dsc_reveal (which checks the role and the
// client and logs the reveal). The ONLY module allowed to read DSC_ENC_KEYS / DSC_KEY_ID (ESLint fence).
//
//   DSC_ENC_KEYS = "<id>:<base64 of 32 bytes>[,<id>:<key>…]"   ids [a-z0-9]{1,16}; old ids stay listed after a rotation
//   DSC_KEY_ID   = the id new values are encrypted with
//   stored value = "k<id>.<iv>.<tag>.<ciphertext>"   base64url; AES-256-GCM, 12-byte random IV, 16-byte tag,
//                  additional data "dsc:<id>" (binds the value to its key id)
//
// Fails closed: no key, a malformed key, an unknown id or a tampered value throws DscKeyError, whose message is a
// fixed code — never the key, the ciphertext or the plain value. TEST_KEY is public and test-only (CI has no secrets,
// plan "Risks"); it is refused whenever APP_ENV or VERCEL_ENV is "production".

export type DscKeyErrorCode = "KEY_MISSING" | "KEY_INVALID" | "KEY_UNKNOWN" | "TEST_KEY_IN_PRODUCTION" | "BAD_CIPHERTEXT";

export class DscKeyError extends Error {
  constructor(readonly code: DscKeyErrorCode) {
    super(`DSC_CRYPTO_${code}`);
    this.name = "DscKeyError";
  }
}

export const TEST_KEY_ID = "test";
/** Public, test-only key (32 zero-to-31 bytes). Never valid in production. */
export const TEST_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64");

/** Same shape the database checks (dsc.password_ct). */
export const CIPHERTEXT_PATTERN = /^k[a-z0-9]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{2,600}$/;
const KEY_ID = /^[a-z0-9]{1,16}$/;

type Env = Record<string, string | undefined>;

function keyring(env: Env): Map<string, Buffer> {
  const raw = env.DSC_ENC_KEYS?.trim();
  if (!raw) throw new DscKeyError("KEY_MISSING");
  const ring = new Map<string, Buffer>();
  for (const part of raw.split(",")) {
    const at = part.indexOf(":");
    const id = part.slice(0, at).trim();
    const key = Buffer.from(part.slice(at + 1).trim(), "base64");
    if (at < 1 || !KEY_ID.test(id) || key.length !== 32 || ring.has(id)) throw new DscKeyError("KEY_INVALID");
    ring.set(id, key);
  }
  return ring;
}

function production(env: Env) {
  return env.APP_ENV === "production" || env.VERCEL_ENV === "production";
}

function keyFor(id: string, env: Env): Buffer {
  const ring = keyring(env);
  const key = ring.get(id);
  if (!key) throw new DscKeyError("KEY_UNKNOWN");
  if (id === TEST_KEY_ID && production(env)) throw new DscKeyError("TEST_KEY_IN_PRODUCTION");
  return key;
}

const aad = (id: string) => Buffer.from(`dsc:${id}`, "utf8");

export function encryptSecret(plain: string, env: Env = process.env): string {
  const id = env.DSC_KEY_ID?.trim();
  if (!id) {
    keyring(env); // a missing key list reports KEY_MISSING first
    throw new DscKeyError("KEY_MISSING");
  }
  if (!KEY_ID.test(id)) throw new DscKeyError("KEY_INVALID");
  const key = keyFor(id, env);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(id));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `k${id}.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
}

/** The key id a stored value was encrypted with (rotation tooling, tests). */
export function keyIdOf(stored: string): string {
  if (!CIPHERTEXT_PATTERN.test(stored)) throw new DscKeyError("BAD_CIPHERTEXT");
  return stored.slice(1, stored.indexOf("."));
}

export function decryptSecret(stored: string, env: Env = process.env): string {
  const id = keyIdOf(stored);
  const key = keyFor(id, env);
  const [, ivText, tagText, bodyText] = stored.split(".");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
    decipher.setAAD(aad(id));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(bodyText, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new DscKeyError("BAD_CIPHERTEXT");
  }
}

/** Whether the server can encrypt right now (the UI hides Add / Reveal with a plain message when it can't). */
export function cryptoReady(env: Env = process.env): boolean {
  try {
    encryptSecret("probe", env);
    return true;
  } catch {
    return false;
  }
}
