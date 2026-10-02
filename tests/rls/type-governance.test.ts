import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import {
  approveType, createCatalogueOffice, groupId, mergeType, mustInsertClient, mustOk, notificationsOf, previewDecision,
  proposalQueue, proposeType, rejectType, typeRow, type Queue,
} from "../support/catalogue";
import {
  activityFor, createDocument, createDocumentOffice, createSoftCopy, documentRow, liveDispatchItem, mustCreateDocument,
  mustCreateOriginal, mustDispatch, mustReview, periodId, reviewHistory, typeId,
} from "../support/documents";
import { T, expectedFor, generateAsOf } from "../support/expected";

// Feature 05 — type governance: queue, approve, edit & approve, merge, reject, roles, decided once, comments,
// activity, notifications, suggestions/search and metric 3 (spec AC-1 … AC-16). Written before the migrations
// (plan step 1). Contract: tests/support/catalogue.ts ("Feature 05"). AC-17's 1,000-document merge is in
// type-governance-perf.test.ts (RUN_SLOW).
//
// The office clock is set to 2026-07-01 before any plan exists (04's test clock), so the earliest still-open
// monthly period is June 2026 and June's expected items exist (ask 1 July).
// Clients: A (Limited is incharge; Payroll enabled) · B, C, D (Staff is incharge).

type Who = "admin" | "manager" | "staff" | "staff2" | "limited" | "outsider";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
let clientA: string;
let clientB: string;
let clientC: string;
let clientD: string;
const g = {} as Record<"payroll" | "banking" | "other" | "accounting" | "roc" | "tds", string>;
const t = {} as Record<"salary" | "bank" | "balanceConf" | "gstReturns" | "salaryTds", string>;
const p = {} as Record<"may" | "jun" | "fy", string>;
const SALARY = "Salary register / attendance"; // Payroll, month, monthly, +1/1 · +1/3
const ROLE = /ROLE_REQUIRED/;

let seq = 0;
/** A unique name per call, so items never collide across tests or runs (the office is reset each run anyway). */
const uniq = (base: string) => `${base} ${++seq}`;
const file = (who: Who, client: string, type: string, extra: Record<string, unknown> = {}) =>
  mustCreateDocument(as[who], { client_id: client, doc_type_id: type, period_id: p.jun, ...extra });

const planOf = async (client: string) => {
  const { data, error } = await adminClient().from("client_doc_type")
    .select("id, doc_type_id, state, frequency, ask_after_months, ask_day, overdue_after_months, overdue_day, reminders, start_period_id, client_group:client_group_id(doc_group_id, state)")
    .eq("client_id", client);
  if (error) throw error;
  return data as unknown as Array<{
    id: string; doc_type_id: string; state: string; frequency: string; ask_after_months: number | null; ask_day: number | null;
    overdue_after_months: number | null; overdue_day: number | null; reminders: boolean; start_period_id: string | null;
    client_group: { doc_group_id: string; state: string };
  }>;
};
const planRowOf = async (client: string, type: string) => (await planOf(client)).find((r) => r.doc_type_id === type);
const itemsOf = async (client: string, type: string) => (await expectedFor(client)).filter((e) => e.doc_type_id === type);
const queueOf = async (who: Who) => mustOk<Queue>(proposalQueue(as[who]));
const docsUnder = async (type: string) => {
  const { data, error } = await adminClient().from("document").select("id").eq("doc_type_id", type);
  if (error) throw error;
  return data!.map((r) => r.id as string);
};
const actionsIn = async (action: string) => {
  const { data, error } = await adminClient().from("activity").select("action, actor_id, entity_type, entity_id, data")
    .eq("office_id", officeId).eq("action", action).order("id");
  if (error) throw error;
  return data as Array<{ action: string; actor_id: string; entity_type: string; entity_id: string; data: Record<string, unknown> }>;
};

beforeAll(async () => {
  officeId = await createDocumentOffice("governance");
  const otherOffice = await createCatalogueOffice("governance-other");
  u.admin = await createStaff(officeId, "gov-admin", "admin");
  u.manager = await createStaff(officeId, "gov-manager", "manager");
  u.staff = await createStaff(officeId, "gov-staff", "staff");
  u.staff2 = await createStaff(officeId, "gov-staff2", "staff");
  u.limited = await createStaff(officeId, "gov-limited", "limited");
  u.outsider = await createStaff(otherOffice, "gov-outsider", "admin");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  await generateAsOf(as.admin, "2026-07-01"); // clock first (04 pattern)
  g.payroll = await groupId(officeId, "Payroll");
  g.banking = await groupId(officeId, "Banking");
  g.other = await groupId(officeId, "Other");
  g.accounting = await groupId(officeId, "Accounting");
  g.roc = await groupId(officeId, "ROC/MCA");
  g.tds = await groupId(officeId, "TDS/TCS");
  t.salary = await typeId(officeId, SALARY);
  t.bank = await typeId(officeId, T.bank);
  t.balanceConf = await typeId(officeId, "Bank balance confirmation"); // yearly
  t.gstReturns = await typeId(officeId, T.gstReturns); // firm record
  t.salaryTds = await typeId(officeId, T.salaryTds); // alias "Payroll for TDS"
  p.may = await periodId(officeId, "2026-05");
  p.jun = await periodId(officeId, "2026-06");
  p.fy = await periodId(officeId, "2026-27");
  clientA = (await mustInsertClient(as.staff, officeId, { name: "Governance A", client_type: "individual", incharge_id: u.limited.id })).id;
  clientB = (await mustInsertClient(as.staff, officeId, { name: "Governance B", client_type: "individual", incharge_id: u.staff.id })).id;
  clientC = (await mustInsertClient(as.staff, officeId, { name: "Governance C", client_type: "individual", incharge_id: u.staff.id })).id;
  clientD = (await mustInsertClient(as.staff, officeId, { name: "Governance D", client_type: "individual", incharge_id: u.staff.id })).id;
  const { error } = await as.staff.rpc("enable_client_group", { p_client_id: clientA, p_doc_group_id: g.payroll });
  if (error) throw error;
}, 180_000);

