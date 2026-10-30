import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { mustInsertClient } from "../support/catalogue";
import {
  activityFor, createDocumentOffice, documentRow, mustCreateDocument, mustReview, periodId, reviewHistory, typeId, undoReview,
} from "../support/documents";
import { T } from "../support/expected";

// Feature 12 — Needs correction kinds and Staff undo (spec AC-21 … AC-24; AC-23 as amended by plan R1).
// Written before migration B (plan step 1). Contract:
//   review_document(p_id, p_outcome, p_reason, p_kind text default null)  p_kind = 'file' | 'details' (needs_correction only)
//   document.correction_kind, document_review.correction_kind
//   Wrong details: a change to client/type/period/registration/received as/returnable/received on/handed over by → To review.
//   Wrong file: only a new version resets (07). Remark, channel, received-by never reset a Needs-correction document.
//   undo_review: Staff, Manager, Admin; Limited refused. Undo dispatch unchanged (Admin/Manager).

type Who = "manager" | "staff" | "limited";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
let client: string, bank: string, apr: string, may: string;

const filed = (extra: Record<string, unknown> = {}) =>
  mustCreateDocument(as.staff, { client_id: client, doc_type_id: bank, period_id: apr, received_on: "2026-05-02", ...extra } as never);
const correct = async (id: string, kind: "file" | "details" | null, reason = "Wrong month") => {
  const { error } = await as.staff.rpc("review_document", { p_id: id, p_outcome: "needs_correction", p_reason: reason, p_kind: kind });
  if (error) throw new Error(error.message);
};
const update = (id: string, p: Record<string, unknown>) => as.staff.rpc("update_document", { p_id: id, p });

beforeAll(async () => {
  officeId = await createDocumentOffice("correction-kind");
  u.manager = await createStaff(officeId, "ck-manager", "manager");
  u.staff = await createStaff(officeId, "ck-staff", "staff");
  u.limited = await createStaff(officeId, "ck-limited", "limited");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  // Limited is the incharge, so Limited can see (and try to undo on) this client.
  client = (await mustInsertClient(as.staff, officeId, { name: "Correction client", client_type: "individual", incharge_id: u.limited.id })).id;
  bank = await typeId(officeId, T.bank);
  apr = await periodId(officeId, "2026-04");
  may = await periodId(officeId, "2026-05");
}, 120_000);

afterAll(async () => {
  await retireStaff([u.manager, u.staff, u.limited].filter(Boolean).map((x) => x.id));
});

describe("kind is stored (AC-21)", () => {
  it("Needs correction keeps the kind on the document and in its history", async () => {
    const d = await filed();
    await correct(d.id, "details");
    expect(await documentRow(d.id)).toMatchObject({ status: "needs_correction", correction_kind: "details", correction_reason: "Wrong month" });
    expect((await reviewHistory(d.id)).at(-1)).toMatchObject({ outcome: "needs_correction", correction_kind: "details" });
  });

  it("an unknown kind is refused; marking reviewed clears the kind", async () => {
    const d = await filed();
    const { error } = await as.staff.rpc("review_document", { p_id: d.id, p_outcome: "needs_correction", p_reason: "x", p_kind: "paper" });
    expect(error?.message ?? "").toMatch(/KIND_INVALID/);
    await correct(d.id, "file");
    await mustReview(as.staff, d.id);
    expect(await documentRow(d.id)).toMatchObject({ status: "reviewed", correction_kind: null });
  });

  it("an older caller without p_kind still works (no kind stored)", async () => {
    const d = await filed();
    await mustReview(as.staff, d.id, "needs_correction", "Unsigned");
    expect(await documentRow(d.id)).toMatchObject({ status: "needs_correction", correction_kind: null });
  });
});

describe("what sends it back to To review (AC-23, plan R1)", () => {
  it("Wrong details: received on, received as / returnable and handed over by changes reset it", async () => {
    for (const patch of [
      { received_on: "2026-05-03" },
      { received_as: "hard_copy", returnable: true },
      { handed_over_kind: "courier", handed_over_name: "Blue Dart" },
      { period_id: may },
    ]) {
      const d = await filed();
      await correct(d.id, "details");
      expect((await update(d.id, patch)).error, JSON.stringify(patch)).toBeNull();
      expect(await documentRow(d.id), JSON.stringify(patch)).toMatchObject({ status: "received", correction_kind: null, correction_reason: null });
      expect((await reviewHistory(d.id)).at(-1)?.outcome).toBe("reset");
    }
  });

  it("Wrong details: a remark, channel or received-by change does not reset it", async () => {
    const d = await filed();
    await correct(d.id, "details", "Wrong period");
    for (const patch of [{ remark: "Called client for the right month" }, { channel: "courier" }, { received_by: u.manager.id }]) {
      expect((await update(d.id, patch)).error).toBeNull();
    }
    expect(await documentRow(d.id)).toMatchObject({ status: "needs_correction", correction_kind: "details" });
    expect((await activityFor(officeId, d.id)).some((a) => a.data?.review_reset)).toBe(false);
  });

  it("Wrong file: received on or remark changes don't reset it (only a new version does, as in 07)", async () => {
    const d = await filed();
    await correct(d.id, "file", "Unsigned copy");
    for (const patch of [{ received_on: "2026-05-04" }, { remark: "Asked for the signed copy" }]) {
      expect((await update(d.id, patch)).error).toBeNull();
    }
    expect(await documentRow(d.id)).toMatchObject({ status: "needs_correction", correction_kind: "file" });
  });
});

describe("undo review (AC-24)", () => {
  it("Staff and Manager can undo a review, with a reason; it goes back to To review", async () => {
    for (const k of ["staff", "manager"] as const) {
      const d = await filed();
      await mustReview(as.staff, d.id);
      expect((await undoReview(as[k], d.id, "Clicked by mistake")).error).toBeNull();
      expect(await documentRow(d.id)).toMatchObject({ status: "received" });
    }
  });

  it("Staff can undo a Needs correction too; the kind is cleared", async () => {
    const d = await filed();
    await correct(d.id, "details");
    expect((await undoReview(as.staff, d.id, "Wrong document")).error).toBeNull();
    expect(await documentRow(d.id)).toMatchObject({ status: "received", correction_kind: null });
  });

  it("Limited still can't undo a review, even on a client it can see", async () => {
    const d = await filed();
    await mustReview(as.staff, d.id);
    expect((await undoReview(as.limited, d.id, "Mistake")).error?.message ?? "").toMatch(/ROLE_REQUIRED/);
  });

  it("a reason is still required", async () => {
    const d = await filed();
    await mustReview(as.staff, d.id);
    expect((await undoReview(as.staff, d.id, "  ")).error?.message ?? "").toMatch(/REASON_REQUIRED/);
  });
});
