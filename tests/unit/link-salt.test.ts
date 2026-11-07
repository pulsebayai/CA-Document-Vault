import { afterEach, describe, expect, it, vi } from "vitest";

// 10 (review N5) + chore ses-mailer: the upload links' IP salt fails closed wherever real clients could arrive —
// prod, a Vercel production deployment, or real email (Brevo, and now SES on staging/prod).

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Map([["x-forwarded-for", "203.0.113.7"]]) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

const hash = async () => (await import("@/lib/upload-links/public")).ipHash();
const clean = () => { for (const k of ["LINK_IP_SALT", "APP_ENV", "VERCEL_ENV", "MAIL_TRANSPORT"]) vi.stubEnv(k, ""); };

describe("ipHash salt", () => {
  it.each(["brevo", "ses"])("refuses to run without LINK_IP_SALT when MAIL_TRANSPORT=%s", async (t) => {
    clean(); vi.stubEnv("MAIL_TRANSPORT", t);
    await expect(hash()).rejects.toThrow(/LINK_IP_SALT is not set/);
  });

  it("refuses on production too, and uses the dev salt only where no real client can arrive", async () => {
    clean(); vi.stubEnv("VERCEL_ENV", "production");
    await expect(hash()).rejects.toThrow(/LINK_IP_SALT/);
    clean(); vi.stubEnv("MAIL_TRANSPORT", "test");
    await expect(hash()).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it("with a salt set, hashes and never returns the IP", async () => {
    clean(); vi.stubEnv("MAIL_TRANSPORT", "ses"); vi.stubEnv("LINK_IP_SALT", "s".repeat(32));
    const h = await hash();
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("203.0.113.7");
  });
});
