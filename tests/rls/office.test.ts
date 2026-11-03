import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, createTestOffice, retireStaff, signedInClient } from "../support/db";
import { testOfficeName } from "../support/test-data";

// Feature 17 — who may change an office row (spec AC-10, AC-11, AC-21) and the single-office guard (AC-19, AC-20).
// Two test firms on one database. Each office's name is restored after every change: the fixture office is found
// by its name on the next run (tests/support/db.ts).

type Who = "admin" | "manager" | "staff" | "limited";
const ROLES: Who[] = ["admin", "manager", "staff", "limited"];
let a: string, b: string;
const nameA = testOfficeName("tenancy-a");
const nameB = testOfficeName("tenancy-b");
const ua = {} as Record<Who, { id: string; email: string }>;
const asA = {} as Record<Who, SupabaseClient>;
let adminB: { id: string; email: string };
let asAdminB: SupabaseClient;

const officeRow = async (id: string) =>
  (await adminClient().from("office").select("name, branch, is_test, client_code_counter").eq("id", id).single()).data!;
const restore = async () => {
  await adminClient().from("office").update({ name: nameA, branch: "test" }).eq("id", a);
  await adminClient().from("office").update({ name: nameB, branch: "test" }).eq("id", b);
};

beforeAll(async () => {
  a = await createTestOffice("tenancy-a");
  b = await createTestOffice("tenancy-b");
  await restore();
  for (const r of ROLES) {
    ua[r] = await createStaff(a, `tenancy-a-${r}`, r);
    asA[r] = await signedInClient(ua[r].email);
  }
  adminB = await createStaff(b, "tenancy-b-admin", "admin");
  asAdminB = await signedInClient(adminB.email);
}, 120_000);

afterAll(async () => {
  await restore();
  await retireStaff([...ROLES.map((r) => ua[r]?.id), adminB?.id].filter(Boolean) as string[]);
});

describe("Editing the firm's name and branch (AC-10, AC-11)", () => {
  it("an Admin updates their own firm's name and branch", async () => {
    try {
      const { data, error } = await asA.admin.from("office").update({ name: `${nameA} renamed`, branch: "Chennai" }).eq("id", a).select("id");
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(await officeRow(a)).toMatchObject({ name: `${nameA} renamed`, branch: "Chennai" });
    } finally { await restore(); }
  });

  it("Manager, Staff and Limited change nothing", async () => {
    for (const r of ["manager", "staff", "limited"] as Who[]) {
      const { data } = await asA[r].from("office").update({ name: `${nameA} by ${r}` }).eq("id", a).select("id");
      expect({ r, rows: data?.length ?? 0 }).toEqual({ r, rows: 0 });
    }
    expect((await officeRow(a)).name).toBe(nameA);
  });

  it("no other column can be changed, even by an Admin (column grant)", async () => {
    for (const patch of [{ is_test: false }, { client_code_counter: 999 }, { fy_start_month: 1 }]) {
      const { error } = await asA.admin.from("office").update(patch).eq("id", a);
      expect({ patch, refused: !!error }).toEqual({ patch, refused: true });
    }
    expect(await officeRow(a)).toMatchObject({ is_test: true });
  });

  it("an Admin of firm B can't read or change firm A (AC-21)", async () => {
    const read = await asAdminB.from("office").select("id, name").eq("id", a);
    expect(read.data).toEqual([]);
    const { data } = await asAdminB.from("office").update({ name: "taken over" }).eq("id", a).select("id");
    expect(data ?? []).toHaveLength(0);
    expect((await officeRow(a)).name).toBe(nameA);
    const own = await asAdminB.from("office").select("id, name");
    expect(own.data).toEqual([{ id: b, name: nameB }]);
  });

  it("signed-out callers can't change offices", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
    const { data } = await anon.from("office").update({ name: "anon" }).eq("id", a).select("id");
    expect(data ?? []).toHaveLength(0);
    expect((await officeRow(a)).name).toBe(nameA);
  });
});

describe("Single-office guard (AC-19, AC-20) and single-mode bootstrap (AC-16, AC-17) — rolled-back probe", () => {
  it("single: a second real office and a test → real flip are refused; test offices are allowed; the bootstrap claims the staff-less firm; a different mode is refused", async () => {
    const { data, error } = await adminClient().rpc("test_tenancy_probe");
    expect(error).toBeNull();
    expect(data.single_second_real).toMatch(/^SINGLE_OFFICE/);
    expect(data.single_test_office).toBe("allowed");
    expect(data.single_test_to_real).toMatch(/^SINGLE_OFFICE/);
    expect(data).toMatchObject({ single_bootstrap: "claimed", single_claimed_same_row: true, single_claimed_name: "Probe Claimed" });
    expect(data.mode_mismatch).toMatch(/^DEPLOYMENT_MODE: this deployment is single/);
  });

  it("multi and unset: no guard; the bootstrap creates a new firm and never renames another", async () => {
    const { data } = await adminClient().rpc("test_tenancy_probe");
    expect(data).toMatchObject({
      multi_second_real: "allowed", multi_bootstrap: "created", multi_other_firm_kept: "probe firm one",
      unset_second_real: "allowed",
    });
  });

  it("the probe left nothing behind (no deployment mode, no probe offices)", async () => {
    const { data } = await adminClient().from("office").select("id").like("name", "probe %");
    expect(data).toEqual([]);
    const again = await adminClient().rpc("test_tenancy_probe"); // would refuse if a deployment row had been kept
    expect(again.error).toBeNull();
  });

  it("the probe is service-role only", async () => {
    const { error } = await asA.admin.rpc("test_tenancy_probe");
    expect(error).not.toBeNull();
  });
});
