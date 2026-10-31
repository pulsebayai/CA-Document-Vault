// @vitest-environment node
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ESLint } from "eslint";

vi.mock("server-only", () => ({}));
import {
  CIPHERTEXT_PATTERN, DscKeyError, TEST_KEY, TEST_KEY_ID, decryptSecret, encryptSecret, keyIdOf,
} from "@/lib/dsc/crypto";

// Feature 14 spec AC-6, Q3, "Functional requirements" (server-only module src/lib/dsc/crypto.ts). Written before
// the module (plan step 1). Contract:
//   env DSC_ENC_KEYS = "<id>:<base64 32 bytes>[,<id>:<key>…]" (ids [a-z0-9]{1,16}); DSC_KEY_ID = the id used to encrypt.
//   encryptSecret(plain, env?) → "k<id>.<iv 12 B>.<tag 16 B>.<ct>" (base64url) — AES-256-GCM, a random IV each time.
//   decryptSecret(ct, env?) → plain, by the key named in the ciphertext (old keys keep working after a rotation).
//   Errors are DscKeyError with a code, never the key or the plain value:
//     KEY_MISSING (no keys / no current id) · KEY_INVALID (not 32 bytes, bad id) · KEY_UNKNOWN (id not in the list) ·
//     TEST_KEY_IN_PRODUCTION (the fixed CI key while APP_ENV or VERCEL_ENV is production) · BAD_CIPHERTEXT (shape or tag).
//   TEST_KEY / TEST_KEY_ID: the fixed, public, test-only key (plan "Risks", decided 2026-10-31).

const key = () => randomBytes(32).toString("base64");
const k1 = key();
const k2 = key();
const env = (over: Record<string, string | undefined> = {}) => ({ DSC_ENC_KEYS: `1:${k1}`, DSC_KEY_ID: "1", ...over });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DscKeyError);
    return (e as DscKeyError).code;
  }
  throw new Error("expected a DscKeyError");
};

