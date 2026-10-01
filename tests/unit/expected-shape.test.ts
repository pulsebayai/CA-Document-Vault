import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectedErrorMessage, matchesStatus, officeToday, openCount, openForCards, repeatedKinds, sortItems, toItem, type RawExpected,
} from "@/lib/expected/shape";

// Feature 04 step 4 — shaping for the Expected tab / Documents cards (AC-13, AC-14) and the waive / undo / reopen
// actions (AC-9 … AC-11). The SQL functions and RLS are proven in tests/rls/expected-*.test.ts.

const raw = (over: Partial<RawExpected> = {}): RawExpected => ({
  id: "e1", status: "pending", ask_on: "2026-10-01", overdue_from: "2026-10-05", received_on: null,
  waived_reason: null, waived_code: null, waived_at: null, registration_id: null,
  doc_type: { id: "t1", name: "Sales invoices / sales register", doc_group: { id: "g1", name: "GST", sort: 1 } },
  period: { id: "p9", code: "2026-09", label: "Sep 2026", start_date: "2026-09-01", financial_year_id: "fy1" },
  registration: null, completed_by: null, waived_by_staff: null,
  row: { state: "active", assigned: null, group: { state: "active", assigned: { full_name: "Asha" } } },
  ...over,
});
const none = new Set<string>();

describe("toItem", () => {
  it("derives the shown state and open flag from the dates and today", () => {
    expect(toItem(raw(), "2026-10-02", none)).toMatchObject({ state: { kind: "due", text: "Due 4 Oct" }, open: true, assignedTo: "Asha" });
    expect(toItem(raw(), "2026-10-17", none)).toMatchObject({ state: { kind: "overdue", text: "Overdue · 13 days late" }, open: true });
  });

  it("On hold when the row or its group is paused — not open", () => {
    expect(toItem(raw({ row: { state: "paused", assigned: null, group: { state: "active", assigned: null } } }), "2026-10-17", none))
      .toMatchObject({ state: { kind: "on_hold" }, open: false });
    expect(toItem(raw({ row: { state: "active", assigned: null, group: { state: "paused", assigned: null } } }), "2026-10-17", none).state.kind)
      .toBe("on_hold");
  });

  it("Received shows the date and the completing DOC-ID", () => {
    const i = toItem(raw({ status: "received", received_on: "2026-10-03", completed_by: { doc_code: "DOC-FY26-27-00042" } }), "2026-10-10", none);
    expect(i).toMatchObject({ state: { text: "Received 3 Oct · DOC-FY26-27-00042" }, open: false });
  });

  it("Not needed shows the reason; system waivers say System, manual ones the person", () => {
    const sys = toItem(raw({ status: "waived", waived_code: "removed_from_plan", waived_reason: "Removed from plan" }), "2026-10-10", none);
    expect(sys).toMatchObject({ state: { text: "Not needed · Removed from plan" }, waivedBy: "System", manualWaiver: false });
    const man = toItem(raw({ status: "waived", waived_code: "manual", waived_reason: "Closed", waived_by_staff: { full_name: "Ravi" } }), "2026-10-10", none);
    expect(man).toMatchObject({ waivedBy: "Ravi", manualWaiver: true });
  });

  it("shows the GSTIN/TAN only when the client has more than one active of that kind (AC-13)", () => {
    const reg = { id: "r1", kind: "gstin" as const, number: "33ZZZPZ4101Z1Z5" };
    expect(toItem(raw({ registration: reg, registration_id: "r1" }), "2026-10-02", repeatedKinds([{ kind: "gstin", active: true }])).registration).toBeNull();
    const two = repeatedKinds([{ kind: "gstin", active: true }, { kind: "gstin", active: true }, { kind: "tan", active: true }, { kind: "tan", active: false }]);
    expect([...two]).toEqual(["gstin"]);
    expect(toItem(raw({ registration: reg, registration_id: "r1" }), "2026-10-02", two).registration).toBe("33ZZZPZ4101Z1Z5");
  });

  it("assigned staff: the row's own assignee, else the group's", () => {
    expect(toItem(raw({ row: { state: "active", assigned: { full_name: "Mohan" }, group: { state: "active", assigned: { full_name: "Asha" } } } }), "2026-10-02", none).assignedTo).toBe("Mohan");
  });
});

