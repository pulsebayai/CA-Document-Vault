import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { adminClient, createStaff, createTestOffice, retireStaff, signedInClient } from "../support/db";
import { testOfficeName } from "../support/test-data";

// Feature 17 — public.bootstrap_office (spec AC-14, AC-15 as amended by review I-5, AC-18). Runs on its test path
// (test: true), which works only on test offices and never sets the deployment mode, so dev gains no real firm.
// Reuse is only by office ID (never by name). Creating a firm is proven in office.test.ts through the rolled-back
// probe, so this file adds no office per run.

let fresh: string; // never gets staff: reused by ID on every run
let staffed: string; // has an Admin: the bootstrap must refuse it
let staffedAdmin: { id: string; email: string };
let asAdmin: SupabaseClient;
const freshName = testOfficeName("bootstrap-fresh");

const boot = (p: Record<string, unknown>) => adminClient().rpc("bootstrap_office", { p: { mode: "multi", test: true, ...p } });

beforeAll(async () => {
  fresh = await createTestOffice("bootstrap-fresh");
  staffed = await createTestOffice("bootstrap-staffed");
  staffedAdmin = await createStaff(staffed, "bootstrap-staffed-admin", "admin");
  asAdmin = await signedInClient(staffedAdmin.email);
}, 120_000);

afterAll(async () => {
  await adminClient().from("office").update({ name: freshName, branch: "test" }).eq("id", fresh);
  await retireStaff([staffedAdmin?.id].filter(Boolean) as string[]);
});

describe("bootstrap_office (test path)", () => {
  it("reuses the staff-less office named by ID, sets its name and branch, seeds catalogue, financial years and formats, and logs it", async () => {
    const r = await boot({ office_id: fresh, name: freshName, branch: "Pondicherry" });
    expect(r.error).toBeNull();
    expect(r.data).toEqual({ office_id: fresh, result: "reused" });
    expect((await boot({ office_id: fresh, name: freshName, branch: "Pondicherry" })).data).toEqual({ office_id: fresh, result: "reused" }); // re-runnable

    const admin = adminClient();
    expect((await admin.from("office").select("name, branch, is_test").eq("id", fresh).single()).data)
      .toEqual({ name: freshName, branch: "Pondicherry", is_test: true });
    const groups = await admin.from("doc_group").select("id", { count: "exact", head: true }).eq("office_id", fresh);
    expect(groups.count).toBeGreaterThanOrEqual(10);
    const fys = await admin.from("financial_year").select("code").eq("office_id", fresh);
    expect((fys.data ?? []).map((f) => f.code)).toEqual(expect.arrayContaining(["2025-26", "2026-27"]));
    const formats = await admin.from("doc_type").select("name").eq("office_id", fresh).not("preferred_formats", "is", null);
    expect((formats.data ?? []).length).toBe(6); // 11's real-office seed, which offices created later never got
    const log = await admin.from("activity").select("action, actor_id, entity_type, entity_id, data")
      .eq("office_id", fresh).eq("action", "office.bootstrapped").order("id", { ascending: false }).limit(1).single();
    expect(log.data).toEqual({ action: "office.bootstrapped", actor_id: null, entity_type: "office", entity_id: fresh, data: { result: "reused" } });
  });

  it("refuses a firm that already has staff, an unknown ID, and a real office on the test path (AC-15)", async () => {
    expect((await boot({ office_id: staffed, name: "x" })).error?.message).toMatch(/^ALREADY_SET_UP/);
    expect((await boot({ office_id: randomUUID(), name: "x" })).error?.message).toMatch(/OFFICE_NOT_FOUND/);
    const { data: real } = await adminClient().from("office").select("id").eq("is_test", false).limit(1).maybeSingle();
    if (real) expect((await boot({ office_id: real.id, name: "x" })).error?.message).toMatch(/OFFICE_NOT_FOUND/);
  });

  it("validates its input", async () => {
    expect((await boot({ name: "  " })).error?.message).toMatch(/NAME_INVALID/);
    expect((await boot({ name: "x".repeat(121) })).error?.message).toMatch(/NAME_INVALID/);
    expect((await boot({ name: freshName, branch: "y".repeat(121) })).error?.message).toMatch(/BRANCH_INVALID/);
    expect((await boot({ name: freshName, mode: "saas" })).error?.message).toMatch(/MODE_INVALID/);
  });

  it("is executable by the service role only (AC-18)", async () => {
    const r = await asAdmin.rpc("bootstrap_office", { p: { name: "hijack", mode: "multi", test: true } });
    expect(r.error).not.toBeNull();
    const { createClient } = await import("@supabase/supabase-js");
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
    expect((await anon.rpc("bootstrap_office", { p: { name: "hijack", mode: "multi", test: true } })).error).not.toBeNull();
  });
});