describe("DSC password encryption (AC-6)", () => {
  it("round-trips, including non-ASCII and the 100-character maximum", () => {
    for (const plain of ["1234", "pässwörd ₹ 12", "x".repeat(100)]) {
      expect(decryptSecret(encryptSecret(plain, env()), env())).toBe(plain);
    }
  });

  it("produces the stored shape, names its key, and never contains the plain value", () => {
    const ct = encryptSecret("token-pin-4321", env());
    expect(ct).toMatch(CIPHERTEXT_PATTERN);
    expect(ct.startsWith("k1.")).toBe(true);
    expect(keyIdOf(ct)).toBe("1");
    expect(ct).not.toContain("token-pin-4321");
    expect(Buffer.from(ct.split(".")[3], "base64url").toString("utf8")).not.toContain("token-pin");
  });

  it("uses a fresh IV every time (same password, different ciphertext)", () => {
    expect(encryptSecret("same", env())).not.toBe(encryptSecret("same", env()));
  });

  it("refuses a tampered ciphertext, IV or tag", () => {
    const ct = encryptSecret("secret", env());
    const [id, iv, tag, body] = ct.split(".");
    const flip = (s: string) => {
      const b = Buffer.from(s, "base64url");
      b[0] ^= 1;
      return b.toString("base64url");
    };
    for (const bad of [[id, iv, tag, flip(body)], [id, flip(iv), tag, body], [id, iv, flip(tag), body]]) {
      expect(code(() => decryptSecret(bad.join("."), env()))).toBe("BAD_CIPHERTEXT");
    }
    expect(code(() => decryptSecret("not-a-ciphertext", env()))).toBe("BAD_CIPHERTEXT");
  });

  it("decrypts by the ciphertext's key ID after a rotation; an unknown ID is refused", () => {
    const old = encryptSecret("old", env());
    const rotated = env({ DSC_ENC_KEYS: `1:${k1},2:${k2}`, DSC_KEY_ID: "2" });
    const fresh = encryptSecret("new", rotated);
    expect(keyIdOf(fresh)).toBe("2");
    expect(decryptSecret(old, rotated)).toBe("old");
    expect(decryptSecret(fresh, rotated)).toBe("new");
    expect(code(() => decryptSecret(fresh, env()))).toBe("KEY_UNKNOWN");
  });

  it("a wrong key under the same ID fails as BAD_CIPHERTEXT, not as a wrong password", () => {
    const ct = encryptSecret("secret", env());
    expect(code(() => decryptSecret(ct, env({ DSC_ENC_KEYS: `1:${k2}` })))).toBe("BAD_CIPHERTEXT");
  });

  it("fails closed when the key is missing or malformed", () => {
    expect(code(() => encryptSecret("x", {}))).toBe("KEY_MISSING");
    expect(code(() => encryptSecret("x", env({ DSC_KEY_ID: undefined })))).toBe("KEY_MISSING");
    expect(code(() => encryptSecret("x", env({ DSC_KEY_ID: "9" })))).toBe("KEY_UNKNOWN");
    expect(code(() => encryptSecret("x", env({ DSC_ENC_KEYS: `1:${randomBytes(16).toString("base64")}` })))).toBe("KEY_INVALID");
    expect(code(() => encryptSecret("x", env({ DSC_ENC_KEYS: `BAD ID:${k1}`, DSC_KEY_ID: "BAD ID" })))).toBe("KEY_INVALID");
    expect(code(() => decryptSecret(encryptSecret("x", env()), {}))).toBe("KEY_MISSING");
  });

  it("error messages never carry the key or the plain value", () => {
    const ct = encryptSecret("plain-secret", env());
    for (const fn of [() => decryptSecret(ct, env({ DSC_ENC_KEYS: `1:${k2}` })), () => encryptSecret("plain-secret", env({ DSC_KEY_ID: "9" }))]) {
      try {
        fn();
      } catch (e) {
        const text = `${(e as Error).message} ${(e as Error).stack ?? ""}`;
        expect(text).not.toContain(k1);
        expect(text).not.toContain(k2);
        expect(text).not.toContain("plain-secret");
      }
    }
  });

  it("the fixed test key works in tests and is refused in production (plan Risks)", () => {
    const test = { DSC_ENC_KEYS: `${TEST_KEY_ID}:${TEST_KEY}`, DSC_KEY_ID: TEST_KEY_ID };
    expect(decryptSecret(encryptSecret("ci", test), test)).toBe("ci");
    expect(code(() => encryptSecret("x", { ...test, APP_ENV: "production" }))).toBe("TEST_KEY_IN_PRODUCTION");
    expect(code(() => encryptSecret("x", { ...test, VERCEL_ENV: "production" }))).toBe("TEST_KEY_IN_PRODUCTION");
    const ct = encryptSecret("x", test);
    expect(code(() => decryptSecret(ct, { ...test, APP_ENV: "production" }))).toBe("TEST_KEY_IN_PRODUCTION");
  });
});

describe("key fence (spec FR: only crypto.ts reads DSC_ENC_KEYS)", () => {
  const eslint = new ESLint();
  const lint = async (filePath: string) => {
    const [r] = await eslint.lintText("export const k = process.env.DSC_ENC_KEYS;\n", { filePath });
    return r.messages.filter((m) => m.ruleId === "no-restricted-syntax").map((m) => m.message);
  };

  it("any other module reading DSC_ENC_KEYS is a lint error; crypto.ts may", async () => {
    expect((await lint("src/lib/dsc/actions.ts")).join(" ")).toMatch(/DSC_ENC_KEYS may only be read in src\/lib\/dsc\/crypto\.ts/);
    expect((await lint("src/app/(app)/clients/[id]/dsc-view.tsx")).length).toBeGreaterThan(0);
    expect(await lint("src/lib/dsc/crypto.ts")).toEqual([]);
  }, 60_000);

  it("crypto.ts still may not read the other secrets", async () => {
    const [r] = await eslint.lintText("export const s = process.env.SUPABASE_SECRET_KEY;\n", { filePath: "src/lib/dsc/crypto.ts" });
    expect(r.messages.some((m) => m.ruleId === "no-restricted-syntax")).toBe(true);
  }, 60_000);
});