afterAll(async () => {
  await retireStaff([u.manager, u.staff, u.staff2, u.limited].filter(Boolean).map((x) => x.id));
  await retireStaff([u.admin, u.outsider].filter(Boolean).map((x) => x.id));
});

// ── Queue (AC-1) ───────────────────────────────────────────────────────────────
describe("queue: one item per group + name (AC-1)", () => {
  let first: string;
  let second: string;
  let otherGroup: string;
  const name = uniq("Wage slips");

  beforeAll(async () => {
    first = await proposeType(as.staff, clientA, g.payroll, name);
    second = await proposeType(as.staff2, clientB, g.payroll, `  ${name.toUpperCase()}  `); // case and spaces ignored
    otherGroup = await proposeType(as.staff, clientC, g.other, name); // another group → another item
    await file("staff", clientA, first);
    await file("staff", clientA, first, { period_id: p.may });
    await file("staff2", clientB, second);
  });

  it("groups the rows by group + name, with proposers, earliest date, clients and documents", async () => {
    for (const who of ["admin", "manager"] as const) {
      const q = await queueOf(who);
      const item = q.items.find((i) => i.type_ids.includes(first))!;
      expect(item).toBeDefined();
      expect(item.type_id).toBe(first); // the survivor = earliest row
      expect([...item.type_ids].sort()).toEqual([first, second].sort());
      expect(item).toMatchObject({ doc_group_id: g.payroll, group_name: "Payroll", client_count: 2, document_count: 3 });
      expect([...item.proposed_by].sort()).toEqual([u.staff.id, u.staff2.id].sort());
      expect(item.proposed_at).toBe((await typeRow(first)).created_at);
      expect(item.clients.map((c) => c.id).sort()).toEqual([clientA, clientB].sort());
      expect(q.items.find((i) => i.type_ids.includes(otherGroup))!.type_ids).toEqual([otherGroup]);
    }
  });

  it("is oldest first and counts the waiting items", async () => {
    const q = await queueOf("admin");
    const dates = q.items.map((i) => i.proposed_at);
    expect(dates).toEqual([...dates].sort());
    expect(q.waiting).toBe(q.items.length);
  });

  it("Staff and Limited can't read the queue", async () => {
    for (const who of ["staff", "limited"] as const) {
      expect((await proposalQueue(as[who])).error?.message ?? "").toMatch(ROLE);
    }
  });
});

// ── Approve (AC-2) ─────────────────────────────────────────────────────────────
describe("approve (AC-2)", () => {
  const name = uniq("Courier receipts");
  let rowA: string;
  let rowB: string;
  let docB: string;

  beforeAll(async () => {
    rowA = await proposeType(as.staff, clientA, g.other, name);
    rowB = await proposeType(as.staff2, clientB, g.other, name);
    docB = (await file("staff2", clientB, rowB)).id;
  });

  it("approves the earliest row, given any row of the item, and records who decided", async () => {
    const { type_id } = await mustOk(approveType(as.manager, { type_id: rowB }));
    expect(type_id).toBe(rowA);
    const a = await typeRow(rowA);
    expect(a).toMatchObject({ status: "approved", active: true, proposed_for_client_id: null, proposed_by: u.staff.id, decided_by: u.manager.id });
    expect(a.decided_at).not.toBeNull();
  });

  it("merges the item's other rows into it: retired row, document moved, plan row removed and the type added", async () => {
    expect(await typeRow(rowB)).toMatchObject({ status: "mapped", active: false, mapped_to_id: rowA, proposed_for_client_id: clientB });
    expect((await documentRow(docB)).doc_type_id).toBe(rowA);
    expect((await planRowOf(clientB, rowB))!.state).toBe("removed");
    expect((await planRowOf(clientB, rowA))!.state).toBe("active");
    expect((await planRowOf(clientA, rowA))!.state).toBe("active"); // the survivor's own plan row is untouched
  });

  it("is offered to every client: suggestions and filing", async () => {
    const { data, error } = await as.staff.rpc("suggest_doc_types", { p_client_id: clientD, p_query: name.toLowerCase() });
    expect(error).toBeNull();
    expect((data as Array<{ doc_type_id: string; status: string }>).find((s) => s.doc_type_id === rowA)).toMatchObject({ status: "approved" });
    expect((await createDocument(as.staff, { client_id: clientD, doc_type_id: rowA })).error).toBeNull();
  });

  it("leaves the queue", async () => {
    expect((await queueOf("admin")).items.some((i) => i.type_ids.includes(rowA) || i.type_ids.includes(rowB))).toBe(false);
  });

  it("is refused when an approved type of the same name already exists in the group", async () => {
    const dup = uniq("Locker receipts");
    const proposed = await proposeType(as.staff, clientA, g.banking, dup);
    const { error } = await as.admin.from("doc_type").insert({
      office_id: officeId, doc_group_id: g.banking, code: `x_locker_${seq}`, name: dup, period_kind: "none",
      default_frequency: "as_needed", source: "client",
    });
    expect(error).toBeNull(); // 02's "+ Add type" after the proposal
    expect((await approveType(as.admin, { type_id: proposed })).error?.message ?? "").toMatch(/DUPLICATE_TYPE/);
    expect((await typeRow(proposed)).status).toBe("proposed");
  });
});