describe("filters, sort, count", () => {
  const rows = [
    raw({ id: "a", period: { id: "p8", code: "2026-08", label: "Aug 2026", start_date: "2026-08-01", financial_year_id: "fy1" }, status: "received", received_on: "2026-09-02" }),
    raw({ id: "b" }),
    raw({ id: "c", doc_type: { id: "t2", name: "Bank statement", doc_group: { id: "g2", name: "Banking", sort: 4 } } }),
    raw({ id: "d", status: "waived", waived_reason: "x" }),
  ];
  const items = rows.map((r) => toItem(r, "2026-10-02", none));

  it("status filter: Open = pending (incl. on hold), Received, Not needed, All", () => {
    expect(items.filter((i) => matchesStatus(i, "open")).map((i) => i.id)).toEqual(["b", "c"]);
    expect(items.filter((i) => matchesStatus(i, "received")).map((i) => i.id)).toEqual(["a"]);
    expect(items.filter((i) => matchesStatus(i, "not_needed")).map((i) => i.id)).toEqual(["d"]);
    expect(items.filter((i) => matchesStatus(i, "all"))).toHaveLength(4);
  });

  it("sorts group → type → newest period first", () => {
    expect(sortItems(rows, items).map((i) => i.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("the tab count is Due + Overdue only", () => {
    expect(openCount(items)).toBe(2);
  });
});

describe("officeToday (private.office_today)", () => {
  it("uses the test clock only in a test office", () => {
    expect(officeToday({ is_test: true, test_today: "2027-02-01" }, "2026-10-01")).toBe("2027-02-01");
    expect(officeToday({ is_test: false, test_today: "2027-02-01" }, "2026-10-01")).toBe("2026-10-01");
    expect(officeToday({ is_test: true, test_today: null }, "2026-10-01")).toBe("2026-10-01");
    expect(officeToday(null, "2026-10-01")).toBe("2026-10-01");
  });
});

describe("expectedErrorMessage", () => {
  it.each([
    ["ROLE_REQUIRED: Limited users cannot waive expected documents", "Limited users can't mark items not needed."],
    ["ROLE_REQUIRED: only Admin or Manager can undo a waiver", "Only an Admin or Manager can undo “Not needed”."],
    ["REASON_REQUIRED: give a reason of 1–500 characters", "Please give a reason (up to 500 characters)."],
    ["NOT_PENDING: only an open item can be marked not needed", "This item is no longer open. Reload the page."],
    ["NOT_WAIVED: this item is not marked not needed", "This item is not marked not needed. Reload the page."],
    ["NOT_RECEIVED: only a received item can be reopened", "Only a received item can be reopened. Reload the page."],
    ["NOT_FOUND: expected document", "This item is no longer available. Reload the page."],
    ["something else", "Something went wrong. Please try again."],
  ])("%s", (msg, expected) => expect(expectedErrorMessage(msg)).toBe(expected));
});

// ── Actions ─────────────────────────────────────────────────────────────────
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const me = { role: "staff" as string };
vi.mock("@/lib/auth/staff", () => ({ requireStaff: vi.fn(async () => ({ id: "me", role: me.role })) }));
const rpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc }) }));
const { reopenExpected, undoWaiveExpected, waiveExpected } = await import("@/lib/expected/actions");
const { revalidatePath } = await import("next/cache");

const ID = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";

