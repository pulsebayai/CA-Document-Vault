import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { groupId, mustInsertClient } from "../support/catalogue";
import { createDocumentOffice } from "../support/documents";
import { T, expectedItem, generateAsOf } from "../support/expected";

// Feature 04 step 7 (D5) — Clients list: "N overdue · N due today" per client and the "Has overdue" filter
// (spec AC-15), from public.search_clients (SECURITY INVOKER: expected_doc RLS follows the client).
// Counts follow the screens' rules (shape.ts): pending, not On hold (row or group paused); overdue = today ≥
// overdue-from; due today = today is the day before overdue-from. "Today" = the office clock (test office: D1).
//
// Timeline (test clock): 2026-06-01 Banking enabled (start May 2026) → 2026-07-06 generation:
//   Bank statement (+1/1 · +1/7): May overdue from 7 Jun → Overdue · Jun overdue from 7 Jul → Due today.

type Row = { id: string; name: string; overdue: number; due_today: number; total: number };
let officeId: string;
const u = {} as Record<"admin" | "manager" | "staff" | "limited", { id: string; email: string }>;
const as = {} as Record<keyof typeof u, SupabaseClient>;
const ids = {} as Record<"late" | "onHold" | "none", string>;

async function search(c: SupabaseClient, args: Record<string, unknown> = {}): Promise<Row[]> {
  const { data, error } = await c.rpc("search_clients", args);
  if (error) throw new Error(error.message);
  return (data as Row[]).map((r) => ({ ...r, overdue: Number(r.overdue), due_today: Number(r.due_today), total: Number(r.total) }));
}
const counts = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.name, [r.overdue, r.due_today]]));

beforeAll(async () => {
  officeId = await createDocumentOffice("exp-clients");
  u.admin = await createStaff(officeId, "expcl-admin", "admin");
  u.manager = await createStaff(officeId, "expcl-manager", "manager");
  u.staff = await createStaff(officeId, "expcl-staff", "staff");
  u.limited = await createStaff(officeId, "expcl-limited", "limited");
  for (const k of Object.keys(u) as (keyof typeof u)[]) as[k] = await signedInClient(u[k].email);

  await generateAsOf(as.admin, "2026-06-01");
  ids.late = (await mustInsertClient(as.staff, officeId, { name: "Late Co", client_type: "individual", incharge_id: u.limited.id })).id;
  ids.onHold = (await mustInsertClient(as.staff, officeId, { name: "On Hold Co", client_type: "individual", incharge_id: u.staff.id })).id;
  ids.none = (await mustInsertClient(as.staff, officeId, { name: "Nothing Co", client_type: "individual", incharge_id: u.staff.id })).id;
  const banking = await groupId(officeId, "Banking");
  for (const c of [ids.late, ids.onHold]) {
    const { error } = await as.staff.rpc("enable_client_group", { p_client_id: c, p_doc_group_id: banking });
    if (error) throw new Error(error.message);
  }
  await generateAsOf(as.admin, "2026-07-06");
  // On hold after its items exist: they stay pending but don't count (AC-12).
  const { error: pe } = await as.manager.from("client_group").update({ state: "paused", remark: "books with auditor" })
    .eq("client_id", ids.onHold).eq("doc_group_id", banking);
  if (pe) throw pe;
});

afterAll(async () => { await retireStaff(Object.values(u).filter(Boolean).map((x) => x.id)); });

describe("search_clients — overdue counts and Has overdue (AC-15)", () => {
  it("counts overdue and due-today items per client; on-hold items and clients without items count 0", async () => {
    expect(counts(await search(as.staff))).toEqual({ "Late Co": [1, 1], "Nothing Co": [0, 0], "On Hold Co": [0, 0] });
  });

  it("p_has_overdue keeps only clients with an overdue item (total follows the filter)", async () => {
    const rows = await search(as.staff, { p_has_overdue: true });
    expect(rows.map((r) => r.name)).toEqual(["Late Co"]);
    expect(rows[0].total).toBe(1);
  });

  it("combines with the other filters; a Limited user gets counts only for clients they can see", async () => {
    expect((await search(as.staff, { p_has_overdue: true, p_incharge_id: u.staff.id }))).toEqual([]);
    expect(counts(await search(as.limited))).toEqual({ "Late Co": [1, 1] });
    expect((await search(as.limited, { p_has_overdue: true })).map((r) => r.name)).toEqual(["Late Co"]);
  });

  it("03b's call (p_query, p_limit, p_offset only) still works and gets the counts too", async () => {
    const rows = await search(as.staff, { p_query: "late", p_limit: 8, p_offset: 0 });
    expect(rows.map((r) => [r.name, r.overdue, r.due_today])).toEqual([["Late Co", 1, 1]]);
  });

  it("a waived item stops counting; the client leaves Has overdue", async () => {
    const item = await expectedItem(ids.late, T.bank, "2026-05");
    const { error } = await as.staff.rpc("waive_expected", { p_id: item.id, p_reason: "Account closed" });
    if (error) throw new Error(error.message);
    expect(counts(await search(as.staff))["Late Co"]).toEqual([0, 1]);
    expect(await search(as.staff, { p_has_overdue: true })).toEqual([]);
  });

  it("is not callable without signing in", async () => {
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
    const { error } = await anon.rpc("search_clients", { p_has_overdue: true });
    expect(error).not.toBeNull();
  });
});
