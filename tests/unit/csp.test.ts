import { describe, expect, it } from "vitest";
import { buildCsp, newNonce } from "@/lib/security/csp";

describe("Content-Security-Policy", () => {
  const csp = buildCsp("abc123", "https://ysddbwskljzhbjjohool.supabase.co/", false);
  it("allows scripts only with the request nonce", () => {
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("unsafe-inline");
  });
  it("blocks framing and plugins, and limits connections to our Supabase project", () => {
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("connect-src 'self' https://ysddbwskljzhbjjohool.supabase.co");
  });
  it("generates a different nonce each time", () => expect(newNonce()).not.toBe(newNonce()));
});