describe("actions", () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { rpc.mockReset().mockResolvedValue({ error: null }); me.role = "staff"; log = vi.spyOn(console, "error").mockImplementation(() => undefined); });
  afterEach(() => log.mockRestore());

  it("waive: trims the reason, calls waive_expected and refreshes the client page", async () => {
    expect(await waiveExpected({ id: ID, clientId: CLIENT, reason: "  Client closed GST " })).toEqual({ ok: true, message: "Marked not needed." });
    expect(rpc).toHaveBeenCalledWith("waive_expected", { p_id: ID, p_reason: "Client closed GST" });
    expect(revalidatePath).toHaveBeenCalledWith(`/clients/${CLIENT}`);
  });

  it("waive: refuses Limited, an empty or over-long reason, or a bad id — without calling the database", async () => {
    me.role = "limited";
    expect(await waiveExpected({ id: ID, reason: "x" })).toEqual({ ok: false, error: "Limited users can't mark items not needed." });
    me.role = "staff";
    expect((await waiveExpected({ id: ID, reason: "   " })).ok).toBe(false);
    expect((await waiveExpected({ id: ID, reason: "x".repeat(501) })).ok).toBe(false);
    expect(await waiveExpected({ id: "nope", reason: "x" })).toEqual({ ok: false, error: "Invalid request." });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("undo is Admin/Manager only; reopen is for anyone signed in", async () => {
    expect((await undoWaiveExpected({ id: ID })).ok).toBe(false);
    me.role = "manager";
    expect(await undoWaiveExpected({ id: ID })).toEqual({ ok: true, message: "“Not needed” undone." });
    expect(rpc).toHaveBeenCalledWith("undo_waive_expected", { p_id: ID });
    me.role = "limited";
    expect(await reopenExpected({ id: ID })).toEqual({ ok: true, message: "Reopened." });
    expect(rpc).toHaveBeenLastCalledWith("reopen_expected", { p_id: ID });
  });

  it("maps database errors to plain messages and logs only a code + request ID (never the reason)", async () => {
    rpc.mockResolvedValue({ error: { code: "P0001", message: "NOT_PENDING: only an open item can be marked not needed" } });
    expect(await waiveExpected({ id: ID, reason: "Sharma closed the shop" })).toEqual({ ok: false, error: "This item is no longer open. Reload the page." });
    const [event, detail] = log.mock.calls[0];
    expect(event).toBe("expected.waive_failed");
    expect(Object.keys(detail as object).sort()).toEqual(["code", "requestId"]);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/Sharma/);
  });
});

describe("openForCards (AC-14: Documents cards)", () => {
  const fyCode = (id: string) => ({ fy26: "2025-26", fy27: "2026-27" } as Record<string, string>)[id] ?? "";
  const at = (id: string, over: Partial<RawExpected>, today = "2026-10-20") => ({ ...toItem(raw({ id, ...over }), today, none) });
  const items = [
    at("due", { overdue_from: "2026-10-25" }),
    at("late3", { overdue_from: "2026-10-18" }),
    at("late10", { overdue_from: "2026-10-11" }),
    at("today", { overdue_from: "2026-10-21" }),
    at("old", { overdue_from: "2026-06-10", period: { id: "p0", code: "2025-26", label: "FY 2025-26", start_date: "2025-04-01", financial_year_id: "fy26" } }),
    at("recv", { status: "received", received_on: "2026-10-02" }),
    at("hold", { row: { state: "paused", assigned: null, group: { state: "active", assigned: null } } }),
  ];

  it("Overdue (most days late first), then Due today, then Due; received and on-hold items are left out", () => {
    expect(openForCards(items, fyCode, "2026-27", "2026-27").map((i) => i.id)).toEqual(["old", "late10", "late3", "today", "due"]);
  });

  it("the current FY also shows still-open items of earlier FYs; a past FY shows only its own", () => {
    expect(openForCards(items, fyCode, "2025-26", "2026-27").map((i) => i.id)).toEqual(["old"]);
  });
});
