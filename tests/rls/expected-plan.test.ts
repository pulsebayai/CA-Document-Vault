import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { DENIED, groupId, mustInsertClient } from "../support/catalogue";
import { createDocumentOffice, documentRow, mustCreateDocument, periodId, typeId } from "../support/documents";
import { testGstin, testPan } from "../support/test-data";
import { T, expectedActivity, expectedFor, expectedItem, expectedOf, generateAsOf, periodCode, planRow } from "../support/expected";

// Feature 04 — plan changes and staff actions on expected documents (spec AC-2, AC-3, AC-5, AC-9 … AC-12, AC-18).
// Written before the migration (plan step 1). Contract: tests/support/expected.ts.
// One test office; its test clock only moves forward, so the describes below run in order.

type Who = "admin" | "manager" | "staff" | "limited";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
let clientP: string; // Limited is incharge
let clientQ: string; // Staff is incharge — Limited cannot see it
const pan = testPan("P", 4201);
const g1 = testGstin(pan, "33", 1);
const g2 = testGstin(pan, "29", 2);
let g1Id: string;
let g2Id: string;
const QUARTERLY = "Exp quarterly";
const DENIED_OR_NOT_FOUND = new RegExp(`${DENIED.source}|NOT_FOUND`, "i");

const enable = async (client: string, group: string, who: SupabaseClient = as.staff) => {
  const { error } = await who.rpc("enable_client_group", { p_client_id: client, p_doc_group_id: await groupId(officeId, group) });
  if (error) throw new Error(error.message);
};
const setRow = async (who: SupabaseClient, client: string, typeName: string, patch: Record<string, unknown>) => {
  const row = await planRow(client, typeName);
  const { data, error } = await who.from("client_doc_type").update(patch).eq("id", row.id).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(`plan row not updated: ${typeName}`);
};
const setGroup = async (who: SupabaseClient, client: string, group: string, state: string) => {
  const { data, error } = await who.from("client_group").update({ state })
    .eq("client_id", client).eq("doc_group_id", await groupId(officeId, group)).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(`group not updated: ${group}`);
};
const startOf = async (client: string, typeName: string) => periodCode((await planRow(client, typeName)).start_period_id);
const file = async (client: string, typeName: string, period: string, receivedOn: string, registrationId: string | null = null) =>
  mustCreateDocument(as.staff, {
    client_id: client, doc_type_id: await typeId(officeId, typeName), period_id: await periodId(officeId, period),
    registration_id: registrationId, received_on: receivedOn,
  });
const regId = async (number: string) => {
  const { data } = await as.staff.from("client_registration").select("id").eq("client_id", clientP).eq("number", number).single();
  return data!.id as string;
};

beforeAll(async () => {
  officeId = await createDocumentOffice("exp-plan");
  u.admin = await createStaff(officeId, "expplan-admin", "admin");
  u.manager = await createStaff(officeId, "expplan-manager", "manager");
  u.staff = await createStaff(officeId, "expplan-staff", "staff");
  u.limited = await createStaff(officeId, "expplan-limited", "limited");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  await generateAsOf(as.admin, "2026-09-29");
  const { data, error } = await as.staff.rpc("create_client", { p: {
    name: "Plan P", client_type: "proprietorship", pan, incharge_id: u.limited.id, registrations: [{ kind: "gstin", number: g1 }],
  } });
  if (error) throw new Error(error.message);
  clientP = data.id;
  g1Id = await regId(g1);
  clientQ = (await mustInsertClient(as.staff, officeId, { name: "Plan Q", client_type: "individual", incharge_id: u.staff.id })).id;
}, 120_000);

afterAll(async () => {
  await retireStaff([u.manager, u.staff, u.limited].filter(Boolean).map((x) => x.id));
  if (u.admin) await retireStaff([u.admin.id]);
});