// ── Edit & approve (AC-3) + schedule (AC-4) ────────────────────────────────────
describe("edit & approve (AC-3)", () => {
  it("a rename keeps the old name as an alias", async () => {
    const old = uniq("Petty cash vouchers");
    const row = await proposeType(as.staff, clientA, g.accounting, old);
    const { type_id } = await mustOk(approveType(as.admin, { type_id: row, edits: { name: uniq("Petty cash book") } }));
    const r = await typeRow(type_id);
    expect(r.status).toBe("approved");
    expect(r.aliases.map((x) => x.toLowerCase())).toContain(old.toLowerCase());
  });

  it("a group change moves the type: its documents follow and each proposing client's plan has it in the new group", async () => {
    const row = await proposeType(as.staff, clientB, g.other, uniq("Director KYC"));
    const doc = await file("staff", clientB, row, { period_id: null });
    const { type_id } = await mustOk(approveType(as.admin, { type_id: row, edits: { doc_group_id: g.roc } }));
    expect((await typeRow(type_id)).doc_group_id).toBe(g.roc);
    expect((await documentRow(doc.id)).doc_type_id).toBe(type_id);
    const plan = await planRowOf(clientB, type_id);
    expect(plan).toMatchObject({ state: "active", client_group: { doc_group_id: g.roc, state: "active" } });
    if (type_id !== row) {
      expect((await planRowOf(clientB, row))!.state).toBe("removed");
      expect((await typeRow(row)).status).toBe("mapped");
    }
  });

  it("a period kind that doesn't fit the item's documents is refused, listing them; nothing changes", async () => {
    const row = await proposeType(as.staff, clientA, g.other, uniq("Rent receipts"));
    const monthly = [await file("staff", clientA, row), await file("staff", clientA, row, { period_id: p.may })];
    const undated = await file("staff", clientA, row, { period_id: null });
    const edits = { period_kind: "year", default_frequency: "yearly", ask_after_months: 1, ask_day: 1, overdue_after_months: 2, overdue_day: 15 };
    const preview = await mustOk(previewDecision(as.admin, { action: "approve", type_id: row, edits }));
    expect(preview.conflicts.map((c) => c.document_id).sort()).toEqual(monthly.map((d) => d.id).sort());
    expect(preview.conflicts.map((c) => c.doc_code).sort()).toEqual(monthly.map((d) => d.doc_code).sort());
    expect((await approveType(as.admin, { type_id: row, edits })).error?.message ?? "").toMatch(/PERIOD_KIND/);
    expect(await typeRow(row)).toMatchObject({ status: "proposed", period_kind: "none" });
    expect((await docsUnder(row)).sort()).toEqual([...monthly.map((d) => d.id), undated.id].sort());
  });

  it("validates the edits like 02's add-type form", async () => {
    const row = await proposeType(as.staff, clientA, g.other, uniq("Visitor log"));
    const bad = { default_frequency: "monthly", period_kind: "month" }; // scheduled without offsets
    expect((await approveType(as.admin, { type_id: row, edits: bad })).error).not.toBeNull();
    expect((await typeRow(row)).status).toBe("proposed");
  });
});

describe("schedule for the proposing clients only (AC-4)", () => {
  let rowX: string; // clientC, paused before approval
  let rowY: string; // clientD, active
  let approved: string;

  beforeAll(async () => {
    const name = uniq("Payroll summary");
    rowX = await proposeType(as.staff, clientC, g.payroll, name);
    rowY = await proposeType(as.staff, clientD, g.payroll, name);
    const { data, error } = await as.manager.from("client_doc_type").update({ state: "paused" })
      .eq("client_id", clientC).eq("doc_type_id", rowX).select("id");
    if (error || !data?.length) throw new Error(error?.message ?? "pause failed");
    const edits = { period_kind: "month", default_frequency: "monthly", ask_after_months: 1, ask_day: 1, overdue_after_months: 1, overdue_day: 5, reminders: true };
    approved = (await mustOk(approveType(as.admin, { type_id: rowX, edits }))).type_id;
  });

  it("an active proposing client's plan row takes the schedule from the earliest open period and gets its items at once", async () => {
    const row = (await planRowOf(clientD, approved))!;
    expect(row).toMatchObject({ state: "active", frequency: "monthly", ask_after_months: 1, ask_day: 1, overdue_after_months: 1, overdue_day: 5, reminders: true });
    expect(row.start_period_id).toBe(p.jun);
    expect(await typeRow(rowY)).toMatchObject({ status: "mapped", mapped_to_id: approved });
    expect((await planRowOf(clientD, rowY))!.state).toBe("removed");
    const items = await itemsOf(clientD, approved);
    expect(items.map((e) => e.period.code)).toEqual(["2026-06"]);
    expect(items[0].status).toBe("pending");
  });

  it("a paused row keeps its state: it takes the schedule but generates nothing", async () => {
    expect(await planRowOf(clientC, approved)).toMatchObject({ state: "paused", frequency: "monthly" });
    expect(await itemsOf(clientC, approved)).toEqual([]);
  });

  it("other clients are unchanged (no silent propagation)", async () => {
    expect(await planRowOf(clientA, approved)).toBeUndefined(); // A has Payroll enabled, but didn't propose it
    expect(await itemsOf(clientA, approved)).toEqual([]);
  });
});

