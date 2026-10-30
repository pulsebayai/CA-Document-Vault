import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { DENIED, createCatalogueOffice, mustInsertClient } from "../support/catalogue";
import {
  activityFor, createDispatch, createDocumentOffice, createSoftCopy, documentRow, liveDispatchItem, mustCreateDocument,
  mustCreateOriginal, mustDispatch, mustReview, periodId, reviewDocument, reviewHistory, typeId, undoReview, uploadObject,
} from "../support/documents";
import { T } from "../support/expected";
import { documentState, isReadyToDispatch, isToReview } from "@/lib/documents/state";

// Feature 07 — review & dispatch: review per role, Needs correction, undo, resets, history, packets, search,
// write protection and activity (spec AC-1 … AC-16). Written before the migrations (plan step 1).
// Contract: tests/support/documents.ts ("Feature 07"). The 04 linking cases are in review-metric.test.ts.
//
// Clients: A (Limited is incharge) · B (Staff is incharge; Limited can't see it) · C (archived after setup).

type Who = "admin" | "manager" | "staff" | "limited" | "outsider";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
let clientA: string;
let clientB: string;
let clientC: string;
const t = {} as Record<"bank" | "form16", string>;
const p = {} as Record<"apr" | "may" | "fy", string>;
const NOT_VISIBLE = /NOT_FOUND/;

/** A classified hard copy on client A (or another client), added by Staff. */
const filed = async (extra: Record<string, unknown> = {}) =>
  mustCreateDocument(as.staff, { client_id: clientA, doc_type_id: t.bank, period_id: p.apr, received_on: "2026-05-02", ...extra });
const statusOf = async (id: string) => (await documentRow(id)).status as string;
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  officeId = await createDocumentOffice("review-dispatch");
  const otherOffice = await createCatalogueOffice("review-dispatch-other");
  u.admin = await createStaff(officeId, "rd-admin", "admin");
  u.manager = await createStaff(officeId, "rd-manager", "manager");
  u.staff = await createStaff(officeId, "rd-staff", "staff");
  u.limited = await createStaff(officeId, "rd-limited", "limited");
  u.outsider = await createStaff(otherOffice, "rd-outsider", "admin");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  clientA = (await mustInsertClient(as.staff, officeId, { name: "Review A", client_type: "individual", incharge_id: u.limited.id })).id;
  clientB = (await mustInsertClient(as.staff, officeId, { name: "Review B", client_type: "individual", incharge_id: u.staff.id })).id;
  clientC = (await mustInsertClient(as.staff, officeId, { name: "Review C", client_type: "individual", incharge_id: u.staff.id })).id;
  t.bank = await typeId(officeId, T.bank);
  t.form16 = await typeId(officeId, T.form16);
  p.apr = await periodId(officeId, "2026-04");
  p.may = await periodId(officeId, "2026-05");
  p.fy = await periodId(officeId, "2025-26");
}, 120_000);

afterAll(async () => {
  await retireStaff([u.manager, u.staff, u.limited].filter(Boolean).map((x) => x.id));
  await retireStaff([u.admin, u.outsider].filter(Boolean).map((x) => x.id));
});