// ── Start period default (AC-3), clock 29 Sep 2026 ────────────────────────────
describe("start period = earliest still-open period (AC-3)", () => {
  it("enabling a group starts each row at its earliest still-open period, and nothing is asked yet", async () => {
    await enable(clientP, "GST");
    await enable(clientP, "Income Tax");
    await enable(clientQ, "Banking");
    expect(await startOf(clientP, T.sales)).toBe("2026-09"); // Aug overdue from 5 Sep (closed); Sep from 5 Oct
    expect(await startOf(clientP, T.form16)).toBe("2026-27"); // FY 2025-26 overdue from 10 Jun 2026 (closed)
    expect(await startOf(clientP, T.form16a)).toBe("2026-27-Q2"); // Q1 overdue from 20 Aug (closed)
    expect(await startOf(clientQ, T.bank)).toBe("2026-09");
    expect(await expectedFor(clientP)).toEqual([]); // Sep is asked on 1 Oct
    expect(await expectedFor(clientQ)).toEqual([]);
  });

  it("adding a type to a client uses the same default", async () => {
    const { data: t, error } = await as.admin.from("doc_type").insert({
      office_id: officeId, doc_group_id: await groupId(officeId, "Income Tax"), code: "exp_quarterly", name: QUARTERLY,
      period_kind: "quarter", default_frequency: "quarterly", source: "client",
      ask_after_months: 1, ask_day: 1, overdue_after_months: 1, overdue_day: 15,
    }).select("id").single();
    expect(error).toBeNull();
    expect((await as.staff.rpc("add_client_doc_type", { p_client_id: clientP, p_doc_type_id: t!.id })).error).toBeNull();
    expect(await startOf(clientP, QUARTERLY)).toBe("2026-27-Q2"); // Q1 overdue from 15 Jul (closed)
  });
});

// ── Plan changes take effect immediately (AC-2, AC-5), clock 1 Oct 2026 ─────────
describe("plan changes take effect immediately (AC-2)", () => {
  beforeAll(async () => { await generateAsOf(as.admin, "2026-10-01"); });

  it("the daily run creates the items asked today", async () => {
    expect((await expectedOf(clientP, T.sales)).map((r) => [r.period.code, r.registration_id])).toEqual([["2026-09", g1Id]]);
    expect((await expectedOf(clientP, QUARTERLY)).map((r) => r.period.code)).toEqual(["2026-27-Q2"]);
    expect((await expectedOf(clientQ, T.bank)).map((r) => r.period.code)).toEqual(["2026-09"]);
  });

  it("adding a GSTIN (Edit client) creates its items at once", async () => {
    const { error } = await as.staff.rpc("update_client", { p_client_id: clientP, p: {
      name: "Plan P", client_type: "proprietorship", pan, registrations: [{ kind: "gstin", number: g1 }, { kind: "gstin", number: g2 }],
    } });
    expect(error).toBeNull();
    g2Id = await regId(g2);
    expect((await expectedItem(clientP, T.sales, "2026-09", g2Id)).status).toBe("pending");
  });

  it("enabling a group creates items whose ask date has passed, without waiting for the job", async () => {
    await enable(clientP, "Banking");
    expect(await startOf(clientP, T.bank)).toBe("2026-09");
    expect((await expectedOf(clientP, T.bank)).map((r) => r.period.code)).toEqual(["2026-09"]);
  });

  it("moving the start period earlier creates the earlier items at once", async () => {
    await setRow(as.staff, clientP, T.bank, { start_period_id: await periodId(officeId, "2026-08") });
    expect((await expectedOf(clientP, T.bank)).map((r) => r.period.code)).toEqual(["2026-08", "2026-09"]);
  });

  it("editing a row's schedule recomputes its PENDING items only", async () => {
    await file(clientP, T.bank, "2026-08", "2026-09-05");
    expect((await expectedItem(clientP, T.bank, "2026-08")).status).toBe("received");
    await setRow(as.staff, clientP, T.bank, { overdue_day: 20 });
    expect(await expectedItem(clientP, T.bank, "2026-09")).toMatchObject({ ask_on: "2026-10-01", overdue_from: "2026-10-20" });
    expect(await expectedItem(clientP, T.bank, "2026-08")).toMatchObject({ ask_on: "2026-09-01", overdue_from: "2026-09-07" });
  });
});

