import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { DENIED, createCatalogueOffice, groupId } from "../support/catalogue";
import { testGstin, testPan, testTan } from "../support/test-data";

// Feature 02 — import_clients (spec AC-16, AC-17). The server validates rows first (unit-tested);
// the SQL function is the backstop: one transaction per call, ≤ 200 rows, same DB rules as a single insert.

type Row = {
  name: string; client_type: string; pan?: string | null; previous_reference?: string | null; email?: string | null;
  mobile?: string | null; incharge_id: string; registrations?: { kind: "gstin" | "tan"; number: string }[]; group_ids?: string[];
};

let officeId: string;
const u = {} as Record<"admin" | "staff" | "limited", { id: string; email: string }>;
const as = {} as Record<keyof typeof u, SupabaseClient>;

const clientCount = async () =>
  (await adminClient().from("client").select("id", { count: "exact", head: true }).eq("office_id", officeId)).count ?? 0;

beforeAll(async () => {
  officeId = await createCatalogueOffice("import");
  u.admin = await createStaff(officeId, "imp-admin", "admin");
  u.staff = await createStaff(officeId, "imp-staff", "staff");
  u.limited = await createStaff(officeId, "imp-limited", "limited");
  for (const k of Object.keys(u) as (keyof typeof u)[]) as[k] = await signedInClient(u[k].email);
});

afterAll(async () => {
  await retireStaff([u.staff, u.limited].filter(Boolean).map((x) => x.id));
  if (u.admin) await retireStaff([u.admin.id]);
});

describe("import_clients (AC-16)", () => {
  it("creates clients in file order with registrations, groups and their types", async () => {
    const gst = await groupId(officeId, "GST");
    const pan = testPan("F", 100);
    const rows: Row[] = [
      { name: "Import One", client_type: "partnership", pan, incharge_id: u.staff.id, previous_reference: "OLD-17",
        registrations: [{ kind: "gstin", number: testGstin(pan) }, { kind: "tan", number: testTan(100) }], group_ids: [gst] },
      { name: "Import Two", client_type: "individual", pan: testPan("P", 101), incharge_id: u.staff.id },
      { name: "Import Three", client_type: "huf", incharge_id: u.staff.id },
    ];
    const { data, error } = await as.staff.rpc("import_clients", { p_rows: rows });
    expect(error).toBeNull();
    const result = data as { row: number; client_id: string; code: string }[];
    expect(result.map((r) => r.row)).toEqual([1, 2, 3]);
    const nums = result.map((r) => Number(r.code.slice(1)));
    expect(nums).toEqual([nums[0], nums[0] + 1, nums[0] + 2]);
    const svc = adminClient();
    const { data: regs } = await svc.from("client_registration").select("kind, state_code").eq("client_id", result[0].client_id);
    expect(regs?.map((r) => r.kind).sort()).toEqual(["gstin", "tan"]);
    const { count } = await svc.from("client_doc_type").select("id", { count: "exact", head: true }).eq("client_id", result[0].client_id);
    expect(count).toBe(5); // GST client documents, no firm records
    const { data: act } = await svc.from("activity").select("action").eq("office_id", officeId).eq("action", "client.imported");
    expect(act?.length).toBeGreaterThan(0);
  });

  it("is all-or-nothing per call: one bad row (duplicate PAN) rolls back the whole chunk", async () => {
    const before = await clientCount();
    const rows: Row[] = [
      { name: "Chunk OK", client_type: "individual", pan: testPan("P", 102), incharge_id: u.staff.id },
      { name: "Chunk dup", client_type: "individual", pan: testPan("P", 101), incharge_id: u.staff.id }, // exists from test 1
    ];
    const { error } = await as.staff.rpc("import_clients", { p_rows: rows });
    expect(error?.message ?? "").toMatch(/duplicate key|DUPLICATE_PAN/);
    expect(await clientCount()).toBe(before);
  });

  it("applies the same DB rules as a single insert (GSTIN must match PAN)", async () => {
    const pan = testPan("C", 103);
    const { error } = await as.staff.rpc("import_clients", { p_rows: [
      { name: "Bad GSTIN", client_type: "private_ltd", pan, incharge_id: u.staff.id, registrations: [{ kind: "gstin", number: testGstin(testPan("C", 104)) }] },
    ] });
    expect(error?.message ?? "").toMatch(/GSTIN_PAN|violates/);
  });

  it("rejects more than 200 rows per call", async () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({ name: `Too many ${i}`, client_type: "individual", incharge_id: u.staff.id }));
    const { error } = await as.staff.rpc("import_clients", { p_rows: rows });
    expect(error?.message ?? "").toMatch(/IMPORT_TOO_MANY/);
  });

  it("limited users cannot import", async () => {
    const { error } = await as.limited.rpc("import_clients", { p_rows: [{ name: "By limited", client_type: "individual", incharge_id: u.limited.id }] });
    expect(error?.message ?? "").toMatch(DENIED);
  });
});

// AC-17: nightly only (RUN_SLOW=1 in regression.yml) — 1,000 rows in 5 chunks of 200 in < 60 s.
describe.skipIf(!process.env.RUN_SLOW)("import timing (AC-17, nightly)", () => {
  it("imports 1,000 synthetic clients in under 60 seconds", async () => {
    const gst = await groupId(officeId, "GST");
    const rows: Row[] = Array.from({ length: 1000 }, (_, i) => {
      const pan = testPan("P", 2000 + i);
      return { name: `Bulk client ${i + 1}`, client_type: "individual", pan, incharge_id: u.staff.id,
        registrations: [{ kind: "gstin", number: testGstin(pan) }], group_ids: [gst] };
    });
    const t0 = Date.now();
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await as.staff.rpc("import_clients", { p_rows: rows.slice(i, i + 200) });
      expect(error).toBeNull();
    }
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 120_000);
});