// ── Review (AC-1 … AC-3, AC-5 … AC-7) ─────────────────────────────────────────
describe("review (AC-1, AC-2, AC-3)", () => {
  it("anyone who can see a classified document marks it reviewed — Admin, Manager, Staff, and Limited on its own client", async () => {
    for (const k of ["admin", "manager", "staff", "limited"] as const) {
      const d = await filed();
      expect((await reviewDocument(as[k], d.id)).error).toBeNull();
      const row = await documentRow(d.id);
      expect(row).toMatchObject({ status: "reviewed", reviewed_by: u[k].id, correction_reason: null });
      expect(row.reviewed_at).not.toBeNull();
    }
  });

  it("Limited can't review a document of a client it can't see; another office can't review at all", async () => {
    const d = await filed({ client_id: clientB });
    expect((await reviewDocument(as.limited, d.id)).error?.message ?? "").toMatch(NOT_VISIBLE);
    expect((await reviewDocument(as.outsider, d.id)).error?.message ?? "").toMatch(NOT_VISIBLE);
    expect(await statusOf(d.id)).toBe("received");
  });

  it("Needs correction needs a reason of 1–500 characters and keeps it on the document", async () => {
    const d = await filed();
    for (const bad of [null, "", "   ", "x".repeat(501)]) {
      expect((await reviewDocument(as.staff, d.id, "needs_correction", bad)).error?.message ?? "").toMatch(/REASON_REQUIRED/);
    }
    expect(await statusOf(d.id)).toBe("received");
    expect((await reviewDocument(as.staff, d.id, "needs_correction", "  Wrong month — this is March  ")).error).toBeNull();
    expect(await documentRow(d.id)).toMatchObject({ status: "needs_correction", correction_reason: "Wrong month — this is March", reviewed_by: u.staff.id });
  });

  it("a Needs-correction document can be marked reviewed (the reason is cleared) or given a new reason", async () => {
    const d = await filed();
    await mustReview(as.staff, d.id, "needs_correction", "Pages missing");
    await mustReview(as.limited, d.id, "needs_correction", "Pages 3–4 missing");
    expect(await documentRow(d.id)).toMatchObject({ status: "needs_correction", correction_reason: "Pages 3–4 missing", reviewed_by: u.limited.id });
    await mustReview(as.manager, d.id);
    expect(await documentRow(d.id)).toMatchObject({ status: "reviewed", correction_reason: null, reviewed_by: u.manager.id });
  });

  it("a reviewed document can't be marked reviewed again (stale action), but can be flagged Needs correction", async () => {
    const d = await filed();
    await mustReview(as.staff, d.id);
    expect((await reviewDocument(as.limited, d.id)).error?.message ?? "").toMatch(/ALREADY_REVIEWED/);
    expect((await documentRow(d.id)).reviewed_by).toBe(u.staff.id);
    expect((await reviewDocument(as.limited, d.id, "needs_correction", "Wrong client")).error).toBeNull();
    expect(await statusOf(d.id)).toBe("needs_correction");
  });

  it("the outcome must be reviewed or needs_correction", async () => {
    const d = await filed();
    for (const bad of ["received", "undone", "reset", "dispatched", ""]) {
      expect((await reviewDocument(as.staff, d.id, bad as "reviewed", "x")).error).not.toBeNull();
    }
    expect(await statusOf(d.id)).toBe("received");
  });
});

describe("undo review (AC-5)", () => {
  it("Admin/Manager undo a review or a correction, with a reason, back to To review", async () => {
    for (const [k, outcome] of [["admin", "reviewed"], ["manager", "needs_correction"]] as const) {
      const d = await filed();
      await mustReview(as.staff, d.id, outcome, outcome === "needs_correction" ? "Blurred" : null);
      expect((await undoReview(as[k], d.id, "")).error?.message ?? "").toMatch(/REASON_REQUIRED/);
      expect((await undoReview(as[k], d.id, "Reviewed the wrong file")).error).toBeNull();
      expect(await documentRow(d.id)).toMatchObject({ status: "received", reviewed_by: null, reviewed_at: null, correction_reason: null });
    }
  });

  // 12 (spec AC-24, approved 2026-10-30): Staff can now undo a review; Limited still can't.
  it("Limited can't undo — the database refuses it", async () => {
    const d = await filed();
    await mustReview(as.staff, d.id);
    for (const k of ["limited"] as const) {
      expect((await undoReview(as[k], d.id, "Mistake")).error?.message ?? "").toMatch(/ROLE_REQUIRED/);
    }
    expect(await statusOf(d.id)).toBe("reviewed");
  });

  it("there is nothing to undo on a document still To review", async () => {
    const d = await filed();
    expect((await undoReview(as.manager, d.id, "Mistake")).error?.message ?? "").toMatch(/NOT_REVIEWED/);
  });
});

describe("only filed, live documents are reviewable (AC-6)", () => {
  it("an Inbox document can't be reviewed", async () => {
    const inbox = await mustCreateDocument(as.staff, { client_id: clientA }); // no type → Inbox
    expect((await reviewDocument(as.staff, inbox.id)).error?.message ?? "").toMatch(/NOT_CLASSIFIED/);
    expect((await reviewDocument(as.staff, inbox.id, "needs_correction", "x")).error?.message ?? "").toMatch(/NOT_CLASSIFIED/);
  });

  it("an archived document can't be reviewed or undone", async () => {
    const d = await filed();
    await mustReview(as.staff, d.id);
    expect((await as.manager.rpc("archive_document", { p_id: d.id, p_reason: "Duplicate" })).error).toBeNull();
    expect((await reviewDocument(as.staff, d.id, "needs_correction", "x")).error?.message ?? "").toMatch(/ARCHIVED/);
    expect((await undoReview(as.manager, d.id, "x")).error?.message ?? "").toMatch(/ARCHIVED/);
  });

  it("a document of an archived client can still be reviewed (its originals must still go back)", async () => {
    const d = await filed({ client_id: clientC });
    const o = await mustCreateOriginal(as.staff, { client_id: clientC, doc_type_id: t.bank, period_id: p.apr, received_on: "2026-05-02" });
    expect((await as.manager.from("client").update({ archived_at: new Date().toISOString() }).eq("id", clientC)).error).toBeNull();
    expect((await reviewDocument(as.staff, d.id)).error).toBeNull();
    expect((await reviewDocument(as.staff, o.id)).error).toBeNull();
  });
});

