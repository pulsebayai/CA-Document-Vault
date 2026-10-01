import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { DENIED, createCatalogueOffice, groupId, masterTypes, mustInsertClient } from "../support/catalogue";
import { currentPeriodCodes } from "../support/test-data";

// Feature 02 — client collection plan (spec AC-4, AC-19 … AC-21, AC-23). Written before the migration.

let officeId: string;
let gst: string;
const u = {} as Record<"admin" | "manager" | "staff" | "limited", { id: string; email: string }>;
const as = {} as Record<keyof typeof u, SupabaseClient>;
let clientId: string;
let groupRow: string;

const planTypes = async () => {
  const { data, error } = await adminClient().from("client_doc_type")
    .select("id, doc_type_id, frequency, ask_after_months, ask_day, overdue_after_months, overdue_day, reminders, state, assigned_staff_id, start_period_id, doc_type:doc_type_id(name, source)")
    .eq("client_id", clientId);
  if (error) throw error;
  return data as unknown as Array<{
    id: string; doc_type_id: string; frequency: string; ask_after_months: number | null; ask_day: number | null;
    overdue_after_months: number | null; overdue_day: number | null; reminders: boolean; state: string;
    assigned_staff_id: string | null; start_period_id: string | null; doc_type: { name: string; source: string };
  }>;
};
const byName = async (name: string) => (await planTypes()).find((t) => t.doc_type.name === name)!;

beforeAll(async () => {
  officeId = await createCatalogueOffice("plan");
  u.admin = await createStaff(officeId, "plan-admin", "admin");
  u.manager = await createStaff(officeId, "plan-manager", "manager");
  u.staff = await createStaff(officeId, "plan-staff", "staff");
  u.limited = await createStaff(officeId, "plan-limited", "limited");
  for (const k of Object.keys(u) as (keyof typeof u)[]) as[k] = await signedInClient(u[k].email);
  gst = await groupId(officeId, "GST");
  clientId = (await mustInsertClient(as.staff, officeId, { name: "Plan client", client_type: "proprietorship", incharge_id: u.staff.id })).id;
  // A deactivated master type must not be copied.
  await as.admin.from("doc_type").update({ active: false }).eq("doc_group_id", gst).eq("name", "E-way bills");
});

afterAll(async () => {
  await retireStaff([u.manager, u.staff, u.limited].filter(Boolean).map((x) => x.id));
  if (u.admin) await retireStaff([u.admin.id]);
});

