import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { mustInsertClient } from "../support/catalogue";
import { activityFor, createDocumentOffice, createSoftCopy, documentRow, mustCreateDocument, periodId, typeId } from "../support/documents";
import { T } from "../support/expected";

// Feature 12 — Handed over by (spec AC-14, AC-15 as amended by plan R2). Written before migration A (plan step 1).
// The database checks the SHAPE only: kind + name together (1–120), never on a soft copy, can't be cleared once set.
// "Required for a new hard copy" is checked by the server actions (tests/unit/handed-over-rules.test.ts), so existing
// callers that create hard copies without it keep working.

let officeId: string;
let staffU: { id: string; email: string };
let staff: SupabaseClient;
let client: string, bank: string, apr: string;
const NAME = "Ravi from Blue Dart";

const hard = (extra: Record<string, unknown> = {}) =>
  mustCreateDocument(staff, { client_id: client, doc_type_id: bank, period_id: apr, received_on: "2026-05-02", ...extra } as never);
const create = (p: Record<string, unknown>) =>
  staff.rpc("create_document", { p: { received_as: "hard_copy", channel: "courier", client_id: client, doc_type_id: bank, period_id: apr, ...p } });
const update = (id: string, p: Record<string, unknown>) => staff.rpc("update_document", { p_id: id, p });

beforeAll(async () => {
  officeId = await createDocumentOffice("handed-over");
  staffU = await createStaff(officeId, "ho-staff", "staff");
  staff = await signedInClient(staffU.email);
  client = (await mustInsertClient(staff, officeId, { name: "Handed over client", client_type: "individual", incharge_id: staffU.id })).id;
  bank = await typeId(officeId, T.bank);
  apr = await periodId(officeId, "2026-04");
}, 120_000);

afterAll(async () => { if (staffU) await retireStaff([staffU.id]); });

describe("shape (AC-14)", () => {
  it("a hard copy stores the kind and the name", async () => {
    const d = await hard({ handed_over_kind: "courier", handed_over_name: NAME });
    expect(await documentRow(d.id)).toMatchObject({ handed_over_kind: "courier", handed_over_name: NAME });
  });

  it("a hard copy without it is still accepted by the database (R2: the app requires it)", async () => {
    const d = await hard();
    expect(await documentRow(d.id)).toMatchObject({ handed_over_kind: null, handed_over_name: null });
  });

  it("kind and name go together; the name is 1–120 characters; the kind is one of four", async () => {
    expect((await create({ handed_over_kind: "courier" })).error?.message ?? "").toMatch(/HANDED_OVER/);
    expect((await create({ handed_over_name: NAME })).error?.message ?? "").toMatch(/HANDED_OVER/);
    expect((await create({ handed_over_kind: "other", handed_over_name: "x".repeat(121) })).error?.message ?? "").toMatch(/HANDED_OVER/);
    expect((await create({ handed_over_kind: "drone", handed_over_name: NAME })).error).not.toBeNull();
  });

  it("a soft copy never carries it", async () => {
    const s = await createSoftCopy(staff, officeId, { client_id: client, doc_type_id: bank, period_id: apr });
    expect((await update(s.id, { handed_over_kind: "courier", handed_over_name: NAME })).error?.message ?? "").toMatch(/HANDED_OVER/);
  });

  it("once set, it can be changed but not cleared", async () => {
    const d = await hard({ handed_over_kind: "courier", handed_over_name: NAME });
    expect((await update(d.id, { handed_over_kind: "security", handed_over_name: "Gate security" })).error).toBeNull();
    expect(await documentRow(d.id)).toMatchObject({ handed_over_kind: "security", handed_over_name: "Gate security" });
    expect((await update(d.id, { handed_over_kind: null, handed_over_name: null })).error?.message ?? "").toMatch(/HANDED_OVER_CLEAR/);
  });

  it("a hard copy recorded without it can have it added later", async () => {
    const d = await hard();
    expect((await update(d.id, { handed_over_kind: "client_staff", handed_over_name: "Accountant" })).error).toBeNull();
  });
});

describe("privacy (AC-15)", () => {
  it("the name never goes into activity: only that the field changed", async () => {
    const d = await hard({ handed_over_kind: "courier", handed_over_name: NAME });
    expect((await update(d.id, { handed_over_kind: "other", handed_over_name: "Neighbour Lakshmi" })).error).toBeNull();
    const rows = await activityFor(officeId, d.id);
    const text = JSON.stringify(rows);
    expect(text).not.toContain("Ravi");
    expect(text).not.toContain("Lakshmi");
  });
});
