import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { groupId, mustInsertClient } from "../support/catalogue";
import {
  createDocumentOffice, createSoftCopy, documentRow, mustCreateDocument, mustReview, periodId, typeId, undoReview, uploadObject,
} from "../support/documents";
import { T, expectedItem, generateAsOf, planRow } from "../support/expected";

// Feature 07 × 04 — metric honesty (spec "Counts as received for 04", AC-2 … AC-4). Written before the migrations
// (plan step 1). A linked document counts towards its expected item only if it is not archived and not Needs
// correction. Contract: tests/support/documents.ts ("Feature 07") and tests/support/expected.ts.
//
// Fixture: one client, Banking with only the monthly Bank statement (asked +1/1, overdue from +1/7);
// office clock 15 Jul 2026, so items Mar–Jun 2026 exist.

type Who = "admin" | "manager" | "staff";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
let client: string;
let bank: string;

const bankDoc = async (period: string, receivedOn: string) =>
  mustCreateDocument(as.staff, { client_id: client, doc_type_id: bank, period_id: await periodId(officeId, period), received_on: receivedOn });
const item = (period: string) => expectedItem(client, T.bank, period);
const metric = async () => {
  const { data, error } = await as.admin.rpc("collection_metric", { p_from: "2026-04-01", p_to: "2026-07-15" });
  if (error) throw new Error(error.message);
  return data as { due: number; on_time: number; late: number; missing: number };
};

beforeAll(async () => {
  officeId = await createDocumentOffice("review-metric");
  u.admin = await createStaff(officeId, "rvm-admin", "admin");
  u.manager = await createStaff(officeId, "rvm-manager", "manager");
  u.staff = await createStaff(officeId, "rvm-staff", "staff");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  await generateAsOf(as.admin, "2026-03-15");
  client = (await mustInsertClient(as.staff, officeId, { name: "Review metric", client_type: "individual", incharge_id: u.staff.id })).id;
  const { error } = await as.staff.rpc("enable_client_group", { p_client_id: client, p_doc_group_id: await groupId(officeId, "Banking") });
  if (error) throw new Error(error.message);
  for (const n of ["Loan statement / interest certificate", "Bank balance confirmation", "FD / interest certificates"]) {
    const row = await planRow(client, n);
    const { error: e } = await as.staff.from("client_doc_type").update({ state: "removed" }).eq("id", row.id);
    if (e) throw e;
  }
  await generateAsOf(as.admin, "2026-07-15");
  bank = await typeId(officeId, T.bank);
}, 120_000);

afterAll(async () => {
  await retireStaff([u.manager, u.staff].filter(Boolean).map((x) => x.id));
  if (u.admin) await retireStaff([u.admin.id]);
});

describe("Needs correction doesn't count as received (AC-2, AC-3)", () => {
  it("correction → the item goes back to pending; marked reviewed → received again with the document's date", async () => {
    const d = await bankDoc("2026-03", "2026-04-03");
    expect(await item("2026-03")).toMatchObject({ status: "received", received_on: "2026-04-03", completed_by_document_id: d.id });
    await mustReview(as.staff, d.id, "needs_correction", "Wrong account");
    expect(await item("2026-03")).toMatchObject({ status: "pending", received_on: null, completed_by_document_id: null });
    expect((await documentRow(d.id)).expected_doc_id).toBe((await item("2026-03")).id); // still linked, just not counting
    await mustReview(as.staff, d.id);
    expect(await item("2026-03")).toMatchObject({ status: "received", received_on: "2026-04-03", completed_by_document_id: d.id });
  });

  it("undoing a correction (Admin/Manager) makes the document count again", async () => {
    const d = await bankDoc("2026-04", "2026-05-03");
    await mustReview(as.staff, d.id, "needs_correction", "Unsigned");
    expect((await item("2026-04")).status).toBe("pending");
    expect((await undoReview(as.manager, d.id, "It was signed")).error).toBeNull();
    expect(await item("2026-04")).toMatchObject({ status: "received", received_on: "2026-05-03" });
  });

  it("another linked document keeps the item received, with its own date", async () => {
    const first = await bankDoc("2026-05", "2026-06-02");
    const second = await bankDoc("2026-05", "2026-06-04");
    expect(await item("2026-05")).toMatchObject({ status: "received", completed_by_document_id: first.id });
    await mustReview(as.staff, first.id, "needs_correction", "Wrong period");
    expect(await item("2026-05")).toMatchObject({ status: "received", received_on: "2026-06-04", completed_by_document_id: second.id });
    expect((await documentRow(second.id)).status).toBe("received"); // To review still counts
  });

  it("a corrected version counts from the corrected file's date (metric 1 uses when the correct file arrived)", async () => {
    const d = await createSoftCopy(as.staff, officeId, { client_id: client, doc_type_id: bank, period_id: await periodId(officeId, "2026-06"), received_on: "2026-07-02" });
    expect(await item("2026-06")).toMatchObject({ status: "received", received_on: "2026-07-02" });
    await mustReview(as.staff, d.id, "needs_correction", "Wrong account");
    expect((await item("2026-06")).status).toBe("pending");
    expect(await metric()).toMatchObject({ missing: 1 }); // June is overdue from 7 Jul, its only file needs correction

    const obj = await uploadObject(officeId, "pdf", d.id);
    const r = await as.staff.rpc("add_document_version", { p_document_id: d.id, p_file: { storage_path: obj.path, file_name: "right.pdf" }, p_received_on: "2026-07-10" });
    expect(r.error).toBeNull();
    expect(await documentRow(d.id)).toMatchObject({ status: "received", received_on: "2026-07-10" });
    expect(await item("2026-06")).toMatchObject({ status: "received", received_on: "2026-07-10", completed_by_document_id: d.id });
    expect(await metric()).toMatchObject({ missing: 0 });
  });

  it("moving a Needs-correction document to another period resets it, so it counts there", async () => {
    const d = await bankDoc("2026-04", "2026-05-04");
    await mustReview(as.staff, d.id, "needs_correction", "This is March's statement");
    const mar = await item("2026-03");
    expect((await as.staff.rpc("update_document", { p_id: d.id, p: { period_id: await periodId(officeId, "2026-03") } })).error).toBeNull();
    expect(await documentRow(d.id)).toMatchObject({ status: "received", expected_doc_id: mar.id });
    expect((await item("2026-03")).status).toBe("received");
  });
});