// ── Merge (AC-5, AC-6, AC-8) ───────────────────────────────────────────────────
describe("merge into an approved type (AC-5, AC-6, AC-8)", () => {
  const name = uniq("Salary sheet");
  const comment = "Same as the salary register";
  let rowA: string; // clientA — Salary register already in A's plan
  let rowB: string; // clientB — no Payroll group
  const d = {} as Record<"reviewed" | "correction" | "archived" | "dispatched" | "soft", { id: string; doc_code: string }>;
  const before = {} as Record<string, Record<string, unknown>>;
  let resetsBefore: Record<string, number>;
  let salaryPlanA: string;
  let preview: Awaited<ReturnType<typeof previewDecision>>["data"];
  let result: Awaited<ReturnType<typeof mergeType>>["data"];

  beforeAll(async () => {
    rowA = await proposeType(as.staff, clientA, g.payroll, name);
    rowB = await proposeType(as.staff2, clientB, g.payroll, name);
    d.reviewed = await file("staff", clientA, rowA);
    await mustReview(as.staff, d.reviewed.id);
    d.correction = await file("staff", clientA, rowA);
    await mustReview(as.manager, d.correction.id, "needs_correction", "Wrong employee list");
    d.archived = await file("staff", clientA, rowA, { remark: "duplicate copy" });
    const { error: ae } = await as.manager.rpc("archive_document", { p_id: d.archived.id, p_reason: "duplicate" });
    if (ae) throw new Error(ae.message);
    d.dispatched = await mustCreateOriginal(as.staff2, { client_id: clientB, doc_type_id: rowB, period_id: p.jun }, as.staff);
    await mustDispatch(as.staff, { client_id: clientB, document_ids: [d.dispatched.id] });
    d.soft = await createSoftCopy(as.staff2, officeId, { client_id: clientB, doc_type_id: rowB, remark: "salary for June" });
    for (const [k, v] of Object.entries(d)) before[k] = await documentRow(v.id);
    resetsBefore = Object.fromEntries(await Promise.all(Object.entries(d).map(async ([k, v]) =>
      [k, (await reviewHistory(v.id)).filter((h) => h.outcome === "reset").length] as const)));
    salaryPlanA = (await planRowOf(clientA, t.salary))!.id;
    preview = await mustOk(previewDecision(as.admin, { action: "merge", type_id: rowA, target_id: t.salary }));
    result = await mustOk(mergeType(as.admin, rowB, t.salary, comment));
  }, 120_000);

  it("the preview says what the merge then did (AC-8)", () => {
    expect(preview).toMatchObject({ documents: 5, clients: 2, plan_added: 1, received: 2, conflicts: [] });
    expect(result).toEqual({ documents: 5, clients: 2, plan_added: 1, received: 2 });
  });

  it("moves every document, archived ones included; DOC-ID, versions, received details, period and remark are unchanged", async () => {
    for (const [k, v] of Object.entries(d)) {
      const after = await documentRow(v.id);
      expect(after.doc_type_id).toBe(t.salary);
      const keep = ["doc_code", "fy_code", "client_id", "period_id", "registration_id", "received_as", "channel", "received_on",
        "received_by", "remark", "current_version_id", "version_count", "classified_at", "archived_at", "archive_reason"];
      for (const f of keep) expect([k, f, after[f]]).toEqual([k, f, before[k][f]]);
    }
    expect(await docsUnder(rowA)).toEqual([]);
    expect(await docsUnder(rowB)).toEqual([]);
  });

  it("review and dispatch survive, with no reset row (AC-6)", async () => {
    for (const [k, v] of Object.entries(d)) {
      const after = await documentRow(v.id);
      for (const f of ["status", "reviewed_by", "reviewed_at", "correction_reason"]) expect([k, f, after[f]]).toEqual([k, f, before[k][f]]);
      expect([k, (await reviewHistory(v.id)).filter((h) => h.outcome === "reset").length]).toEqual([k, resetsBefore[k]]);
    }
    expect((await documentRow(d.correction.id)).status).toBe("needs_correction");
    expect((await liveDispatchItem(d.dispatched.id))).not.toBeNull();
  });

  it("proposed plan rows are removed; the target is added where absent and left alone where present", async () => {
    expect((await planRowOf(clientA, rowA))!.state).toBe("removed");
    expect((await planRowOf(clientB, rowB))!.state).toBe("removed");
    const a = (await planRowOf(clientA, t.salary))!;
    expect(a.id).toBe(salaryPlanA);
    expect(a.state).toBe("active");
    const b = (await planRowOf(clientB, t.salary))!;
    expect(b).toMatchObject({ state: "active", frequency: "monthly", ask_after_months: 1, ask_day: 1, overdue_after_months: 1, overdue_day: 3 });
    expect(b.start_period_id).toBe(p.jun); // earliest still-open period
    expect(b.client_group).toEqual({ doc_group_id: g.payroll, state: "active" });
  });

  it("retires each proposed row (mapped, inactive, mapped_to target, comment on the row) and adds the alias", async () => {
    for (const row of [rowA, rowB]) {
      expect(await typeRow(row)).toMatchObject({ status: "mapped", active: false, mapped_to_id: t.salary, decided_by: u.admin.id, decision_comment: comment });
    }
    const target = await typeRow(t.salary);
    expect(target.status).toBe("approved");
    expect(target.aliases.filter((a) => a.toLowerCase() === name.toLowerCase())).toHaveLength(1);
  });

  it("links moved documents to the target's expected items; Needs correction doesn't count (07)", async () => {
    const [a] = await itemsOf(clientA, t.salary).then((x) => x.filter((e) => e.period.code === "2026-06"));
    expect(a).toMatchObject({ status: "received", completed_by_document_id: d.reviewed.id });
    const [b] = await itemsOf(clientB, t.salary).then((x) => x.filter((e) => e.period.code === "2026-06"));
    expect(b).toMatchObject({ status: "received", completed_by_document_id: d.dispatched.id });
    expect((await documentRow(d.reviewed.id)).expected_doc_id).toBe(a.id);
  });

  it("writes one decision row and one type_merged row per document, IDs only (AC-14)", async () => {
    const rows = (await actionsIn("doc_type.merged")).filter((r) => r.entity_id === rowA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: u.admin.id, entity_type: "doc_type" });
    expect(rows[0].data).toMatchObject({ target_id: t.salary, documents: 5, clients: 2 });
    expect([...(rows[0].data.doc_type_ids as string[])].sort()).toEqual([rowA, rowB].sort());
    const json = JSON.stringify(rows[0].data);
    expect(json).not.toContain(name);
    expect(json).not.toContain(comment);
    for (const v of Object.values(d)) {
      const merged = (await activityFor(officeId, v.id)).filter((r) => r.action === "document.type_merged");
      expect(merged).toHaveLength(1);
      expect(merged[0].data).toMatchObject({ to_type_id: t.salary, client_id: (await documentRow(v.id)).client_id });
      expect([rowA, rowB]).toContain(merged[0].data.from_type_id);
    }
  });

  it("a staff member's own type change still resets the review (07 AC-4)", async () => {
    const { error } = await as.staff.rpc("update_document", { p_id: d.reviewed.id, p: { doc_type_id: t.bank } });
    expect(error).toBeNull();
    expect((await documentRow(d.reviewed.id)).status).toBe("received");
    expect((await reviewHistory(d.reviewed.id)).filter((h) => h.outcome === "reset")).toHaveLength(resetsBefore.reviewed + 1);
  });
});

