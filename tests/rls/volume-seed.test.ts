import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, periodId, typeId } from "../support/documents";

// 09 volume test (chore, R1 gate): the test-only seeding helpers. Always runs (fast). The volume timings
// themselves are in volume.test.ts (VOLUME=1). The non-test-office refusal was proven in a rolled-back dry run
// on dev (2026-10-07): automated tests only ever run in is_test offices, so they can't reach a real one.

describe("test-only seeding helpers (09)", () => {
  const who = {} as Record<"admin" | "staff" | "limited", { id: string; email: string }>;
  const as = {} as Record<"admin" | "staff" | "limited", SupabaseClient>;
  let officeId: string;
  let doc: Record<string, unknown>;

  beforeAll(async () => {
    officeId = await createDocumentOffice("volume-seed");
    for (const r of ["admin", "staff", "limited"] as const) {
      who[r] = await createStaff(officeId, `vseed-${r}`, r);
      as[r] = await signedInClient(who[r].email);
    }
    const { data, error } = await as.staff.rpc("create_client", { p: { name: "Seed client", client_type: "individual", incharge_id: who.staff.id } });
    if (error) throw error;
    doc = { received_as: "hard_copy", channel: "courier", client_id: data.id,
      doc_type_id: await typeId(officeId, "Bank statement"), period_id: await periodId(officeId, "2026-06") };
  }, 120_000);

  afterAll(async () => { await retireStaff(Object.values(who).filter(Boolean).map((x) => x.id)); });

  it("an Admin files documents through create_document (DOC-IDs, activity rows)", async () => {
    const { data, error } = await as.admin.rpc("seed_test_documents", { p_docs: [doc, doc, doc] });
    expect(error).toBeNull();
    expect(data).toBe(3);
    const { data: rows } = await adminClient().from("document").select("doc_code").eq("office_id", officeId);
    expect(rows).toHaveLength(3);
    expect(new Set(rows!.map((r) => r.doc_code)).size).toBe(3);
    const { count } = await adminClient().from("activity").select("id", { count: "exact", head: true })
      .eq("office_id", officeId).eq("action", "document.added");
    expect(count).toBe(3);
  });

  it("an Admin copies existing activity rows, actor = the caller, dates in range", async () => {
    const from = "2025-10-01T00:00:00Z"; const to = "2026-10-01T00:00:00Z";
    const before = (await adminClient().from("activity").select("id", { count: "exact", head: true }).eq("office_id", officeId)).count!;
    const { data, error } = await as.admin.rpc("seed_test_activity", { p_count: 25, p_from: from, p_to: to });
    expect(error).toBeNull();
    expect(data).toBe(25);
    const { data: rows } = await adminClient().from("activity").select("actor_id, created_at")
      .eq("office_id", officeId).eq("actor_id", who.admin.id).lt("created_at", to).gte("created_at", from);
    expect(rows!.length).toBe(25);
    const after = (await adminClient().from("activity").select("id", { count: "exact", head: true }).eq("office_id", officeId)).count!;
    expect(after - before).toBe(25);
  });

  it("Staff and Limited are refused", async () => {
    for (const r of ["staff", "limited"] as const) {
      const d = await as[r].rpc("seed_test_documents", { p_docs: [doc] });
      expect(d.error?.message).toMatch(/^ROLE_REQUIRED/);
      const a = await as[r].rpc("seed_test_activity", { p_count: 1, p_from: "2026-01-01T00:00:00Z", p_to: "2026-02-01T00:00:00Z" });
      expect(a.error?.message).toMatch(/^ROLE_REQUIRED/);
    }
  });

  it("caps keep each call under the 8 s statement timeout", async () => {
    const d = await as.admin.rpc("seed_test_documents", { p_docs: Array.from({ length: 1001 }, () => doc) });
    expect(d.error?.message).toMatch(/^SEED_FORMAT/);
    const a = await as.admin.rpc("seed_test_activity", { p_count: 20001, p_from: "2026-01-01T00:00:00Z", p_to: "2026-02-01T00:00:00Z" });
    expect(a.error?.message).toMatch(/^SEED_FORMAT/);
  });
});