// ── Staff actions (AC-9 … AC-11, AC-18), clock 1 Oct 2026 ─────────────────────
describe("waive, undo waive, reopen (AC-9 … AC-11)", () => {
  const REASON = "Client closed this account for September";

  it("Limited cannot waive, even on a client they can see", async () => {
    const item = await expectedItem(clientP, T.sales, "2026-09", g1Id);
    const { error } = await as.limited.rpc("waive_expected", { p_id: item.id, p_reason: "no" });
    expect(error?.message ?? "").toMatch(/ROLE_REQUIRED/);
  });

  it("a reason of 1–500 characters is required", async () => {
    const item = await expectedItem(clientQ, T.bank, "2026-09");
    for (const bad of ["", "   ", "x".repeat(501)]) {
      const { error } = await as.staff.rpc("waive_expected", { p_id: item.id, p_reason: bad });
      expect(error?.message ?? "").toMatch(/REASON/);
    }
    expect((await expectedItem(clientQ, T.bank, "2026-09")).status).toBe("pending");
  });

  it("Staff waives a pending item: status, reason, who and when are stored; activity has the code only", async () => {
    const item = await expectedItem(clientQ, T.bank, "2026-09");
    expect((await as.staff.rpc("waive_expected", { p_id: item.id, p_reason: REASON })).error).toBeNull();
    const after = await expectedItem(clientQ, T.bank, "2026-09");
    expect(after).toMatchObject({ status: "waived", waived_code: "manual", waived_reason: REASON, waived_by: u.staff.id });
    expect(after.waived_at).not.toBeNull();
    const act = await expectedActivity(officeId, item.id);
    expect(act.map((a) => a.action)).toEqual(["expected.waived"]);
    expect(act[0].actor_id).toBe(u.staff.id);
    expect(act[0].data).toMatchObject({ code: "manual" });
    expect(JSON.stringify(act[0].data)).not.toContain("September");
  });

  it("only pending items can be waived", async () => {
    const received = await expectedItem(clientP, T.bank, "2026-08");
    const { error } = await as.staff.rpc("waive_expected", { p_id: received.id, p_reason: "late" });
    expect(error?.message ?? "").toMatch(/NOT_PENDING/);
  });

  it("undo waive is Admin/Manager only and returns the item to pending", async () => {
    const item = await expectedItem(clientQ, T.bank, "2026-09");
    expect((await as.staff.rpc("undo_waive_expected", { p_id: item.id })).error?.message ?? "").toMatch(/ROLE_REQUIRED/);
    expect((await as.manager.rpc("undo_waive_expected", { p_id: item.id })).error).toBeNull();
    expect(await expectedItem(clientQ, T.bank, "2026-09")).toMatchObject({ status: "pending", waived_code: null, waived_reason: null, waived_by: null });
    expect((await expectedActivity(officeId, item.id)).map((a) => a.action)).toEqual(["expected.waived", "expected.waive_undone"]);
  });

  it("a document filed for a waived item is linked; undoing the waiver then makes it received", async () => {
    const item = await expectedItem(clientP, T.sales, "2026-09", g2Id);
    expect((await as.staff.rpc("waive_expected", { p_id: item.id, p_reason: "Not needed" })).error).toBeNull();
    const d = await file(clientP, T.sales, "2026-09", "2026-10-01", g2Id);
    expect((await documentRow(d.id)).expected_doc_id).toBe(item.id);
    expect((await expectedItem(clientP, T.sales, "2026-09", g2Id)).status).toBe("waived");
    expect((await as.admin.rpc("undo_waive_expected", { p_id: item.id })).error).toBeNull();
    expect(await expectedItem(clientP, T.sales, "2026-09", g2Id)).toMatchObject({ status: "received", received_on: "2026-10-01", completed_by_document_id: d.id });
  });

  it("anyone who can see the client can reopen a received item; its documents stay linked", async () => {
    const item = await expectedItem(clientP, T.bank, "2026-08");
    const first = item.completed_by_document_id!;
    expect((await as.limited.rpc("reopen_expected", { p_id: item.id })).error).toBeNull();
    const after = await expectedItem(clientP, T.bank, "2026-08");
    expect(after).toMatchObject({ status: "pending", received_on: null, completed_by_document_id: null });
    expect(after.reopened_at).not.toBeNull();
    expect((await documentRow(first)).expected_doc_id).toBe(item.id);
    const act = await expectedActivity(officeId, item.id);
    expect(act[act.length - 1]).toMatchObject({ action: "expected.reopened", actor_id: u.limited.id });
  });

  it("a newly linked document marks a reopened item received with that document's date", async () => {
    const d = await file(clientP, T.bank, "2026-08", "2026-10-01");
    expect(await expectedItem(clientP, T.bank, "2026-08")).toMatchObject({ status: "received", received_on: "2026-10-01", completed_by_document_id: d.id });
  });

  it("only received items can be reopened, and only on clients the user can see", async () => {
    const pending = await expectedItem(clientP, T.sales, "2026-09", g1Id);
    expect((await as.staff.rpc("reopen_expected", { p_id: pending.id })).error?.message ?? "").toMatch(/NOT_RECEIVED/);
    const hidden = await expectedItem(clientQ, T.bank, "2026-09");
    await file(clientQ, T.bank, "2026-09", "2026-10-01");
    expect((await as.limited.rpc("reopen_expected", { p_id: hidden.id })).error?.message ?? "").toMatch(DENIED_OR_NOT_FOUND);
    expect((await expectedItem(clientQ, T.bank, "2026-09")).status).toBe("received");
  });
});