describe("merge: target already in the plan in another state, existing alias (AC-5)", () => {
  it("a removed target plan row stays removed (S1: left as is)", async () => {
    const clientE = (await mustInsertClient(as.staff, officeId, { name: "Governance E", client_type: "individual", incharge_id: u.staff.id })).id;
    const { error: ge } = await as.staff.rpc("enable_client_group", { p_client_id: clientE, p_doc_group_id: g.payroll });
    if (ge) throw new Error(ge.message);
    const { data, error } = await as.staff.from("client_doc_type").update({ state: "removed" })
      .eq("client_id", clientE).eq("doc_type_id", t.salary).select("id");
    if (error || !data?.length) throw new Error(error?.message ?? "remove failed");
    const row = await proposeType(as.staff, clientE, g.payroll, uniq("Salary statement"));
    const res = await mustOk(mergeType(as.admin, row, t.salary));
    expect(res.plan_added).toBe(0);
    expect((await planRowOf(clientE, t.salary))!).toMatchObject({ id: data[0].id, state: "removed" });
  });

  it("a name that is already an alias isn't added twice", async () => {
    const row = await proposeType(as.staff, clientD, g.tds, "Payroll for TDS");
    const beforeAliases = (await typeRow(t.salaryTds)).aliases;
    await mustOk(mergeType(as.admin, row, t.salaryTds));
    expect((await typeRow(t.salaryTds)).aliases).toEqual(beforeAliases);
  });

  it("the target must be an approved, active, client-source type", async () => {
    const row = await proposeType(as.staff, clientD, g.banking, uniq("Bank advice"));
    const otherProposed = await proposeType(as.staff, clientD, g.banking, uniq("Bank memo"));
    const { error: ie } = await as.admin.from("doc_type").update({ active: false }).eq("id", t.balanceConf);
    expect(ie).toBeNull();
    try {
      for (const target of [t.gstReturns, t.balanceConf, otherProposed, row]) {
        expect((await mergeType(as.admin, row, target)).error?.message ?? "").toMatch(/TARGET_INVALID/);
      }
    } finally {
      await as.admin.from("doc_type").update({ active: true }).eq("id", t.balanceConf);
    }
    expect((await typeRow(row)).status).toBe("proposed");
  });
});

