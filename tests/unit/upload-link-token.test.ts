import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { TOKEN_PATTERN, buildLink, generateToken, hashToken, newLinkToken } from "@/lib/upload-links/token";

// Feature 10 — the link token (spec NFR Security; plan step 3).

afterEach(() => vi.restoreAllMocks());

describe("token", () => {
  it("is 32 random bytes as 43 base64url characters, different every time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = generateToken();
      expect(t).toMatch(TOKEN_PATTERN);
      expect(Buffer.from(t, "base64url")).toHaveLength(32);
      seen.add(t);
    }
    expect(seen.size).toBe(200);
  });

  it("is stored only as its SHA-256 hex", () => {
    const { token, hash } = newLinkToken();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(hash).not.toContain(token);
    expect(() => hashToken("short")).toThrow("BAD_TOKEN");
  });

  it("goes after # in the link, never in the path or query", () => {
    const { token } = newLinkToken();
    const link = buildLink("https://vault.example.in/", token);
    expect(link).toBe(`https://vault.example.in/u#${token}`);
    const url = new URL(link);
    expect(url.pathname).toBe("/u");
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#${token}`);
    expect(() => buildLink("http://vault.example.in", token)).toThrow("LINK_BASE_NOT_HTTPS");
    expect(buildLink("http://localhost:3000", token)).toBe(`http://localhost:3000/u#${token}`);
  });

  it("is never written to the console", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const { token } = newLinkToken();
    buildLink("https://vault.example.in", token);
    try { hashToken("nope"); } catch { /* expected */ }
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});