describe("review history (AC-7)", () => {
  it("every review event is kept, oldest first: outcome, reason (corrections and undos), who and when", async () => {
    const d = await filed();
    await mustReview(as.staff, d.id);
    expect((await undoReview(as.manager, d.id, "Wrong file reviewed")).error).toBeNull();
    await mustReview(as.limited, d.id, "needs_correction", "Unsigned");
    await mustReview(as.staff, d.id);
    const h = await reviewHistory(d.id);
    expect(h.map((r) => [r.outcome, r.reason, r.actor_id])).toEqual([
      ["reviewed", null, u.staff.id],
      ["undone", "Wrong file reviewed", u.manager.id],
      ["needs_correction", "Unsigned", u.limited.id],
      ["reviewed", null, u.staff.id],
    ]);
    expect(h.every((r) => r.office_id === officeId && r.created_at)).toBe(true);
  });

  it("history follows the document's visibility", async () => {
    const a = await filed();
    const b = await filed({ client_id: clientB });
    await mustReview(as.staff, a.id);
    await mustReview(as.staff, b.id);
    expect((await as.limited.from("document_review").select("id").eq("document_id", a.id)).data).toHaveLength(1);
    expect((await as.limited.from("document_review").select("id").eq("document_id", b.id)).data).toEqual([]);
    expect((await as.outsider.from("document_review").select("id").eq("document_id", a.id)).data).toEqual([]);
  });

  it("is append-only: users can't write it, and nobody (not even the service role) updates or deletes it", async () => {
    const d = await filed();
    await mustReview(as.staff, d.id);
    const [row] = await reviewHistory(d.id);
    const ins = await as.staff.from("document_review").insert({ office_id: officeId, document_id: d.id, outcome: "reviewed", actor_id: u.staff.id });
    expect(ins.error?.message ?? "").toMatch(DENIED);
    const upd = await as.admin.from("document_review").update({ reason: "edited" }).eq("id", row.id).select("id");
    expect(upd.error !== null || (upd.data ?? []).length === 0).toBe(true);
    expect((await adminClient().from("document_review").update({ reason: "edited" }).eq("id", row.id)).error?.message ?? "").toMatch(/IMMUTABLE|append-only/i);
    expect((await adminClient().from("document_review").delete().eq("id", row.id)).error).not.toBeNull();
    expect(await reviewHistory(d.id)).toHaveLength(1);
  });
});

describe("status changes only through the review functions (AC-15)", () => {
  it("a direct update of status or the review columns is refused", async () => {
    const d = await filed();
    for (const patch of [{ status: "reviewed" }, { reviewed_by: u.staff.id }, { reviewed_at: new Date().toISOString() }, { correction_reason: "x" }]) {
      const r = await as.admin.from("document").update(patch).eq("id", d.id).select("id");
      expect(r.error?.message ?? "").toMatch(DENIED);
    }
    expect(await statusOf(d.id)).toBe("received");
  });

  it("update_document can't smuggle a status change", async () => {
    const d = await filed();
    expect((await as.staff.rpc("update_document", { p_id: d.id, p: { status: "reviewed", remark: "note" } })).error).toBeNull();
    expect(await documentRow(d.id)).toMatchObject({ status: "received", remark: "note" });
  });
});