// ── Period fit (AC-7) ──────────────────────────────────────────────────────────
describe("period fit before merge (AC-7)", () => {
  it("refuses before anything changes and lists the documents that don't fit", async () => {
    const name = uniq("Bank letters");
    const row = await proposeType(as.staff, clientB, g.banking, name);
    const monthDoc = await file("staff", clientB, row);
    const yearDoc = await file("staff", clientB, row, { period_id: p.fy });
    const aliases = (await typeRow(t.balanceConf)).aliases;
    const preview = await mustOk(previewDecision(as.admin, { action: "merge", type_id: row, target_id: t.balanceConf }));
    expect(preview.conflicts).toEqual([{ document_id: monthDoc.id, doc_code: monthDoc.doc_code }]);
    expect((await mergeType(as.admin, row, t.balanceConf)).error?.message ?? "").toMatch(/PERIOD_KIND/);
    expect((await typeRow(row)).status).toBe("proposed");
    expect((await docsUnder(row)).sort()).toEqual([monthDoc.id, yearDoc.id].sort());
    expect((await typeRow(t.balanceConf)).aliases).toEqual(aliases);
    expect((await actionsIn("doc_type.merged")).some((r) => r.entity_id === row)).toBe(false);
  });
});

// ── Reject (AC-9) ──────────────────────────────────────────────────────────────
describe("reject (AC-9, AC-12)", () => {
  it("is refused while the item has documents, archived ones included", async () => {
    const row = await proposeType(as.staff, clientA, g.accounting, uniq("Old ledgers"));
    const doc = await file("staff", clientA, row, { period_id: null });
    const { error: ae } = await as.admin.rpc("archive_document", { p_id: doc.id, p_reason: "scanned twice" });
    expect(ae).toBeNull();
    expect((await rejectType(as.admin, row, "Not needed")).error?.message ?? "").toMatch(/HAS_DOCUMENTS/);
    expect((await typeRow(row)).status).toBe("proposed");
  });

  it("needs a reason of 1–500 characters", async () => {
    const row = await proposeType(as.staff, clientA, g.other, uniq("Diaries"));
    for (const bad of [null, "", "   ", "x".repeat(501)]) {
      expect((await rejectType(as.admin, row, bad)).error?.message ?? "").toMatch(/REASON_REQUIRED/);
    }
    expect((await typeRow(row)).status).toBe("proposed");
  });

  it("retires every row of the item and removes their plan rows; the reason stays on the row", async () => {
    const name = uniq("Visiting cards");
    const rowA = await proposeType(as.staff, clientA, g.other, name);
    const rowB = await proposeType(as.staff2, clientB, g.other, name);
    expect((await rejectType(as.manager, rowB, "  Not a compliance document  ")).error).toBeNull();
    for (const [row, client] of [[rowA, clientA], [rowB, clientB]] as const) {
      expect(await typeRow(row)).toMatchObject({ status: "rejected", active: false, mapped_to_id: null, decided_by: u.manager.id, decision_comment: "Not a compliance document" });
      expect((await planRowOf(client, row))!.state).toBe("removed");
    }
    const rows = (await actionsIn("doc_type.rejected")).filter((r) => r.entity_id === rowA);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].data)).not.toMatch(/compliance|Visiting/);
  });
});

// ── Roles (AC-10) ──────────────────────────────────────────────────────────────
describe("only Admin and Manager decide (AC-10)", () => {
  let row: string;
  beforeAll(async () => {
    row = await proposeType(as.staff, clientB, g.other, uniq("Role check"));
    await file("staff", clientB, row, { period_id: null });
  });

  it("Staff and Limited get ROLE_REQUIRED from every decision function and the preview", async () => {
    for (const who of ["staff", "limited"] as const) {
      expect((await approveType(as[who], { type_id: row })).error?.message ?? "").toMatch(ROLE);
      expect((await mergeType(as[who], row, t.bank)).error?.message ?? "").toMatch(ROLE);
      expect((await rejectType(as[who], row, "no")).error?.message ?? "").toMatch(ROLE);
      expect((await previewDecision(as[who], { action: "merge", type_id: row, target_id: t.bank })).error?.message ?? "").toMatch(ROLE);
    }
    expect((await typeRow(row)).status).toBe("proposed");
  });

  it("another office's admin can't decide it", async () => {
    expect((await mergeType(as.outsider, row, t.bank)).error).not.toBeNull();
    expect((await approveType(as.outsider, { type_id: row })).error).not.toBeNull();
    expect((await typeRow(row)).status).toBe("proposed");
  });

  it("nobody can retire a type by writing the row directly", async () => {
    for (const who of ["admin", "staff"] as const) {
      await as[who].from("doc_type").update({ status: "mapped", mapped_to_id: t.bank, active: false }).eq("id", row);
      await as[who].from("doc_type").update({ status: "approved", proposed_for_client_id: null }).eq("id", row);
    }
    expect(await typeRow(row)).toMatchObject({ status: "proposed", mapped_to_id: null });
  });
});

