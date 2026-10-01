import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Feature 07 step 4: the review and dispatch server actions' contract with the database, with Supabase mocked.
// (Visibility and the rules themselves are proven against the real database in tests/rls/review-dispatch.test.ts.)

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const me = { id: "me", role: "staff" as string };
vi.mock("@/lib/auth/staff", () => ({ requireStaff: vi.fn(async () => me) }));
const rpc = vi.fn();
const maybeSingle = vi.fn(async () => ({ data: { reviewer: { full_name: "Priya" } }, error: null }));
const from = vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc, from }) }));

const { markReviewed, markNeedsCorrection, undoReview } = await import("@/lib/review/actions");
const { createDispatch, undoDispatchItem, readyOriginals } = await import("@/lib/dispatch/actions");
const { reviewErrorMessage } = await import("@/lib/review/messages");

const D = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";
let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  rpc.mockReset();
  me.role = "staff";
  errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => errorLog.mockRestore());

describe("review actions", () => {
  it("Mark reviewed calls review_document with outcome reviewed", async () => {
    rpc.mockResolvedValue({ error: null });
    expect(await markReviewed({ id: D, clientId: C })).toEqual({ ok: true, message: "Marked reviewed." });
    expect(rpc).toHaveBeenCalledWith("review_document", { p_id: D, p_outcome: "reviewed", p_reason: null });
  });

  it("Needs correction trims the reason and refuses a blank or long one before calling the database", async () => {
    rpc.mockResolvedValue({ error: null });
    expect((await markNeedsCorrection({ id: D, reason: "  " })).ok).toBe(false);
    expect((await markNeedsCorrection({ id: D, reason: "x".repeat(501) })).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    await markNeedsCorrection({ id: D, reason: "  Blurred  " });
    expect(rpc).toHaveBeenCalledWith("review_document", { p_id: D, p_outcome: "needs_correction", p_reason: "Blurred" });
  });

  it("Undo is Admin/Manager only (the database checks again)", async () => {
    expect(await undoReview({ id: D, reason: "Mistake" })).toMatchObject({ ok: false, stale: false });
    expect(rpc).not.toHaveBeenCalled();
    me.role = "manager";
    rpc.mockResolvedValue({ error: null });
    expect((await undoReview({ id: D, reason: "Mistake" })).ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith("undo_review", { p_id: D, p_reason: "Mistake" });
  });

  it("a stale action (someone reviewed it first) says so and is marked stale; errors log a code only", async () => {
    rpc.mockResolvedValue({ error: { code: "P0001", message: "ALREADY_REVIEWED: this document has already been reviewed" } });
    const r = await markReviewed({ id: D });
    expect(r).toEqual({ ok: false, stale: true, error: "Already reviewed by Priya. The page has been refreshed." }); // spec: "Already reviewed by <name>"
    expect(errorLog).toHaveBeenCalledWith("review.reviewed_failed", { code: "P0001", requestId: expect.any(String) });
  });

  it("refuses a malformed id without calling the database", async () => {
    expect((await markReviewed({ id: "x" })).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("dispatch actions", () => {
  const input = { clientId: C, documentIds: [D], dispatchedOn: "2026-09-30", method: "courier", courierName: "DTDC", trackingNo: "T1", recipientName: "R Kumar" };

  it("creates the packet with the database's argument names", async () => {
    rpc.mockResolvedValue({ error: null });
    expect(await createDispatch(input)).toEqual({ ok: true, message: "Marked 1 dispatched." });
    expect(rpc).toHaveBeenCalledWith("create_dispatch", { p: {
      client_id: C, document_ids: [D], dispatched_on: "2026-09-30", method: "courier", courier_name: "DTDC", tracking_no: "T1", recipient_name: "R Kumar",
    } });
  });

  it("returns field errors without calling the database", async () => {
    const r = await createDispatch({ ...input, recipientName: "", documentIds: [] });
    expect(r).toMatchObject({ ok: false, fieldErrors: { recipientName: expect.any(String), documentIds: expect.any(String) } });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("an ineligible original refuses the packet; the dialog gets the fresh list (AC-9) and nothing personal is logged", async () => {
    rpc.mockImplementation(async (name: string) => name === "create_dispatch"
      ? { error: { code: "23514", message: "NOT_ELIGIBLE: DOC-FY26-27-00001 is not a ready original of this client" } }
      : { data: { total: 1, rows: [{ id: "x", doc_code: "DOC-FY26-27-00002", type_name: "Form 16", period_label: "FY 2025-26", received_on: "2026-09-01" }] }, error: null });
    const r = await createDispatch(input);
    expect(r).toMatchObject({ ok: false, stale: true, originals: [{ id: "x", docCode: "DOC-FY26-27-00002" }] });
    expect(JSON.stringify(errorLog.mock.calls)).not.toMatch(/R Kumar|DTDC|T1/);
  });

  it("the dialog's list is search_documents with return = ready for the client", async () => {
    rpc.mockResolvedValue({ data: { total: 0, rows: [] }, error: null });
    expect(await readyOriginals(C)).toEqual({ ok: true, originals: [] });
    expect(rpc).toHaveBeenCalledWith("search_documents", { p: expect.objectContaining({ filters: { client_id: C, return: "ready" } }) });
  });

  it("Undo dispatch is Admin/Manager only and needs a reason", async () => {
    expect((await undoDispatchItem({ documentId: D, reason: "x" })).ok).toBe(false);
    me.role = "admin";
    expect((await undoDispatchItem({ documentId: D, reason: "" })).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockResolvedValue({ error: null });
    expect((await undoDispatchItem({ documentId: D, reason: "Returned" })).ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith("undo_dispatch_item", { p_document_id: D, p_reason: "Returned" });
  });
});

describe("packet race and messages (sdlc-reviewer nits 5, 6)", () => {
  it("losing the one-live-packet race is treated as stale and re-lists the originals", async () => {
    rpc.mockImplementation(async (name: string) => name === "create_dispatch"
      ? { error: { code: "23505", message: 'duplicate key value violates unique constraint "dispatch_item_live_key"' } }
      : { data: { total: 0, rows: [] }, error: null });
    const r = await createDispatch({ clientId: C, documentIds: [D], dispatchedOn: "2026-09-30", method: "other", recipientName: "X" });
    expect(r).toMatchObject({ ok: false, stale: true, originals: [] });
    expect((r as { error: string }).error).toMatch(/no longer ready/);
  });
  it("a signed-out caller is told to sign in, not that only Admins can act", () => {
    expect(reviewErrorMessage("ROLE_REQUIRED: sign in as active staff")).toMatch(/Sign in again/);
    expect(reviewErrorMessage("ROLE_REQUIRED: only Admin or Manager can undo a review")).toMatch(/Admin or Manager/);
  });
});

describe("reviewErrorMessage", () => {
  it("maps codes to plain messages and never echoes database text", () => {
    expect(reviewErrorMessage("NOT_CLASSIFIED: …")).toMatch(/File the document/);
    expect(reviewErrorMessage("DATE_BEFORE_RECEIVED")).toMatch(/before/);
    expect(reviewErrorMessage('duplicate key value violates "secret"')).toBe("Couldn't save. Please try again.");
  });
});
