import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ESLint } from "eslint";

vi.mock("server-only", () => ({}));
import { readTenancyMode, TENANCY_MODE_CALLERS } from "@/lib/tenancy";

// Feature 17 (spec AC-1, AC-2): TENANCY_MODE switches the shell only; unset = multi; anything else fails closed.
describe("readTenancyMode (AC-1)", () => {
  it("unset or blank is multi", () => {
    expect(readTenancyMode(undefined)).toBe("multi");
    expect(readTenancyMode("")).toBe("multi");
    expect(readTenancyMode("   ")).toBe("multi");
  });

  it("multi and single in any case, trimmed", () => {
    expect(readTenancyMode("multi")).toBe("multi");
    expect(readTenancyMode(" SINGLE ")).toBe("single");
    expect(readTenancyMode("Multi")).toBe("multi");
  });

  it("any other value throws rather than guessing", () => {
    for (const v of ["saas", "singel", "1", "multi-tenant"]) {
      expect(() => readTenancyMode(v)).toThrow(/TENANCY_MODE must be multi or single/);
    }
  });
});

describe("TENANCY_MODE fence (AC-2)", () => {
  const eslint = new ESLint();
  const lint = async (filePath: string) => {
    const [r] = await eslint.lintText("export const m = process.env.TENANCY_MODE;\n", { filePath });
    return r.messages.filter((m) => m.ruleId === "no-restricted-syntax").map((m) => m.message);
  };

  it("only src/lib/tenancy.ts may read TENANCY_MODE; it keeps the other fences", async () => {
    expect((await lint("src/app/(auth)/login/page.tsx")).join(" ")).toMatch(/TENANCY_MODE may only be read in src\/lib\/tenancy\.ts/);
    expect((await lint("src/lib/mail/brevo.ts")).length).toBeGreaterThan(0);
    expect(await lint("src/lib/tenancy.ts")).toEqual([]);
    const [r] = await eslint.lintText("export const s = process.env.SUPABASE_SECRET_KEY;\n", { filePath: "src/lib/tenancy.ts" });
    expect(r.messages.some((m) => m.ruleId === "no-restricted-syntax")).toBe(true);
  }, 60_000);

  it("tenancyMode() is called only from the listed modules (the mode switches the shell, never business logic)", () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });
    const callers = files("src")
      .filter((f) => f !== join("src", "lib", "tenancy.ts"))
      .filter((f) => /\btenancyMode\s*\(/.test(readFileSync(f, "utf8")))
      .map((f) => f.split("\\").join("/"));
    expect(callers.sort()).toEqual([...TENANCY_MODE_CALLERS].sort());
  });
});