// ── Resets (AC-4) ─────────────────────────────────────────────────────────────
describe("what resets a review (AC-4)", () => {
  it("a new version sends a reviewed document back to To review, with a reset row in its history", async () => {
    const d = await createSoftCopy(as.staff, officeId, { client_id: clientA, doc_type_id: t.bank, period_id: p.apr, received_on: "2026-05-02" });
    await mustReview(as.staff, d.id);
    const obj = await uploadObject(officeId, "pdf", d.id);
    expect((await as.staff.rpc("add_document_version", { p_document_id: d.id, p_file: { storage_path: obj.path, file_name: "v2.pdf" } })).error).toBeNull();
    expect(await documentRow(d.id)).toMatchObject({ status: "received", reviewed_by: null, reviewed_at: null, received_on: "2026-05-02" });
    expect((await reviewHistory(d.id)).map((r) => [r.outcome, r.actor_id])).toEqual([["reviewed", u.staff.id], ["reset", u.staff.id]]);
    const acts = await activityFor(officeId, d.id);
    expect(acts.filter((a) => a.action === "document.version_added").at(-1)?.data).toMatchObject({ review_reset: true });
    expect(acts.some((a) => a.action === "document.review_reset")).toBe(false); // folded into the save's row
  });

  it("a corrected file for a Needs-correction document replaces received on with the corrected file's date", async () => {
    const d = await createSoftCopy(as.staff, officeId, { client_id: clientA, doc_type_id: t.bank, period_id: p.apr, received_on: "2026-05-02" });
    await mustReview(as.staff, d.id, "needs_correction", "Wrong account");
    const obj = await uploadObject(officeId, "pdf", d.id);
    const r = await as.staff.rpc("add_document_version", { p_document_id: d.id, p_file: { storage_path: obj.path, file_name: "fixed.pdf" }, p_received_on: "2026-05-20" });
    expect(r.error).toBeNull();
    expect(await documentRow(d.id)).toMatchObject({ status: "received", received_on: "2026-05-20", correction_reason: null });
    expect(JSON.stringify((await activityFor(officeId, d.id)).at(-1)?.data)).toMatch(/received_on/);
  });

  it("the corrected date can't be in the future, and is ignored for a document that doesn't need correction", async () => {
    const d = await createSoftCopy(as.staff, officeId, { client_id: clientA, doc_type_id: t.bank, period_id: p.apr, received_on: "2026-05-02" });
    await mustReview(as.staff, d.id, "needs_correction", "Wrong account");
    const o1 = await uploadObject(officeId, "pdf", d.id);
    const bad = await as.staff.rpc("add_document_version", { p_document_id: d.id, p_file: { storage_path: o1.path, file_name: "f.pdf" }, p_received_on: addDays(today(), 1) });
    expect(bad.error?.message ?? "").toMatch(/RECEIVED_ON_FUTURE/);
    expect(await documentRow(d.id)).toMatchObject({ status: "needs_correction", received_on: "2026-05-02", version_count: 1 });

    const e = await createSoftCopy(as.staff, officeId, { client_id: clientA, doc_type_id: t.bank, period_id: p.apr, received_on: "2026-05-02" });
    await mustReview(as.staff, e.id);
    const o2 = await uploadObject(officeId, "pdf", e.id);
    expect((await as.staff.rpc("add_document_version", { p_document_id: e.id, p_file: { storage_path: o2.path, file_name: "f.pdf" }, p_received_on: "2026-05-20" })).error).toBeNull();
    expect(await documentRow(e.id)).toMatchObject({ status: "received", received_on: "2026-05-02" });
  });

  it("changing client, type, period or registration resets the review; remark, channel or received-by edits don't", async () => {
    for (const patch of [{ client_id: clientB }, { doc_type_id: t.form16, period_id: p.fy }, { period_id: p.may }]) {
      const d = await filed();
      await mustReview(as.staff, d.id);
      expect((await as.staff.rpc("update_document", { p_id: d.id, p: patch })).error).toBeNull();
      expect(await documentRow(d.id)).toMatchObject({ status: "received", reviewed_by: null });
      expect((await reviewHistory(d.id)).at(-1)?.outcome).toBe("reset");
      expect((await activityFor(officeId, d.id)).at(-1)?.data).toMatchObject({ review_reset: true });
    }
    const d = await filed();
    await mustReview(as.staff, d.id, "needs_correction", "Unsigned");
    for (const patch of [{ remark: "Called client" }, { channel: "courier" }, { received_by: u.manager.id }, { received_on: "2026-05-03" }]) {
      expect((await as.staff.rpc("update_document", { p_id: d.id, p: patch })).error).toBeNull();
    }
    expect(await documentRow(d.id)).toMatchObject({ status: "needs_correction", correction_reason: "Unsigned" });
    expect((await activityFor(officeId, d.id)).some((a) => a.data?.review_reset)).toBe(false);
  });

  it("a document still To review gets no reset row", async () => {
    const d = await filed();
    expect((await as.staff.rpc("update_document", { p_id: d.id, p: { period_id: p.may } })).error).toBeNull();
    expect(await reviewHistory(d.id)).toEqual([]);
  });
});

