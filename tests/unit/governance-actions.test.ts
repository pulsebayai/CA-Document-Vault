import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Feature 05 step 3: the governance server actions' contract with the database, with Supabase mocked.
// The rules themselves (roles, merge, period fit, decided once…) are proven in tests/rls/type-governance.test.ts.

vi.unmock("@/lib/catalogue/governance"); // tests the real actions (setup-dom stubs them for view tests)
vi.mock("server-only", () => ({}));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
const me = { id: "me", role: "admin" as string, officeId: "o1" };
vi.mock("@/lib/auth/staff", () => ({ requireStaff: vi.fn(async () => me) }));
const rpc = vi.fn();
const maybeSingle = vi.fn(async () => ({ data: { full_name: "Raja" }, error: null }));
const from = vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc, from }) }));

const { approveProposedType, editAndApproveType, mergeProposedType, rejectProposedType, previewDecision } = await import("@/lib/catalogue/governance");

const T = "11111111-1111-4111-8111-111111111111";
const X = "22222222-2222-4222-8222-222222222222";
const G = "33333333-3333-4333-8333-333333333333";
const RAJA = "44444444-4444-4444-8444-444444444444";
const dbCounts = { documents: 5, clients: 2, plan_added: 1, received: 2 };

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  rpc.mockReset(); revalidatePath.mockReset(); me.role = "admin";
  errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => errorLog.mockRestore());

describe("roles (AC-10)", () => {
  it("Staff and Limited are refused before the database is called", async () => {
    for (const role of ["staff", "limited"]) {
      me.role = role;
      expect(await approveProposedType({ typeId: T })).toMatchObject({ ok: false, error: /Admin or Manager/ });
      expect(await mergeProposedType({ typeId: T, targetId: X })).toMatchObject({ ok: false });
      expect(await rejectProposedType({ typeId: T, reason: "no" })).toMatchObject({ ok: false });
      expect(await previewDecision({ action: "merge", typeId: T, targetId: X })).toMatchObject({ ok: false });
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("approve / edit & approve (AC-2, AC-3)", () => {
  it("Approve calls approve_proposed_type with the trimmed comment and refreshes the catalogue and collection pages", async () => {
    rpc.mockResolvedValue({ data: { ...dbCounts, type_id: T }, error: null });
    const r = await approveProposedType({ typeId: T, comment: "  ok  " });
    expect(rpc).toHaveBeenCalledWith("approve_proposed_type", { p: { type_id: T, comment: "ok" } });
    expect(r).toMatchObject({ ok: true, typeId: T, counts: { documents: 5, clients: 2, planAdded: 1, received: 2 } });
    expect(revalidatePath).toHaveBeenCalledWith("/settings/catalogue");
    expect(revalidatePath).toHaveBeenCalledWith("/settings/collection");
  });

  it("Edit & approve validates with 02's rules and sends the edits in the database's column names", async () => {
    expect(await editAndApproveType({ typeId: T, edits: { name: "", groupId: G, periodKind: "month", frequency: "as_needed" } }))
      .toMatchObject({ ok: false, fieldErrors: { name: expect.any(String) } });
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockResolvedValue({ data: { ...dbCounts, type_id: X }, error: null });
    await editAndApproveType({ typeId: T, edits: { name: "Payroll summary", groupId: G, periodKind: "month", frequency: "as_needed" } });
    expect(rpc).toHaveBeenCalledWith("approve_proposed_type", { p: { type_id: T, comment: null, edits: expect.objectContaining({
      name: "Payroll summary", doc_group_id: G, period_kind: "month", default_frequency: "as_needed",
    }) } });
  });

  it("a period that doesn't fit lists the documents (AC-3)", async () => {
    rpc.mockImplementation(async (fn: string) => fn === "approve_proposed_type"
      ? { data: null, error: { code: "23514", message: "PERIOD_KIND: 2 documents don't fit a year type" } }
      : { data: { ...dbCounts, conflicts: [{ document_id: X, doc_code: "DOC-FY26-27-00007" }] }, error: null });
    const r = await editAndApproveType({ typeId: T, edits: { name: "Rent", groupId: G, periodKind: "year", frequency: "yearly", askAfterMonths: "1", askDay: "1", overdueAfterMonths: "2", overdueDay: "15" } });
    expect(r).toMatchObject({ ok: false, conflicts: [{ documentId: X, docCode: "DOC-FY26-27-00007" }], error: /yearly type can't hold/ });
  });
});

describe("merge and reject (AC-5, AC-7, AC-9)", () => {
  it("Merge passes the database's argument names and reports how many documents moved", async () => {
    rpc.mockResolvedValue({ data: dbCounts, error: null });
    expect(await mergeProposedType({ typeId: T, targetId: X })).toMatchObject({ ok: true, message: "Merged: 5 documents moved." });
    expect(rpc).toHaveBeenCalledWith("merge_proposed_type", { p_type: T, p_target: X, p_comment: null });
  });

  it("Merge without a target is refused before the database", async () => {
    expect(await mergeProposedType({ typeId: T, targetId: "" })).toMatchObject({ ok: false, fieldErrors: { targetId: expect.any(String) } });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("Reject requires a reason of 1–500 characters", async () => {
    expect(await rejectProposedType({ typeId: T, reason: "  " })).toMatchObject({ ok: false, fieldErrors: { reason: expect.any(String) } });
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockResolvedValue({ data: null, error: null });
    expect((await rejectProposedType({ typeId: T, reason: " Not needed " })).ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith("reject_proposed_type", { p_type: T, p_comment: "Not needed" });
  });
});

describe("decided once (AC-11) and logging", () => {
  it("someone else decided first: 'Already decided by <name>', marked stale, logged as a code only", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: `ALREADY_DECIDED: ${RAJA}` } });
    const r = await mergeProposedType({ typeId: T, targetId: X, comment: "Salary for Acme Traders" });
    expect(r).toEqual({ ok: false, stale: true, error: "Already decided by Raja. Close to see the updated list." });
    expect(errorLog).toHaveBeenCalledWith("governance.merge_failed", { code: "P0001", requestId: expect.any(String) });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("Acme");
    // No revalidation on a stale decision: it would unmount the dialog holding the message; the dialog refreshes
    // the page when it closes (pre-PR review I-2).
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("the preview returns the database's counts and conflicts", async () => {
    rpc.mockResolvedValue({ data: { ...dbCounts, conflicts: [] }, error: null });
    expect(await previewDecision({ action: "merge", typeId: T, targetId: X }))
      .toEqual({ ok: true, counts: { documents: 5, clients: 2, planAdded: 1, received: 2 }, conflicts: [] });
    expect(rpc).toHaveBeenCalledWith("preview_type_decision", { p: { action: "merge", type_id: T, target_id: X } });
  });
});
