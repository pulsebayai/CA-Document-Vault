import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The service-role client is mocked so the test can prove multi mode never constructs it (AC-3).
const query = { rows: [] as Array<{ name: string; branch: string | null }>, filters: [] as string[] };
const createAdminClient = vi.fn(() => {
  const builder = {
    select: () => builder,
    eq: (col: string, val: unknown) => { query.filters.push(`${col}=${String(val)}`); return builder; },
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({ data: query.rows[0] ?? null, error: null }),
  };
  return { from: (table: string) => { query.filters.push(`from:${table}`); return builder; } };
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));

import { loginBrand, PLATFORM_NAME } from "@/lib/auth/login-brand";

// Feature 17 (spec AC-3, AC-4).
describe("loginBrand", () => {
  beforeEach(() => {
    createAdminClient.mockClear();
    query.rows = [];
    query.filters = [];
    delete process.env.TENANCY_MODE;
  });

  it("multi (unset): the platform name, no branch, and no database client at all", async () => {
    query.rows = [{ name: "Kushal Associates", branch: "Pondicherry" }];
    expect(await loginBrand()).toEqual({ name: "CA Document Vault", branch: null });
    expect(PLATFORM_NAME).toBe("CA Document Vault");
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("multi (explicit): same", async () => {
    process.env.TENANCY_MODE = "multi";
    expect(await loginBrand()).toEqual({ name: "CA Document Vault", branch: null });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("single: the deployment's one non-test office (test offices never shown)", async () => {
    process.env.TENANCY_MODE = "single";
    query.rows = [{ name: "Sharma & Co", branch: "Chennai" }];
    expect(await loginBrand()).toEqual({ name: "Sharma & Co", branch: "Chennai" });
    expect(query.filters).toContain("from:office");
    expect(query.filters).toContain("is_test=false");
  });

  it("single with no real office yet: the platform name", async () => {
    process.env.TENANCY_MODE = "single";
    expect(await loginBrand()).toEqual({ name: "CA Document Vault", branch: null });
  });

  it("an invalid mode fails closed", async () => {
    process.env.TENANCY_MODE = "saas";
    await expect(loginBrand()).rejects.toThrow(/TENANCY_MODE/);
  });
});