// ── Dispatch (AC-8 … AC-11) ───────────────────────────────────────────────────
describe("dispatch packets (AC-8, AC-9)", () => {
  let o1: string, o2: string, o3: string, soft: string, toReview: string, onB: string, archived: string, hard: string;
  beforeAll(async () => {
    const base = { client_id: clientA, doc_type_id: t.bank, period_id: p.apr, received_on: "2026-05-02" };
    o1 = (await mustCreateOriginal(as.staff, base, as.staff)).id;
    o2 = (await mustCreateOriginal(as.staff, { ...base, received_on: "2026-05-10" }, as.staff)).id;
    o3 = (await mustCreateOriginal(as.staff, base)).id;
    await mustReview(as.staff, o3, "needs_correction", "Wrong year"); // a wrong original still goes back (intent Q1)
    soft = (await createSoftCopy(as.staff, officeId, base)).id;
    await mustReview(as.staff, soft);
    hard = (await mustCreateDocument(as.staff, { ...base, received_as: "hard_copy" })).id;
    await mustReview(as.staff, hard);
    toReview = (await mustCreateOriginal(as.staff, base)).id;
    onB = (await mustCreateOriginal(as.staff, { ...base, client_id: clientB }, as.staff)).id;
    archived = (await mustCreateOriginal(as.staff, base, as.staff)).id;
    expect((await as.manager.rpc("archive_document", { p_id: archived, p_reason: "Duplicate" })).error).toBeNull();
  }, 120_000);

  it("one packet holds several ready originals of one client, with its details; a Needs-correction original can go", async () => {
    const { id } = await mustDispatch(as.limited, {
      client_id: clientA, document_ids: [o1, o3], dispatched_on: "2026-05-12", method: "courier",
      courier_name: "Blue Dart", tracking_no: "BD123456", recipient_name: "  R. Kumar (accountant)  ",
    });
    for (const d of [o1, o3]) {
      const item = await liveDispatchItem(d);
      expect(item?.dispatch).toMatchObject({ id, client_id: clientA, dispatched_on: "2026-05-12", method: "courier", courier_name: "Blue Dart",
        tracking_no: "BD123456", recipient_name: "R. Kumar (accountant)", created_by: u.limited.id });
    }
    expect(await statusOf(o3)).toBe("needs_correction"); // dispatch is a separate dimension
  });

  it("only classified, live, reviewed-or-needs-correction, not-yet-dispatched originals of the packet's client — else nothing is saved", async () => {
    for (const bad of [soft, hard, toReview, onB, archived, o1 /* already in a packet */]) {
      const r = await createDispatch(as.staff, { client_id: clientA, document_ids: [o2, bad], dispatched_on: "2026-05-12" });
      expect(r.error?.message ?? "").toMatch(/NOT_ELIGIBLE|ALREADY_DISPATCHED|NOT_FOUND/);
      expect(await liveDispatchItem(o2)).toBeNull();
    }
    expect((await createDispatch(as.staff, { client_id: clientA, document_ids: [], dispatched_on: "2026-05-12" })).error?.message ?? "").toMatch(/NO_DOCUMENTS/);
  });

  it("the date is required, not in the future, and not before any ticked document was received", async () => {
    expect((await createDispatch(as.staff, { client_id: clientA, document_ids: [o2], dispatched_on: addDays(today(), 1) })).error?.message ?? "").toMatch(/DATE_FUTURE/);
    expect((await createDispatch(as.staff, { client_id: clientA, document_ids: [o2], dispatched_on: "2026-05-09" })).error?.message ?? "").toMatch(/DATE_BEFORE_RECEIVED/);
    const r = await as.staff.rpc("create_dispatch", { p: { client_id: clientA, document_ids: [o2], method: "hand_delivery", recipient_name: "X" } });
    expect(r.error?.message ?? "").toMatch(/DATE_REQUIRED/);
    expect(await liveDispatchItem(o2)).toBeNull();
  });

  it("recipient is required (≤ 120); courier ≤ 100 and tracking ≤ 60; the method is one of four", async () => {
    for (const recipient_name of ["", "   ", "x".repeat(121)]) {
      expect((await createDispatch(as.staff, { client_id: clientA, document_ids: [o2], dispatched_on: "2026-05-12", recipient_name })).error?.message ?? "").toMatch(/RECIPIENT_REQUIRED/);
    }
    expect((await createDispatch(as.staff, { client_id: clientA, document_ids: [o2], dispatched_on: "2026-05-12", method: "courier", courier_name: "x".repeat(101) })).error).not.toBeNull();
    expect((await createDispatch(as.staff, { client_id: clientA, document_ids: [o2], dispatched_on: "2026-05-12", method: "courier", tracking_no: "x".repeat(61) })).error).not.toBeNull();
    expect((await createDispatch(as.staff, { client_id: clientA, document_ids: [o2], dispatched_on: "2026-05-12", method: "email" as "other" })).error).not.toBeNull();
    expect(await liveDispatchItem(o2)).toBeNull();
  });

  it("courier details are kept only for Courier", async () => {
    await mustDispatch(as.staff, { client_id: clientA, document_ids: [o2], dispatched_on: "2026-05-12", method: "client_collected", courier_name: "Blue Dart", tracking_no: "BD1" });
    expect((await liveDispatchItem(o2))?.dispatch).toMatchObject({ method: "client_collected", courier_name: null, tracking_no: null });
  });

  it("an archived client's originals can still be dispatched", async () => {
    // 12 (spec AC-9): originals are stored as returnable hard copies.
    const { data: docs } = await adminClient().from("document").select("id").eq("client_id", clientC).eq("returnable", true);
    const o = docs![0].id as string;
    expect(await statusOf(o)).toBe("reviewed");
    expect((await createDispatch(as.staff, { client_id: clientC, document_ids: [o], dispatched_on: "2026-05-12" })).error).toBeNull();
  });

  it("Limited can't dispatch for a client it can't see", async () => {
    const r = await createDispatch(as.limited, { client_id: clientB, document_ids: [onB], dispatched_on: "2026-05-12" });
    expect(r.error?.message ?? "").toMatch(/NOT_ELIGIBLE|NOT_FOUND/);
    expect(await liveDispatchItem(onB)).toBeNull();
  });
});

