import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { groupId, mustInsertClient } from "../support/catalogue";
import { createDocumentOffice } from "../support/documents";
import { testGstin, testPan } from "../support/test-data";
import { T, expectedActivity, expectedOf, generateAsOf, planRow } from "../support/expected";

// Feature 04 — pre-PR review follow-ups (sdlc-reviewer 2026-10-01):
//   Important 1: changing a plan row's frequency left its pending items open forever (e.g. monthly → as needed).
//     → pending items whose period kind no longer matches the frequency (all of them for "as needed") are waived
//       with a new system code `schedule_changed` ("Schedule changed"); changing back restores not-yet-overdue ones.
//   Nit 1: system waivers whose cause goes away come back like R1's "removed" rule: a re-activated GSTIN/TAN restores
//     its `registration_inactive` items, moving the start period earlier restores `before_start` items — only items
//     whose overdue-from date is still ahead (overdue ones stay waived, the same line as R1 and resume).
//
// Test clock 2026-07-03 (groups enabled 2026-06-01 → monthly start May 2026):
//   Bank statement (+1/1 · +1/7): May overdue from 7 Jun (past) · Jun overdue from 7 Jul (still ahead).
//   Sales invoices (+1/1 · +1/5, per GSTIN): May overdue from 5 Jun (past) · Jun overdue from 5 Jul (still ahead).

let officeId: string;
const u = {} as Record<"admin" | "staff", { id: string; email: string }>;
const as = {} as Record<keyof typeof u, SupabaseClient>;
const ids = {} as Record<"freq" | "reg" | "start", string>;
let gstinId: string;

const state = async (client: string, type: string) =>
  (await expectedOf(client, type)).map((e) => [e.period.code, e.status, e.waived_code ?? ""]);
const period = async (code: string) => {
  const { data, error } = await adminClient().from("period").select("id").eq("office_id", officeId).eq("code", code).single();
  if (error) throw error;
  return data.id as string;
};
const updateRow = async (client: string, type: string, patch: Record<string, unknown>) => {
  const row = await planRow(client, type);
  const { data, error } = await as.staff.from("client_doc_type").update(patch).eq("id", row.id).select("id");
  if (error) throw new Error(error.message);
  expect(data).toHaveLength(1);
};

beforeAll(async () => {
  officeId = await createDocumentOffice("exp-followups");
  u.admin = await createStaff(officeId, "expf-admin", "admin");
  u.staff = await createStaff(officeId, "expf-staff", "staff");
  for (const k of Object.keys(u) as (keyof typeof u)[]) as[k] = await signedInClient(u[k].email);
  await generateAsOf(as.admin, "2026-06-01");
  const pan = testPan("P", 7601);
  ids.freq = (await mustInsertClient(as.staff, officeId, { name: "Freq Co", client_type: "individual", incharge_id: u.staff.id })).id;
  ids.reg = (await mustInsertClient(as.staff, officeId, { name: "Reg Co", client_type: "proprietorship", incharge_id: u.staff.id, pan })).id;
  ids.start = (await mustInsertClient(as.staff, officeId, { name: "Start Co", client_type: "individual", incharge_id: u.staff.id })).id;
  const { data: g, error: ge } = await as.staff.from("client_registration")
    .insert({ office_id: officeId, client_id: ids.reg, kind: "gstin", number: testGstin(pan, "33") }).select("id").single();
  if (ge) throw ge;
  gstinId = g.id;
  const enable = async (client: string, group: string) => {
    const { error } = await as.staff.rpc("enable_client_group", { p_client_id: client, p_doc_group_id: await groupId(officeId, group) });
    if (error) throw new Error(error.message);
  };
  await enable(ids.freq, "Banking");
  await enable(ids.reg, "GST");
  await enable(ids.start, "Banking");
  await generateAsOf(as.admin, "2026-07-03");
});
afterAll(async () => { await retireStaff(Object.values(u).filter(Boolean).map((x) => x.id)); });

describe("frequency change (review Important 1)", () => {
  it("starts with May (overdue) and Jun (not yet) pending", async () => {
    expect(await state(ids.freq, T.bank)).toEqual([["2026-05", "pending", ""], ["2026-06", "pending", ""]]);
  });

  it("monthly → quarterly: month items are waived 'Schedule changed'; the quarter item is generated", async () => {
    await updateRow(ids.freq, T.bank, { frequency: "quarterly", start_period_id: await period("2026-27-Q1") });
    expect(await state(ids.freq, T.bank)).toEqual([
      ["2026-05", "waived", "schedule_changed"], ["2026-06", "waived", "schedule_changed"], ["2026-27-Q1", "pending", ""],
    ]);
    const jun = (await expectedOf(ids.freq, T.bank)).find((e) => e.period.code === "2026-06")!;
    expect(jun).toMatchObject({ waived_reason: "Schedule changed", waived_by: null });
    const log = await expectedActivity(officeId, jun.id);
    expect(log.map((l) => [l.action, l.data.code, l.actor_id])).toEqual([["expected.auto_waived", "schedule_changed", null]]);
  });

  it("back to monthly: the not-yet-overdue month comes back; the overdue one and the quarter item stay waived", async () => {
    await updateRow(ids.freq, T.bank, { frequency: "monthly", start_period_id: await period("2026-05") });
    expect(await state(ids.freq, T.bank)).toEqual([
      ["2026-05", "waived", "schedule_changed"], ["2026-06", "pending", ""], ["2026-27-Q1", "waived", "schedule_changed"],
    ]);
  });

  it("monthly → as needed: every pending item is waived and nothing new is expected", async () => {
    await updateRow(ids.freq, T.bank, {
      frequency: "as_needed", start_period_id: null, ask_after_months: null, ask_day: null, overdue_after_months: null, overdue_day: null,
    });
    const rows = await state(ids.freq, T.bank);
    expect(rows.filter(([, s]) => s === "pending")).toEqual([]);
    expect(rows).toContainEqual(["2026-06", "waived", "schedule_changed"]);
  });
});

describe("system waivers come back when their cause goes away (review Nit 1)", () => {
  it("a re-activated GSTIN restores its not-yet-overdue items; overdue ones stay waived", async () => {
    await as.staff.from("client_registration").update({ active: false }).eq("id", gstinId);
    expect(await state(ids.reg, T.sales)).toEqual([["2026-05", "waived", "registration_inactive"], ["2026-06", "waived", "registration_inactive"]]);
    await as.staff.from("client_registration").update({ active: true }).eq("id", gstinId);
    expect(await state(ids.reg, T.sales)).toEqual([["2026-05", "waived", "registration_inactive"], ["2026-06", "pending", ""]]);
  });

  it("moving the start period earlier again restores 'Before start period' items still ahead", async () => {
    await updateRow(ids.start, T.bank, { start_period_id: await period("2026-07") });
    expect(await state(ids.start, T.bank)).toEqual([["2026-05", "waived", "before_start"], ["2026-06", "waived", "before_start"]]);
    await updateRow(ids.start, T.bank, { start_period_id: await period("2026-05") });
    expect(await state(ids.start, T.bank)).toEqual([["2026-05", "waived", "before_start"], ["2026-06", "pending", ""]]);
    const jun = (await expectedOf(ids.start, T.bank)).find((e) => e.period.code === "2026-06")!;
    const log = await expectedActivity(officeId, jun.id);
    expect(log.map((l) => [l.action, l.data.code])).toEqual([["expected.auto_waived", "before_start"], ["expected.waive_undone", "before_start"]]);
  });
});