// ── Plan-change effects (AC-12) ───────────────────────────────────────────────
describe("plan-change effects (AC-12)", () => {
  it("pausing a row keeps its pending items pending (shown On hold) and generates nothing while paused", async () => {
    await setRow(as.manager, clientP, T.bank, { state: "paused" });
    expect((await expectedItem(clientP, T.bank, "2026-09")).status).toBe("pending");
    await generateAsOf(as.admin, "2026-11-01");
    expect((await expectedOf(clientP, T.bank)).map((r) => r.period.code)).toEqual(["2026-08", "2026-09"]); // no Oct
    expect((await expectedOf(clientQ, T.bank)).map((r) => r.period.code)).toEqual(["2026-09", "2026-10"]); // Q is not paused
  });

  it("resuming continues from the earliest still-open period: periods asked while paused are never generated", async () => {
    await generateAsOf(as.admin, "2026-11-25"); // Oct overdue from 20 Nov — closed
    await setRow(as.manager, clientP, T.bank, { state: "active" });
    await generateAsOf(as.admin, "2026-12-01");
    expect((await expectedOf(clientP, T.bank)).map((r) => r.period.code)).toEqual(["2026-08", "2026-09", "2026-11"]);
  });

  it("deactivating a registration waives its pending items automatically", async () => {
    const before = await expectedOf(clientP, T.sales);
    const g2Pending = before.filter((r) => r.registration_id === g2Id && r.status === "pending");
    expect(g2Pending.length).toBeGreaterThan(0); // Oct, Nov
    const { error } = await as.staff.from("client_registration").update({ active: false }).eq("id", g2Id);
    expect(error).toBeNull();
    const after = await expectedOf(clientP, T.sales);
    for (const r of after.filter((x) => g2Pending.some((p) => p.id === x.id))) {
      expect(r).toMatchObject({ status: "waived", waived_code: "registration_inactive", waived_reason: "Registration inactive", waived_by: null });
    }
    expect((await expectedItem(clientP, T.sales, "2026-09", g2Id)).status).toBe("received"); // untouched
    expect(after.filter((r) => r.registration_id === g1Id).every((r) => r.status === "pending")).toBe(true);
  });

  it("removing a row waives its pending items; received items stay received", async () => {
    await file(clientP, QUARTERLY, "2026-27-Q2", "2026-10-01"); // was 2026-10-10: in the future until 10 Oct, rejected by 03's RECEIVED_ON_FUTURE (Raja 2026-10-01)
    await generateAsOf(as.admin, "2027-01-02"); // Q3 asked 1 Jan
    expect((await expectedItem(clientP, QUARTERLY, "2026-27-Q3")).status).toBe("pending");
    await setRow(as.staff, clientP, QUARTERLY, { state: "removed" });
    expect(await expectedItem(clientP, QUARTERLY, "2026-27-Q3")).toMatchObject({ status: "waived", waived_code: "removed_from_plan", waived_reason: "Removed from plan" });
    expect((await expectedItem(clientP, QUARTERLY, "2026-27-Q2")).status).toBe("received");
  });

  it("moving the start period later waives the pending items before it", async () => {
    expect((await expectedItem(clientP, T.form16a, "2026-27-Q2")).status).toBe("pending"); // asked 1 Nov
    await setRow(as.staff, clientP, T.form16a, { start_period_id: await periodId(officeId, "2026-27-Q3") });
    expect(await expectedItem(clientP, T.form16a, "2026-27-Q2")).toMatchObject({ status: "waived", waived_code: "before_start", waived_reason: "Before start period" });
  });

  it("pausing a group stops generation for all its rows, while their pending items stay pending", async () => {
    const pendingBefore = (await expectedOf(clientP, T.sales)).filter((r) => r.status === "pending").map((r) => r.id).sort();
    await setGroup(as.manager, clientP, "GST", "paused");
    await generateAsOf(as.admin, "2027-02-01"); // Jan 2027 asked 1 Feb
    const after = await expectedOf(clientP, T.sales);
    expect(after.some((r) => r.period.code === "2027-01")).toBe(false);
    expect(after.filter((r) => r.status === "pending").map((r) => r.id).sort()).toEqual(pendingBefore);
  });

  it("switching a group off waives the pending items of all its rows", async () => {
    const pending = (await expectedOf(clientP, T.bank)).filter((r) => r.status === "pending");
    expect(pending.length).toBeGreaterThan(0);
    const { error } = await as.staff.rpc("disable_client_group", { p_client_id: clientP, p_doc_group_id: await groupId(officeId, "Banking") });
    expect(error).toBeNull();
    const after = await expectedOf(clientP, T.bank);
    expect(after.filter((r) => pending.some((p) => p.id === r.id)).every((r) => r.status === "waived" && r.waived_code === "removed_from_plan")).toBe(true);
    expect((await expectedItem(clientP, T.bank, "2026-08")).status).toBe("received");
  });

  // R1 (Raja 2026-09-30, SQL review of step 2): switching a group (or row) back on restores its "Removed from plan"
  // items that are not overdue yet; items already overdue stay waived (the same line as resume, AC-12).
  it("switching a group back on restores its not-yet-overdue 'Removed from plan' items; overdue ones stay waived (R1)", async () => {
    // Clock 1 Feb 2027: Banking Jan 2027 (asked 1 Feb) is still open; Dec 2026 is already overdue.
    expect(await expectedItem(clientP, T.bank, "2027-01")).toMatchObject({ status: "waived", waived_code: "removed_from_plan" });
    expect(await expectedItem(clientP, T.bank, "2026-12")).toMatchObject({ status: "waived", waived_code: "removed_from_plan" });
    await enable(clientP, "Banking");
    const jan = await expectedItem(clientP, T.bank, "2027-01");
    expect(jan).toMatchObject({ status: "pending", waived_code: null, waived_reason: null, waived_by: null, waived_at: null });
    expect(await expectedItem(clientP, T.bank, "2026-12")).toMatchObject({ status: "waived", waived_code: "removed_from_plan" });
    const act = (await expectedActivity(officeId, jan.id)).map((a) => ({ action: a.action, actor_id: a.actor_id, data: a.data }));
    expect(act.slice(-2)).toMatchObject([
      { action: "expected.auto_waived", actor_id: null, data: { code: "removed_from_plan" } },
      { action: "expected.waive_undone", actor_id: null, data: { code: "removed_from_plan" } },
    ]);
  });

  it("every automatic waiver writes one system activity row with its code and no free text (AC-18)", async () => {
    const auto = (await expectedFor(clientP)).filter((r) => r.status === "waived" && r.waived_code !== "manual");
    const rows = (await expectedActivity(officeId)).filter((a) => a.action === "expected.auto_waived");
    for (const item of auto) {
      const mine = rows.filter((a) => a.entity_id === item.id);
      expect(mine.length).toBe(1);
      expect(mine[0].actor_id).toBeNull();
      expect(mine[0].data).toMatchObject({ code: item.waived_code });
      expect(JSON.stringify(mine[0].data)).not.toMatch(/Removed from plan|Registration inactive|Before start period/);
    }
  });
});