describe("undo dispatch (AC-10)", () => {
  it("Admin/Manager remove one document from its packet with a reason; the packet keeps its history; the original can go again", async () => {
    const base = { client_id: clientA, doc_type_id: t.bank, period_id: p.apr, received_on: "2026-05-02" };
    const a = (await mustCreateOriginal(as.staff, base, as.staff)).id;
    const b = (await mustCreateOriginal(as.staff, base, as.staff)).id;
    const { id } = await mustDispatch(as.staff, { client_id: clientA, document_ids: [a, b], dispatched_on: "2026-05-12" });
    for (const k of ["staff", "limited"] as const) {
      expect((await as[k].rpc("undo_dispatch_item", { p_document_id: a, p_reason: "Still with us" })).error?.message ?? "").toMatch(/ROLE_REQUIRED/);
    }
    expect((await as.manager.rpc("undo_dispatch_item", { p_document_id: a, p_reason: "" })).error?.message ?? "").toMatch(/REASON_REQUIRED/);
    expect((await as.manager.rpc("undo_dispatch_item", { p_document_id: a, p_reason: "Courier returned it" })).error).toBeNull();
    expect(await liveDispatchItem(a)).toBeNull();
    const { data: items } = await adminClient().from("dispatch_item").select("document_id, removed_at, removed_by, removed_reason").eq("dispatch_id", id);
    expect(items).toHaveLength(2);
    expect(items!.find((i) => i.document_id === a)).toMatchObject({ removed_by: u.manager.id, removed_reason: "Courier returned it" });
    expect(items!.find((i) => i.document_id === b)?.removed_at).toBeNull();
    expect((await as.manager.rpc("undo_dispatch_item", { p_document_id: a, p_reason: "again" })).error?.message ?? "").toMatch(/NOT_DISPATCHED/);
    expect((await createDispatch(as.staff, { client_id: clientA, document_ids: [a], dispatched_on: "2026-05-14" })).error).toBeNull();
  });
});

describe("a dispatched original keeps its client and stays an original (PR #25 review, Raja 2026-10-01)", () => {
  it("changing client or received as is refused while it is in a live packet; other edits and undo-then-change work", async () => {
    const base = { client_id: clientA, doc_type_id: t.bank, period_id: p.apr, received_on: "2026-05-02" };
    const d = (await mustCreateOriginal(as.staff, base, as.staff)).id;
    await mustDispatch(as.staff, { client_id: clientA, document_ids: [d], dispatched_on: "2026-05-12" });
    for (const patch of [{ client_id: clientB }, { received_as: "hard_copy" }]) {
      const r = await as.staff.rpc("update_document", { p_id: d, p: patch });
      expect(r.error?.message ?? "").toMatch(/DISPATCHED/);
    }
    expect(await documentRow(d)).toMatchObject({ client_id: clientA, received_as: "hard_copy", returnable: true }); // 12 (AC-9/12)
    expect((await as.staff.rpc("update_document", { p_id: d, p: { remark: "Sent with covering letter" } })).error).toBeNull();
    expect((await as.manager.rpc("undo_dispatch_item", { p_document_id: d, p_reason: "Wrong client" })).error).toBeNull();
    expect((await as.staff.rpc("update_document", { p_id: d, p: { client_id: clientB } })).error).toBeNull();
  });
});

