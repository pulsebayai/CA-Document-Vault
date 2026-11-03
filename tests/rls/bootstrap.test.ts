import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, createTestOffice, retireStaff, signedInClient } from "../support/db";
import { testOfficeName } from "../support/test-data";

// Feature 17 — public.bootstrap_office (spec AC-14, AC-15, AC-18). Runs on its test path (test: true), which works
// only on test offices and never sets the deployment mode, so dev gains no real firm. The real-mode paths (claim,
// mode mismatch) are proven in office.test.ts through the rolled-back probe.

const fresh = testOfficeName("bootstrap-fresh"); // never gets staff: reused on every run
const staffed = testOfficeName("bootstrap-staffed"); // has an Admin: the bootstrap must refuse it
let staffedAdmin: { id: string; email: string };
let asAdmin: SupabaseClient;

const boot = (p: Record<string, unknown>) => adminClient().rpc("bootstrap_office", { p: { mode: "multi", test: true, ...p } });

beforeAll(async () => {
  const id = await createTestOffice("bootstrap-staffed");
  staffedAdmin = await createStaff(id, "bootstrap-staffed-admin", "admin");
  asAdmin = await signedInClient(staffedAdmin.email);
}, 120_000);

afterAll(async () => { await retireStaff([staffedAdmin?.id].filter(Boolean) as string[]); });

describe("bootstrap_office (test path)", () => {
  it("creates (first run ever) or reuses a staff-less firm, seeds its catalogue, financial years and formats, and logs it", async () => {
    const first = await boot({ name: fresh, branch: "Pondicherry" });
    expect(first.error).toBeNull();
    expect(["created", "reused"]).toContain(first.data.result);
    const again = await boot({ name: fresh });
    expect(again.data).toEqual({ office_id: first.data.office_id, result: "reused" }); // AC-15: no duplicate
    const id = first.data.office_id as string;

    const admin = adminClient();
    const office = (await admin.from("office").select("name, branch, is_test").eq("id", id).single()).data;
    expect(office).toEqual({ name: fresh, branch: "Pondicherry", is_test: true });
    const groups = await admin.from("doc_group").select("id", { count: "exact", head: true }).eq("office_id", id);
    expect(groups.count).toBeGreaterThanOrEqual(10);
    const fys = await admin.from("financial_year").select("code").eq("office_id", id);
    expect((fys.data ?? []).map((f) => f.code)).toEqual(expect.arrayContaining(["2025-26", "2026-27"]));
    const formats = await admin.from("doc_type").select("name").eq("office_id", id).not("preferred_formats", "is", null);
    expect((formats.data ?? []).length).toBe(6); // 11's real-office seed, which offices created later never got
    const log = await admin.from("activity").select("action, actor_id, entity_type, entity_id, data")
      .eq("office_id", id).eq("action", "office.bootstrapped").order("id", { ascending: false }).limit(1).single();
    expect(log.data).toEqual({ action: "office.bootstrapped", actor_id: null, entity_type: "office", entity_id: id, data: { result: "reused" } });
  });

  it("refuses a firm that already has staff (AC-15)", async () => {
    const r = await boot({ name: staffed });
    expect(r.error?.message).toMatch(/^ALREADY_SET_UP/);
  });

  it("validates its input", async () => {
    expect((await boot({ name: "  " })).error?.message).toMatch(/NAME_INVALID/);
    expect((await boot({ name: "x".repeat(121) })).error?.message).toMatch(/NAME_INVALID/);
    expect((await boot({ name: fresh, branch: "y".repeat(121) })).error?.message).toMatch(/BRANCH_INVALID/);
    expect((await boot({ name: fresh, mode: "saas" })).error?.message).toMatch(/MODE_INVALID/);
  });

  it("is executable by the service role only (AC-18)", async () => {
    const r = await asAdmin.rpc("bootstrap_office", { p: { name: "hijack", mode: "multi", test: true } });
    expect(r.error).not.toBeNull();
    const { createClient } = await import("@supabase/supabase-js");
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
    expect((await anon.rpc("bootstrap_office", { p: { name: "hijack", mode: "multi", test: true } })).error).not.toBeNull();
  });
});