// ── Decided once (AC-11) ───────────────────────────────────────────────────────
describe("decided once (AC-11)", () => {
  it("a second decision on a decided item fails with ALREADY_DECIDED", async () => {
    const row = await proposeType(as.staff, clientB, g.other, uniq("Gate register"));
    await mustOk(approveType(as.admin, { type_id: row }));
    expect((await mergeType(as.manager, row, t.bank)).error?.message ?? "").toMatch(/ALREADY_DECIDED/);
    expect((await rejectType(as.manager, row, "late")).error?.message ?? "").toMatch(/ALREADY_DECIDED/);
    expect((await approveType(as.manager, { type_id: row })).error?.message ?? "").toMatch(/ALREADY_DECIDED/);
  });

  it("two admins deciding at once: exactly one wins", async () => {
    const row = await proposeType(as.staff, clientB, g.banking, uniq("Cheque book requests"));
    const [m, r] = await Promise.all([mergeType(as.admin, row, t.bank), rejectType(as.manager, row, "duplicate")]);
    const errors = [m.error, r.error].filter(Boolean);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/ALREADY_DECIDED/);
    expect(["mapped", "rejected"]).toContain((await typeRow(row)).status);
  });

  it("a document filed while the item is merged lands before (and moves) or is refused after — never left behind", async () => {
    for (let i = 0; i < 5; i++) {
      const row = await proposeType(as.staff, clientB, g.banking, uniq("Race receipt"));
      await file("staff", clientB, row);
      const [m, c] = await Promise.all([
        mergeType(as.admin, row, t.bank),
        createDocument(as.staff2, { client_id: clientB, doc_type_id: row, period_id: p.jun }),
      ]);
      expect(m.error).toBeNull();
      if (c.error) expect(c.error.message).toMatch(/TYPE_NOT_OFFERED/);
      else expect((await documentRow(c.data!.id)).doc_type_id).toBe(t.bank);
      expect(await docsUnder(row)).toEqual([]);
    }
  });
});

// ── Comments, notifications, activity (AC-12 … AC-14) ─────────────────────────
describe("comments and notifications (AC-12, AC-13, AC-14)", () => {
  const name = uniq("Gate passes");
  let rowA: string;
  let rowB: string;
  const comment = "Approved for all clients";

  beforeAll(async () => {
    rowA = await proposeType(as.staff, clientA, g.other, name);
    rowB = await proposeType(as.staff2, clientB, g.other, name);
    await proposeType(as.staff, clientC, g.other, name); // staff proposed twice → still one notification
  });

  it("a comment over 500 characters is refused", async () => {
    expect((await approveType(as.admin, { type_id: rowA, comment: "x".repeat(501) })).error?.message ?? "").toMatch(/COMMENT_TOO_LONG|violates/);
    expect((await typeRow(rowA)).status).toBe("proposed");
  });

  it("each distinct proposer gets one notification; the decider and others get none", async () => {
    await mustOk(approveType(as.admin, { type_id: rowA, comment }));
    expect((await typeRow(rowA)).decision_comment).toBe(comment);
    const mine = (id: string) => notificationsOf(id).then((n) => n.filter((x) => x.data.doc_type_id === rowA));
    for (const who of ["staff", "staff2"] as const) {
      const n = await mine(u[who].id);
      expect(n).toHaveLength(1);
      expect(n[0]).toMatchObject({ office_id: officeId, kind: "type_decision", entity_type: "doc_type", entity_id: rowA, read_at: null, data: { decision: "approved", doc_type_id: rowA } });
      const json = JSON.stringify(n[0].data);
      expect(json).not.toContain(name);
      expect(json).not.toContain(comment);
      expect(json).not.toMatch(/Governance/);
    }
    for (const who of ["admin", "manager", "limited"] as const) expect(await mine(u[who].id)).toEqual([]);
  });

  it("the decision's activity row holds IDs and counts only", async () => {
    const rows = (await actionsIn("doc_type.approved")).filter((r) => r.entity_id === rowA);
    expect(rows).toHaveLength(1);
    expect([...(rows[0].data.doc_type_ids as string[])]).toEqual(expect.arrayContaining([rowA, rowB]));
    expect(JSON.stringify(rows[0].data)).not.toMatch(new RegExp(`${name}|${comment}`));
  });

  it("each staff member reads and marks only their own notifications", async () => {
    const theirs = (await notificationsOf(u.staff2.id)).find((n) => n.data.doc_type_id === rowA)!;
    const { data: seen } = await as.staff.from("notification").select("id").eq("id", theirs.id);
    expect(seen).toEqual([]);
    const { data: own } = await as.staff.from("notification").select("id, data, read_at").eq("entity_id", rowA);
    expect(own).toHaveLength(1);
    await as.staff.from("notification").update({ read_at: new Date().toISOString() }).eq("id", theirs.id);
    expect((await notificationsOf(u.staff2.id)).find((n) => n.id === theirs.id)!.read_at).toBeNull();
    const ownId = own![0].id as string;
    expect((await as.staff.from("notification").update({ data: { decision: "rejected" } }).eq("id", ownId)).error).not.toBeNull();
    await as.staff.from("notification").delete().eq("id", ownId);
    expect((await notificationsOf(u.staff.id)).some((n) => n.id === ownId)).toBe(true);
    const ins = await as.staff.from("notification").insert({
      office_id: officeId, recipient_id: u.staff.id, kind: "type_decision", entity_type: "doc_type", entity_id: rowA, data: { decision: "approved" },
    });
    expect(ins.error).not.toBeNull();
    const { data: outsiderSees } = await as.outsider.from("notification").select("id").eq("entity_id", rowA);
    expect(outsiderSees ?? []).toEqual([]);
  });

  it("mark_notifications_read marks the caller's own only", async () => {
    const { data, error } = await as.staff.rpc("mark_notifications_read");
    expect(error).toBeNull();
    expect(data as number).toBeGreaterThanOrEqual(1);
    expect((await notificationsOf(u.staff.id)).every((n) => n.read_at !== null)).toBe(true);
    expect((await notificationsOf(u.staff2.id)).find((n) => n.data.doc_type_id === rowA)!.read_at).toBeNull();
  });

  it("merge and reject notify too, with the decision", async () => {
    const m = await proposeType(as.staff2, clientD, g.banking, uniq("Pass sheet"));
    await mustOk(mergeType(as.admin, m, t.bank));
    expect((await notificationsOf(u.staff2.id)).find((n) => n.data.doc_type_id === m)!.data).toMatchObject({ decision: "merged", target_id: t.bank });
    const r = await proposeType(as.staff2, clientD, g.other, uniq("Calendars"));
    await mustOk(rejectType(as.admin, r, "Not a client document"));
    const n = (await notificationsOf(u.staff2.id)).find((x) => x.data.doc_type_id === r)!;
    expect(n.data.decision).toBe("rejected");
    expect(JSON.stringify(n.data)).not.toContain("Not a client document");
  });
});