describe("packets: visibility and no app write path (AC-15)", () => {
  it("packets and items follow the client's visibility", async () => {
    const b = (await mustCreateOriginal(as.staff, { client_id: clientB, doc_type_id: t.bank, period_id: p.apr, received_on: "2026-05-02" }, as.staff)).id;
    const { id } = await mustDispatch(as.staff, { client_id: clientB, document_ids: [b], dispatched_on: "2026-05-12" });
    expect((await as.staff.from("dispatch").select("id").eq("id", id)).data).toHaveLength(1);
    expect((await as.limited.from("dispatch").select("id").eq("id", id)).data).toEqual([]);
    expect((await as.limited.from("dispatch_item").select("id").eq("dispatch_id", id)).data).toEqual([]);
    expect((await as.outsider.from("dispatch").select("id").eq("id", id)).data).toEqual([]);
  });

  it("users can't insert, update or delete packets or items directly; nobody deletes them", async () => {
    const a = (await mustCreateOriginal(as.staff, { client_id: clientA, doc_type_id: t.bank, period_id: p.apr, received_on: "2026-05-02" }, as.staff)).id;
    const { id } = await mustDispatch(as.staff, { client_id: clientA, document_ids: [a], dispatched_on: "2026-05-12" });
    const ins = await as.admin.from("dispatch").insert({ office_id: officeId, client_id: clientA, dispatched_on: "2026-05-12", method: "other", recipient_name: "X", created_by: u.admin.id });
    expect(ins.error?.message ?? "").toMatch(DENIED);
    const insItem = await as.admin.from("dispatch_item").insert({ office_id: officeId, dispatch_id: id, document_id: a });
    expect(insItem.error?.message ?? "").toMatch(DENIED);
    const upd = await as.admin.from("dispatch_item").update({ removed_at: new Date().toISOString(), removed_reason: "x" }).eq("document_id", a).select("id");
    expect(upd.error !== null || (upd.data ?? []).length === 0).toBe(true);
    const upd2 = await as.admin.from("dispatch").update({ recipient_name: "Changed" }).eq("id", id).select("id");
    expect(upd2.error !== null || (upd2.data ?? []).length === 0).toBe(true);
    expect((await adminClient().from("dispatch_item").delete().eq("dispatch_id", id)).error).not.toBeNull();
    expect((await adminClient().from("dispatch").delete().eq("id", id)).error).not.toBeNull();
    expect((await liveDispatchItem(a))?.dispatch.recipient_name).toBe("Test recipient");
  });
});

// ── Activity (AC-16) ───────────────────────────────────────────────────────────
describe("activity (AC-16)", () => {
  it("one row per action, IDs and codes only — no reason, recipient, courier or tracking text", async () => {
    const d = (await mustCreateOriginal(as.staff, { client_id: clientA, doc_type_id: t.bank, period_id: p.apr, received_on: "2026-05-02" })).id;
    await mustReview(as.staff, d, "needs_correction", "Zqreason one");
    await mustReview(as.staff, d);
    expect((await undoReview(as.manager, d, "Zqreason two")).error).toBeNull();
    await mustReview(as.staff, d);
    const { id } = await mustDispatch(as.staff, { client_id: clientA, document_ids: [d], dispatched_on: "2026-05-12", method: "courier",
      courier_name: "Zqcourier", tracking_no: "ZQTRACK1", recipient_name: "Zqrecipient" });
    expect((await as.admin.rpc("undo_dispatch_item", { p_document_id: d, p_reason: "Zqreason three" })).error).toBeNull();

    const docActs = (await activityFor(officeId, d)).map((a) => a.action);
    expect(docActs).toEqual(["document.added", "document.needs_correction", "document.reviewed", "document.review_undone", "document.reviewed"]);
    const packetActs = await activityFor(officeId, id);
    expect(packetActs.map((a) => a.action)).toEqual(["dispatch.created", "dispatch.item_removed"]);
    expect(packetActs[0].data).toMatchObject({ client_id: clientA, document_ids: [d], method: "courier" });
    expect(packetActs[1].data).toMatchObject({ document_id: d });
    const { data: all } = await adminClient().from("activity").select("data").eq("office_id", officeId);
    expect(JSON.stringify(all)).not.toMatch(/zqreason|zqcourier|zqtrack|zqrecipient/i);
  });
});

