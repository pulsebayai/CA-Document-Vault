import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { groupId, mustInsertClient } from "../support/catalogue";
import { createDocumentOffice, mustCreateDocument, periodId, typeId } from "../support/documents";
import { T, expectedItem, generateAsOf, planRow } from "../support/expected";

// Feature 04 — metric 1 (on-time %) on Settings › Collection (spec AC-16, "On time" definition).
// Written before the migration (plan step 1). Contract: tests/support/expected.ts.
//
// Fixture (Bank statement, monthly, asked +1/1, overdue from +1/7; clock 15 Jul 2026):
//   M1  Mar received 3 Apr (on time) · Apr received 7 May (late: on the overdue date) · May missing · Jun waived
//   M2  row paused after generation → on hold, excluded
//   M3  archived after generation → excluded

type Who = "admin" | "manager" | "staff" | "limited";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
const clients = {} as Record<"m1" | "m2" | "m3", string>;
type Metric = {
  due: number; on_time: number; late: number; missing: number; on_time_pct: number | null; overdue_now: number;
  last_generated_at: string | null; groups: Array<{ doc_group_id: string; name: string; due: number; on_time: number; late: number; missing: number }>;
};
const metric = async (who: SupabaseClient, from: string, to: string) => {
  const { data, error } = await who.rpc("collection_metric", { p_from: from, p_to: to });
  if (error) throw new Error(error.message);
  return data as Metric;
};
const bankDoc = async (client: string, period: string, receivedOn: string) =>
  mustCreateDocument(as.staff, {
    client_id: client, doc_type_id: await typeId(officeId, T.bank), period_id: await periodId(officeId, period), received_on: receivedOn,
  });

beforeAll(async () => {
  officeId = await createDocumentOffice("exp-metric");
  u.admin = await createStaff(officeId, "expm-admin", "admin");
  u.manager = await createStaff(officeId, "expm-manager", "manager");
  u.staff = await createStaff(officeId, "expm-staff", "staff");
  u.limited = await createStaff(officeId, "expm-limited", "limited");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  await generateAsOf(as.admin, "2026-03-15");
  const banking = await groupId(officeId, "Banking");
  for (const k of ["m1", "m2", "m3"] as const) {
    clients[k] = (await mustInsertClient(as.staff, officeId, { name: `Metric ${k}`, client_type: "individual", incharge_id: u.limited.id })).id;
    const { error } = await as.staff.rpc("enable_client_group", { p_client_id: clients[k], p_doc_group_id: banking });
    if (error) throw new Error(error.message);
    // Keep only the monthly Bank statement row, so the counts below are exact.
    for (const n of ["Loan statement / interest certificate", "Bank balance confirmation", "FD / interest certificates"]) {
      const row = await planRow(clients[k], n);
      const { error: e } = await as.staff.from("client_doc_type").update({ state: "removed" }).eq("id", row.id);
      if (e) throw e;
    }
  }
}, 120_000);

afterAll(async () => {
  await retireStaff([u.manager, u.staff, u.limited].filter(Boolean).map((x) => x.id));
  if (u.admin) await retireStaff([u.admin.id]);
});

describe("metric 1 — documents received on time (AC-16)", () => {
  it("before anything has fallen due there is no figure", async () => {
    const m = await metric(as.admin, "2026-02-15", "2026-03-15");
    expect(m).toMatchObject({ due: 0, on_time: 0, late: 0, missing: 0, on_time_pct: null, overdue_now: 0 });
  });

  it("counts on time (< overdue from), late (≥ overdue from) and missing; waived, on-hold and archived are excluded", async () => {
    await bankDoc(clients.m1, "2026-03", "2026-04-03");
    await bankDoc(clients.m1, "2026-04", "2026-05-07");
    await generateAsOf(as.admin, "2026-07-15");
    const jun = await expectedItem(clients.m1, T.bank, "2026-06");
    expect((await as.staff.rpc("waive_expected", { p_id: jun.id, p_reason: "Account dormant in June" })).error).toBeNull();
    const m2Row = await planRow(clients.m2, T.bank);
    expect((await as.manager.from("client_doc_type").update({ state: "paused" }).eq("id", m2Row.id)).error).toBeNull();
    expect((await as.manager.from("client").update({ archived_at: new Date().toISOString() }).eq("id", clients.m3)).error).toBeNull();

    const m = await metric(as.manager, "2026-04-01", "2026-07-15");
    expect(m).toMatchObject({ due: 3, on_time: 1, late: 1, missing: 1, overdue_now: 1 });
    expect(m.on_time_pct).toBeCloseTo(33.3, 1);
    expect(m.groups).toEqual([expect.objectContaining({ name: "Banking", due: 3, on_time: 1, late: 1, missing: 1 })]);
    expect(m.last_generated_at).not.toBeNull();
  });

  it("the window is by overdue-from date", async () => {
    const m = await metric(as.admin, "2026-05-01", "2026-07-15"); // Apr (7 May) and May (7 Jun)
    expect(m).toMatchObject({ due: 2, on_time: 0, late: 1, missing: 1, on_time_pct: 0 });
  });

  it("a missing document filed late moves from missing to late", async () => {
    await bankDoc(clients.m1, "2026-05", "2026-07-10");
    const m = await metric(as.admin, "2026-04-01", "2026-07-15");
    expect(m).toMatchObject({ due: 3, on_time: 1, late: 2, missing: 0, overdue_now: 0 });
  });

  it("is Admin/Manager only", async () => {
    for (const k of ["staff", "limited"] as const) {
      const { error } = await as[k].rpc("collection_metric", { p_from: "2026-04-01", p_to: "2026-07-15" });
      expect(error?.message ?? "").toMatch(/ROLE_REQUIRED/);
    }
  });
});