// ── Search and suggestions (AC-15) ─────────────────────────────────────────────
describe("suggestions and search after a merge (AC-15)", () => {
  const name = uniq("Statement of salary");
  let row: string;
  let doc: string;

  beforeAll(async () => {
    row = await proposeType(as.staff, clientB, g.payroll, name);
    doc = (await file("staff", clientB, row)).id;
    await mustOk(mergeType(as.admin, row, t.salary));
  });

  it("typing the old proposed name suggests the target (through its alias), for any client; the retired type is gone", async () => {
    for (const client of [clientB, clientD]) {
      const { data, error } = await as.staff.rpc("suggest_doc_types", { p_client_id: client, p_query: name.toLowerCase() });
      expect(error).toBeNull();
      const ids = (data as Array<{ doc_type_id: string }>).map((s) => s.doc_type_id);
      expect(ids).toContain(t.salary);
      expect(ids).not.toContain(row);
    }
  });

  it("/documents finds the moved document under the target", async () => {
    const { data, error } = await as.staff.rpc("search_documents", { p: { filters: { doc_type_id: t.salary, client_id: clientB } } });
    expect(error).toBeNull();
    expect((data as { rows: Array<{ id: string }> }).rows.map((r) => r.id)).toContain(doc);
  });

  it("filing under the retired type is refused", async () => {
    expect((await createDocument(as.staff, { client_id: clientB, doc_type_id: row })).error?.message ?? "").toMatch(/TYPE_NOT_OFFERED/);
  });
});

// ── Metric 3 (AC-16) — own office, so other tests' documents don't count ──────
describe("metric 3: filed under approved types (AC-16)", () => {
  let mOffice: string;
  const m = {} as Record<"admin" | "staff", SupabaseClient>;
  const mu = {} as Record<"admin" | "staff", { id: string; email: string }>;
  let proposed: string;
  let bank: string;

  beforeAll(async () => {
    mOffice = await createDocumentOffice("governance-metric");
    mu.admin = await createStaff(mOffice, "govm-admin", "admin");
    mu.staff = await createStaff(mOffice, "govm-staff", "staff");
    m.admin = await signedInClient(mu.admin.email);
    m.staff = await signedInClient(mu.staff.email);
    bank = await typeId(mOffice, T.bank);
    const client = (await mustInsertClient(m.staff, mOffice, { name: "Metric client", client_type: "individual", incharge_id: mu.staff.id })).id;
    proposed = await proposeType(m.staff, client, await groupId(mOffice, "Banking"), "Odd slips");
    for (let i = 0; i < 3; i++) await mustCreateDocument(m.staff, { client_id: client, doc_type_id: bank });
    await mustCreateDocument(m.staff, { client_id: client, doc_type_id: proposed });
    const archived = await mustCreateDocument(m.staff, { client_id: client, doc_type_id: proposed });
    const { error } = await m.admin.rpc("archive_document", { p_id: archived.id, p_reason: "duplicate" });
    if (error) throw new Error(error.message);
    await mustCreateDocument(m.staff, { remark: "inbox item" }); // unclassified: not counted
  }, 120_000);

  afterAll(async () => { await retireStaff([mu.staff, mu.admin].filter(Boolean).map((x) => x.id)); });

  it("= classified, non-archived documents under approved types ÷ all classified, non-archived; plus the queue age", async () => {
    const { data, error } = await m.admin.rpc("catalogue_metric");
    expect(error).toBeNull();
    expect(data).toMatchObject({ approved: 3, total: 4, approved_pct: 75, waiting: 1, oldest_days: 0 });
  });

  it("rises to 100% once the proposal is merged", async () => {
    await mustOk(mergeType(m.admin, proposed, bank));
    const { data } = await m.admin.rpc("catalogue_metric");
    expect(data).toMatchObject({ approved: 4, total: 4, approved_pct: 100, waiting: 0, oldest_days: null });
  });

  it("is Admin/Manager only", async () => {
    expect((await m.staff.rpc("catalogue_metric")).error?.message ?? "").toMatch(ROLE);
  });
});