// ── Search (AC-14) ────────────────────────────────────────────────────────────
describe("/documents search: Status values and the Return filter (AC-14)", () => {
  let clientS: string;
  const ids = {} as Record<"toReview" | "reviewed" | "fix" | "ready" | "readyFix" | "sent" | "softReviewed", string>;
  type Row = { id: string; status: string; reviewed_at: string | null; reviewed_by_name: string | null; correction_reason: string | null;
    dispatched_on: string | null; dispatch_method: string | null; return_state: string | null; client_id: string | null;
    doc_type_id: string | null; received_as: string; archived_at: string | null };
  const search = async (filters: Record<string, unknown>) => {
    const { data, error } = await as.staff.rpc("search_documents", { p: { filters: { client_id: clientS, ...filters } } });
    if (error) throw new Error(error.message);
    return data as { total: number; rows: Row[] };
  };
  const facets = async (filters: Record<string, unknown>) => {
    const { data, error } = await as.staff.rpc("search_document_facets", { p: { filters: { client_id: clientS, ...filters } } });
    if (error) throw new Error(error.message);
    return data as Array<{ facet: string; value: string; label: string; n: number }>;
  };
  beforeAll(async () => {
    clientS = (await mustInsertClient(as.staff, officeId, { name: "Review search", client_type: "individual", incharge_id: u.staff.id })).id;
    const base = { client_id: clientS, doc_type_id: t.bank, period_id: p.apr, received_on: "2026-05-02" };
    ids.toReview = (await mustCreateDocument(as.staff, base)).id;
    ids.reviewed = (await mustCreateDocument(as.staff, base)).id;
    await mustReview(as.staff, ids.reviewed);
    ids.fix = (await mustCreateDocument(as.staff, base)).id;
    await mustReview(as.staff, ids.fix, "needs_correction", "Blurred");
    ids.ready = (await mustCreateOriginal(as.staff, base, as.staff)).id;
    ids.readyFix = (await mustCreateOriginal(as.staff, base)).id;
    await mustReview(as.staff, ids.readyFix, "needs_correction", "Wrong year");
    ids.sent = (await mustCreateOriginal(as.staff, base, as.staff)).id;
    await mustDispatch(as.staff, { client_id: clientS, document_ids: [ids.sent], dispatched_on: "2026-05-12", method: "courier" });
    ids.softReviewed = (await createSoftCopy(as.staff, officeId, base)).id;
    await mustReview(as.staff, ids.softReviewed);
  }, 120_000);

  it("Status filters on To review (received), Reviewed and Needs correction", async () => {
    const set = async (status: string) => (await search({ status })).rows.map((r) => r.id).sort();
    expect(await set("received")).toEqual([ids.toReview].sort());
    expect(await set("reviewed")).toEqual([ids.reviewed, ids.ready, ids.sent, ids.softReviewed].sort());
    expect(await set("needs_correction")).toEqual([ids.fix, ids.readyFix].sort());
  });

  it("Return = ready lists originals waiting to go back; Return = dispatched lists those sent", async () => {
    expect((await search({ return: "ready" })).rows.map((r) => r.id).sort()).toEqual([ids.ready, ids.readyFix].sort());
    expect((await search({ return: "dispatched" })).rows.map((r) => r.id)).toEqual([ids.sent]);
    await expect(search({ return: "lost" })).rejects.toThrow(/INVALID_FILTER/);
  });

  it("rows carry the fields the shown state needs", async () => {
    const rows = (await search({})).rows;
    expect(rows.find((r) => r.id === ids.reviewed)).toMatchObject({ status: "reviewed", reviewed_by_name: "Test rd-staff", dispatched_on: null });
    expect(rows.find((r) => r.id === ids.reviewed)?.reviewed_at).not.toBeNull();
    expect(rows.find((r) => r.id === ids.fix)).toMatchObject({ status: "needs_correction", correction_reason: "Blurred" });
    expect(rows.find((r) => r.id === ids.sent)).toMatchObject({ dispatched_on: "2026-05-12", dispatch_method: "courier" });
  });

  it("status and return facets count exactly what the filters return", async () => {
    const f = await facets({});
    for (const status of ["received", "reviewed", "needs_correction"]) {
      expect(f.find((x) => x.facet === "status" && x.value === status)?.n ?? 0).toBe((await search({ status })).total);
    }
    for (const ret of ["ready", "dispatched"]) {
      expect(f.find((x) => x.facet === "return" && x.value === ret)?.n ?? 0).toBe((await search({ return: ret })).total);
    }
    // A facet ignores its own filter but honours the others.
    const withReturn = await facets({ return: "ready" });
    expect(withReturn.find((x) => x.facet === "status" && x.value === "needs_correction")?.n).toBe(1);
    expect(withReturn.find((x) => x.facet === "return" && x.value === "dispatched")?.n).toBe(1);
  });

  it("the TS shown state (documentState) selects the same rows as the SQL: to review, ready, dispatched", async () => {
    const rows = (await search({})).rows;
    expect(rows.length).toBe(Object.keys(ids).length);
    for (const r of rows) {
      const d = { archived: r.archived_at !== null, clientId: r.client_id, docTypeId: r.doc_type_id, receivedAs: r.received_as,
        status: r.status, reviewedAt: r.reviewed_at, reviewedByName: r.reviewed_by_name, correctionReason: r.correction_reason,
        dispatchedOn: r.dispatched_on, dispatchMethod: r.dispatch_method };
      expect(isReadyToDispatch(d), r.id).toBe(r.return_state === "ready");
      expect(documentState(d, "2026-10-01").kind === "dispatched", r.id).toBe(r.return_state === "dispatched");
      expect(isToReview(d), r.id).toBe(r.status === "received");
    }
  });
});