describe("enable a group (AC-19)", () => {
  it("limited users cannot enable groups", async () => {
    const { error } = await as.limited.rpc("enable_client_group", { p_client_id: clientId, p_doc_group_id: gst });
    expect(error?.message ?? "").toMatch(DENIED);
  });

  it("copies every active client-source master type — never firm records or inactive types", async () => {
    const { data, error } = await as.staff.rpc("enable_client_group", { p_client_id: clientId, p_doc_group_id: gst });
    expect(error).toBeNull();
    groupRow = data as string;
    const masters = await masterTypes(officeId, "GST");
    const expected = masters.filter((m) => m.source === "client" && m.active).map((m) => m.name).sort();
    expect(expected.length).toBe(4); // 5 seeded client docs minus deactivated E-way bills
    const plan = await planTypes();
    expect(plan.map((p) => p.doc_type.name).sort()).toEqual(expected);
    expect(plan.some((p) => p.doc_type.source === "firm")).toBe(false);
    expect(plan.every((p) => p.state === "active" && p.assigned_staff_id === null)).toBe(true);
  });

  // Start period rule changed by 04 AC-3 (Raja 2026-09-30): the earliest period whose overdue-from date is
  // still ahead (Sales: 5th of the next month) — the previous month on the 1st–4th, otherwise the current one.
  it("copies the master's frequency, offsets and reminders, and starts at the earliest still-open period (04 AC-3)", async () => {
    const sales = await byName("Sales invoices / sales register");
    expect(sales).toMatchObject({ frequency: "monthly", ask_after_months: 1, ask_day: 1, overdue_after_months: 1, overdue_day: 5, reminders: true });
    const { data: period } = await adminClient().from("period").select("code").eq("id", sales.start_period_id!).single();
    const { data: months } = await adminClient().from("period").select("code, end_date")
      .eq("office_id", officeId).eq("kind", "month").order("start_date");
    const todayIst = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const overdueFrom = (end: string) => { // 5th of the month after the period's end
      const [y, m] = end.split("-").map(Number);
      return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-05`;
    };
    const open = (months ?? []).find((p) => overdueFrom(p.end_date as string) > todayIst);
    expect(period?.code).toBe(open?.code ?? currentPeriodCodes().month);
    const notice = await byName("GST notice / order received");
    expect(notice.frequency).toBe("as_needed");
    expect(notice.start_period_id).toBeNull();
  });

  it("assigns the group to the client's incharge by default", async () => {
    const { data } = await adminClient().from("client_group").select("assigned_staff_id, state").eq("id", groupRow).single();
    expect(data).toEqual({ assigned_staff_id: u.staff.id, state: "active" });
  });

  it("enabling again is a no-op (same group row, no duplicate types)", async () => {
    const before = (await planTypes()).length;
    const { data } = await as.staff.rpc("enable_client_group", { p_client_id: clientId, p_doc_group_id: gst });
    expect(data).toBe(groupRow);
    expect((await planTypes()).length).toBe(before);
  });

  it("writes an activity row inside the same transaction", async () => {
    const { data } = await adminClient().from("activity").select("action, entity_id, actor_id")
      .eq("office_id", officeId).eq("entity_id", groupRow).eq("action", "client_group.enabled");
    expect(data?.[0]?.actor_id).toBe(u.staff.id);
  });
});

describe("master changes don't touch client copies (AC-4)", () => {
  it("editing a master schedule leaves the client's schedule unchanged", async () => {
    await as.admin.from("doc_type").update({ overdue_day: 9, reminders: false }).eq("doc_group_id", gst).eq("name", "Sales invoices / sales register");
    const sales = await byName("Sales invoices / sales register");
    expect([sales.overdue_day, sales.reminders]).toEqual([5, true]);
  });
});

describe("per-type and per-group edits (AC-20)", () => {
  it("staff can change frequency and reminders, remove and restore a type", async () => {
    const t = await byName("Credit / debit notes issued and received");
    const r1 = await as.staff.from("client_doc_type").update({ frequency: "quarterly", reminders: false }).eq("id", t.id).select("id");
    expect(r1.data?.length).toBe(1);
    const r2 = await as.staff.from("client_doc_type").update({ state: "removed", remark: "not applicable" }).eq("id", t.id).select("id");
    expect(r2.data?.length).toBe(1);
    const r3 = await as.staff.from("client_doc_type").update({ state: "active" }).eq("id", t.id).select("id");
    expect(r3.data?.length).toBe(1);
  });

  it("pause/resume is Admin/Manager only, for types and groups", async () => {
    const t = await byName("Purchase invoices / purchase register");
    const s1 = await as.staff.from("client_doc_type").update({ state: "paused", remark: "on hold" }).eq("id", t.id);
    expect(s1.error?.message ?? "").toMatch(/ROLE_REQUIRED/);
    const m1 = await as.manager.from("client_doc_type").update({ state: "paused", remark: "on hold" }).eq("id", t.id).select("paused_at").single();
    expect(m1.data?.paused_at).not.toBeNull();
    const s2 = await as.staff.from("client_doc_type").update({ state: "active" }).eq("id", t.id);
    expect(s2.error?.message ?? "").toMatch(/ROLE_REQUIRED/); // resuming is also Admin/Manager
    const g1 = await as.staff.from("client_group").update({ state: "paused", remark: "client travelling" }).eq("id", groupRow);
    expect(g1.error?.message ?? "").toMatch(/ROLE_REQUIRED/);
  });

  it("assigning staff (group or type) is Admin/Manager only — it controls what Limited users can see", async () => {
    const t = await byName("Sales invoices / sales register");
    const s1 = await as.staff.from("client_group").update({ assigned_staff_id: u.limited.id }).eq("id", groupRow);
    expect(s1.error?.message ?? "").toMatch(/ROLE_REQUIRED/);
    const s2 = await as.staff.from("client_doc_type").update({ assigned_staff_id: u.limited.id }).eq("id", t.id);
    expect(s2.error?.message ?? "").toMatch(/ROLE_REQUIRED/);
    const m = await as.manager.from("client_doc_type").update({ assigned_staff_id: u.manager.id }).eq("id", t.id).select("id");
    expect(m.data?.length).toBe(1);
  });

  it("+ Add type adds an active client-source master type with its defaults; firm records are refused", async () => {
    const { data: fresh } = await as.admin.from("doc_type").insert({
      office_id: officeId, doc_group_id: gst, code: "x_new_gst", name: "GST annual turnover summary", period_kind: "year",
      default_frequency: "yearly", source: "client", ask_after_months: 1, ask_day: 1, overdue_after_months: 2, overdue_day: 15, reminders: true,
    }).select("id").single();
    const { error } = await as.staff.rpc("add_client_doc_type", { p_client_id: clientId, p_doc_type_id: fresh!.id });
    expect(error).toBeNull();
    expect((await byName("GST annual turnover summary")).overdue_day).toBe(15);
    const firm = (await masterTypes(officeId, "GST")).find((m) => m.source === "firm")!;
    const bad = await as.staff.rpc("add_client_doc_type", { p_client_id: clientId, p_doc_type_id: firm.id });
    expect(bad.error?.message ?? "").toMatch(/FIRM_RECORD/);
  });
});

describe("disable and re-enable (AC-21)", () => {
  it("disabling sets the group and its types to removed, keeping the rows", async () => {
    const before = await planTypes();
    await as.staff.from("client_doc_type").update({ state: "removed" }).eq("id", (await byName("Credit / debit notes issued and received")).id);
    const { error } = await as.staff.rpc("disable_client_group", { p_client_id: clientId, p_doc_group_id: gst });
    expect(error).toBeNull();
    const after = await planTypes();
    expect(after.length).toBe(before.length);
    expect(after.every((t) => t.state === "removed")).toBe(true);
    const { data } = await adminClient().from("client_group").select("state").eq("id", groupRow).single();
    expect(data?.state).toBe("removed");
  });

  it("re-enabling restores each type's previous state, adds new master types, and creates no duplicates", async () => {
    const n = (await planTypes()).length;
    await as.admin.from("doc_type").insert({
      office_id: officeId, doc_group_id: gst, code: "x_newer_gst", name: "GST e-invoice register", period_kind: "month",
      default_frequency: "monthly", source: "client", ask_after_months: 1, ask_day: 1, overdue_after_months: 1, overdue_day: 7, reminders: true,
    });
    const { data } = await as.staff.rpc("enable_client_group", { p_client_id: clientId, p_doc_group_id: gst });
    expect(data).toBe(groupRow);
    const plan = await planTypes();
    expect(plan.length).toBe(n + 1);
    const state = (name: string) => plan.find((t) => t.doc_type.name === name)?.state;
    expect(state("Sales invoices / sales register")).toBe("active");
    expect(state("Credit / debit notes issued and received")).toBe("removed"); // removed by staff before disable
    expect(state("Purchase invoices / purchase register")).toBe("paused"); // paused by manager before disable
    expect(state("GST e-invoice register")).toBe("active");
  });
});
