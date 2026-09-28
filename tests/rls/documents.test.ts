import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { DENIED, createCatalogueOffice, mustInsertClient } from "../support/catalogue";
import { testGstin, testPan, testTan } from "../support/test-data";
import {
  activityFor, createDocument, createDocumentOffice, createSoftCopy, currentFyYY, documentRow, mustCreateDocument,
  parseDocCode, periodId, typeId, uploadObject,
} from "../support/documents";

// Feature 03 — documents, DOC-IDs, versions, archive and visibility enforced by the database
// (spec AC-1, AC-4, AC-6, AC-8, AC-9, AC-11, AC-12, AC-14, AC-17). Written before the migration (plan step 1).
//
// Contract under test (plan step 2 implements it):
//   create_document(p jsonb) → { id, doc_code }       keys: client_id, doc_type_id, period_id, registration_id,
//                                                      received_as, channel, received_on, remark,
//                                                      file { storage_path, file_name }, test_added_at (test offices only)
//   add_document_version(p_document_id uuid, p_file jsonb) → { version_id, version_no }
//   update_document(p_id uuid, p jsonb)                → void (only the keys present change)
//   archive_document(p_id uuid, p_reason text) / unarchive_document(p_id uuid)
// The file's size and MIME type are read from Storage by the database, never taken from the caller.

type Who = "admin" | "manager" | "staff" | "limited" | "outsider";
let officeId: string;
let otherOfficeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
let clientA: string; // Limited is incharge → Limited can see it
let clientB: string; // Staff is incharge → Limited cannot see it
let otherClient: string; // another office
const t = {} as Record<"sales" | "form16" | "form16a" | "salaryTds" | "notice", string>;
const p = {} as Record<"month" | "quarter" | "year" | "otherMonth", string>;
const reg = {} as Record<"gstin" | "gstinInactive" | "tan" | "gstinB", string>;
const yy = currentFyYY();
const DENIED_OR_NOT_FOUND = new RegExp(`${DENIED.source}|NOT_FOUND`, "i");

beforeAll(async () => {
  officeId = await createDocumentOffice("docs");
  otherOfficeId = await createDocumentOffice("docs-other");
  u.admin = await createStaff(officeId, "docs-admin", "admin");
  u.manager = await createStaff(officeId, "docs-manager", "manager");
  u.staff = await createStaff(officeId, "docs-staff", "staff");
  u.limited = await createStaff(officeId, "docs-limited", "limited");
  u.outsider = await createStaff(otherOfficeId, "docs-outsider", "admin");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);

  clientA = (await mustInsertClient(as.staff, officeId, { name: "Docs client A", client_type: "proprietorship", incharge_id: u.limited.id, pan: testPan("P", 3101) })).id;
  clientB = (await mustInsertClient(as.staff, officeId, { name: "Docs client B", client_type: "proprietorship", incharge_id: u.staff.id, pan: testPan("P", 3102) })).id;
  otherClient = (await mustInsertClient(as.outsider, otherOfficeId, { name: "Other office client", client_type: "individual", incharge_id: u.outsider.id })).id;

  const addReg = async (client: string, kind: "gstin" | "tan", number: string) => {
    const { data, error } = await as.staff.from("client_registration").insert({ office_id: officeId, client_id: client, kind, number }).select("id").single();
    if (error) throw error;
    return data.id as string;
  };
  reg.gstin = await addReg(clientA, "gstin", testGstin(testPan("P", 3101), "33", 1));
  reg.gstinInactive = await addReg(clientA, "gstin", testGstin(testPan("P", 3101), "29", 2));
  await as.staff.from("client_registration").update({ active: false }).eq("id", reg.gstinInactive);
  reg.tan = await addReg(clientA, "tan", testTan(3101));
  reg.gstinB = await addReg(clientB, "gstin", testGstin(testPan("P", 3102), "33", 1));

  t.sales = await typeId(officeId, "Sales invoices / sales register"); // month, GSTIN
  t.form16 = await typeId(officeId, "Form 16 from employer"); // year, no registration
  t.form16a = await typeId(officeId, "Form 16A from deductors"); // quarter
  t.salaryTds = await typeId(officeId, "Salary paid to employees (for TDS)"); // month, TAN
  t.notice = await typeId(officeId, "GST notice / order received");
  p.month = await periodId(officeId, "2026-08");
  p.quarter = await periodId(officeId, "2026-27-Q1");
  p.year = await periodId(officeId, "2026-27");
  p.otherMonth = await periodId(otherOfficeId, "2026-08");
});

afterAll(async () => {
  await retireStaff([u.manager, u.staff, u.limited].filter(Boolean).map((x) => x.id));
  await retireStaff([u.admin, u.outsider].filter(Boolean).map((x) => x.id));
});

// ── DOC-IDs (AC-4, AC-6) ─────────────────────────────────────────────────────
describe("DOC-IDs (AC-6)", () => {
  it("the first document of the FY in a freshly reset office is DOC-FY<yy-yy>-00001, stored with its FY code", async () => {
    const d = await mustCreateDocument(as.staff, {});
    expect(d.doc_code).toBe(`DOC-FY${yy}-00001`);
    const row = await documentRow(d.id);
    expect(row.fy_code).toMatch(new RegExp(`^20${yy}$`));
  });

  it("is consecutive per office and never shared with another office", async () => {
    const a = parseDocCode((await mustCreateDocument(as.staff, {})).doc_code);
    const b = parseDocCode((await mustCreateDocument(as.limited, {})).doc_code);
    expect(b.n).toBe(a.n + 1);
    const other = await mustCreateDocument(as.outsider, {});
    expect(other.doc_code).toBe(`DOC-FY${yy}-00001`); // the other office has its own counter
  });

  it("stays consecutive and unique under concurrent saves", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => mustCreateDocument(as.staff, {})));
    const ns = results.map((r) => parseDocCode(r.doc_code).n).sort((x, y) => x - y);
    expect(new Set(ns).size).toBe(8);
    expect(ns[7] - ns[0]).toBe(7);
  });

  it("a failed save leaves no gap (the counter rolls back with the insert)", async () => {
    const before = parseDocCode((await mustCreateDocument(as.staff, {})).doc_code).n;
    const taken = await createSoftCopy(as.staff, officeId); // consumes before + 1
    // Fails after the counter was incremented: the object path is already registered to another document.
    const dup = await createDocument(as.staff, { received_as: "soft_copy", file: { storage_path: taken.object.path, file_name: "again.pdf" } });
    expect(dup.error?.message ?? "").toMatch(/duplicate key|PATH|OBJECT/i);
    const bad = await createDocument(as.staff, { received_as: "soft_copy" }); // no file
    expect(bad.error).not.toBeNull();
    const next = parseDocCode((await mustCreateDocument(as.staff, {})).doc_code).n;
    expect(parseDocCode(taken.doc_code).n).toBe(before + 1);
    expect(next).toBe(before + 2);
  });

  it("YY is the FY of the date added in India time, and the counter restarts on 1 April (fixed dates)", async () => {
    const march31 = await mustCreateDocument(as.staff, { test_added_at: "2030-03-31T18:29:59Z" }); // 23:59:59 IST, FY 2029-30
    const april1 = await mustCreateDocument(as.staff, { test_added_at: "2030-03-31T18:30:00Z" }); // 00:00 IST 1 Apr, FY 2030-31
    const april2 = await mustCreateDocument(as.staff, { test_added_at: "2030-04-02T05:00:00Z" });
    expect(march31.doc_code).toBe("DOC-FY29-30-00001");
    expect(april1.doc_code).toBe("DOC-FY30-31-00001");
    expect(april2.doc_code).toBe("DOC-FY30-31-00002");
    expect((await documentRow(april1.id)).fy_code).toBe("2030-31");
  });

  it("grows past 99,999 without breaking", async () => {
    const { error } = await adminClient().from("doc_counter").insert({ office_id: officeId, fy_code: "2031-32", last: 99999 });
    expect(error).toBeNull();
    const d = await mustCreateDocument(as.staff, { test_added_at: "2031-06-01T05:00:00Z" });
    expect(d.doc_code).toBe("DOC-FY31-32-100000");
  });

  it("the fixed-date hook works only in test offices", async () => {
    const realLike = await createCatalogueOffice("docs-not-test", { isTest: false, reset: false });
    const outsiderReal = await createStaff(realLike, "docs-not-test-staff", "staff");
    const c = await signedInClient(outsiderReal.email);
    const { error } = await createDocument(c, { test_added_at: "2030-03-31T18:30:00Z" });
    expect(error?.message ?? "").toMatch(/TEST_ONLY/);
    await retireStaff([outsiderReal.id]);
  });

  it("DOC-ID, FY and office can never be changed", async () => {
    const d = await mustCreateDocument(as.staff, {});
    const r1 = await as.admin.from("document").update({ doc_code: "DOC-FY26-27-99999" }).eq("id", d.id);
    expect(r1.error?.message ?? "").toMatch(DENIED);
    const r2 = await as.admin.from("document").update({ fy_code: "2020-21" }).eq("id", d.id);
    expect(r2.error?.message ?? "").toMatch(DENIED);
    const r3 = await adminClient().from("document").update({ doc_code: "DOC-FY26-27-99999" }).eq("id", d.id);
    expect(r3.error?.message ?? "").toMatch(/IMMUTABLE/); // even the service role
    expect((await documentRow(d.id)).doc_code).toBe(d.doc_code);
  });

  it("a direct insert cannot choose its own DOC-ID", async () => {
    const { data, error } = await as.staff.from("document")
      .insert({ office_id: officeId, doc_code: "DOC-FY26-27-00042", received_as: "hard_copy", channel: "courier", received_on: "2026-08-01" })
      .select("doc_code").single();
    if (!error) expect(data!.doc_code).not.toBe("DOC-FY26-27-00042");
    else expect(error.message).toMatch(DENIED);
  });
});

// ── Add document rules (AC-1, AC-2, AC-4) ────────────────────────────────────
describe("add a document (AC-1, AC-2, AC-4)", () => {
  it("a hard copy or original may have no file; a soft copy must have one", async () => {
    const hard = await mustCreateDocument(as.staff, { received_as: "hard_copy", client_id: clientB, doc_type_id: t.form16 });
    const orig = await mustCreateDocument(as.staff, { received_as: "original" });
    expect((await documentRow(hard.id)).current_version_id).toBeNull();
    expect((await documentRow(orig.id)).version_count).toBe(0);
    const soft = await createDocument(as.staff, { received_as: "soft_copy", client_id: clientB, doc_type_id: t.form16 });
    expect(soft.error?.message ?? "").toMatch(/SOFT_COPY_NEEDS_FILE/);
  });

  it("a direct insert of a soft copy without a file is rejected at commit", async () => {
    const { error } = await as.staff.from("document")
      .insert({ office_id: officeId, received_as: "soft_copy", channel: "email", received_on: "2026-08-01" });
    expect(error?.message ?? "").toMatch(/SOFT_COPY_NEEDS_FILE|permission denied/);
  });

  it("a soft copy stores version 1 with size and type read from Storage, and the file becomes current", async () => {
    const d = await createSoftCopy(as.staff, officeId, { client_id: clientB, doc_type_id: t.form16, period_id: p.year });
    const row = await documentRow(d.id);
    expect(row.version_count).toBe(1);
    const { data: v } = await adminClient().from("document_version")
      .select("id, version_no, storage_path, file_name, mime_type, size_bytes, uploaded_by").eq("document_id", d.id).single();
    expect(v).toMatchObject({ version_no: 1, storage_path: d.object.path, file_name: "statement.pdf", mime_type: "application/pdf", size_bytes: d.object.size, uploaded_by: u.staff.id });
    expect(row.current_version_id).toBe(v!.id);
    expect(row.received_by).toBe(u.staff.id); // defaults to the person adding it
  });

  it("the object must exist in Storage", async () => {
    const path = `office/${officeId}/doc/${randomUUID()}/${randomUUID()}.pdf`;
    const { error } = await createDocument(as.staff, { received_as: "soft_copy", file: { storage_path: path, file_name: "ghost.pdf" } });
    expect(error?.message ?? "").toMatch(/OBJECT_MISSING/);
  });

  it("storage paths hold only this office's IDs and an allowed extension", async () => {
    const other = await uploadObject(otherOfficeId, "pdf");
    const cross = await createDocument(as.staff, { received_as: "soft_copy", file: { storage_path: other.path, file_name: "x.pdf" } });
    expect(cross.error?.message ?? "").toMatch(/PATH/);
    const named = await createDocument(as.staff, { received_as: "soft_copy", file: { storage_path: `office/${officeId}/doc/Ravi Traders/gst.pdf`, file_name: "x.pdf" } });
    expect(named.error?.message ?? "").toMatch(/PATH/);
    const exe = await createDocument(as.staff, { received_as: "soft_copy", file: { storage_path: `office/${officeId}/doc/${randomUUID()}/${randomUUID()}.exe`, file_name: "x.exe" } });
    expect(exe.error?.message ?? "").toMatch(/PATH|FILE_TYPE/);
  });

  it("file names are stored sanitised — no path separators, control characters or leading dots; ≤ 180 chars", async () => {
    for (const bad of ["../etc/passwd", "a\\b.pdf", ".hidden.pdf", "tab\there.pdf", "x".repeat(181) + ".pdf", ""]) {
      const obj = await uploadObject(officeId, "pdf");
      const { error } = await createDocument(as.staff, { received_as: "soft_copy", file: { storage_path: obj.path, file_name: bad } });
      expect(error?.message ?? "", bad).toMatch(/FILE_NAME|violates/);
    }
  });

  it("received on can't be in the future (India date); remark ≤ 500 characters", async () => {
    const future = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const r1 = await createDocument(as.staff, { received_on: future });
    expect(r1.error?.message ?? "").toMatch(/RECEIVED_ON/);
    const r2 = await createDocument(as.staff, { remark: "x".repeat(501) });
    expect(r2.error?.message ?? "").toMatch(/violates|REMARK/);
  });

  it("client + type = classified at once (Save to vault); anything less goes to the Inbox", async () => {
    const vault = await mustCreateDocument(as.staff, { client_id: clientB, doc_type_id: t.form16 });
    expect((await documentRow(vault.id)).classified_at).not.toBeNull();
    const clientOnly = await mustCreateDocument(as.staff, { client_id: clientB });
    const typeOnly = await mustCreateDocument(as.staff, { doc_type_id: t.form16 });
    expect((await documentRow(clientOnly.id)).classified_at).toBeNull();
    expect((await documentRow(typeOnly.id)).classified_at).toBeNull();
  });

  it("client, type, period and registration must belong to this office", async () => {
    const r1 = await createDocument(as.staff, { client_id: otherClient });
    expect(r1.error?.message ?? "").toMatch(/CLIENT_OFFICE|NOT_FOUND|violates/);
    const otherType = await typeId(otherOfficeId, "Form 16 from employer");
    const r2 = await createDocument(as.staff, { client_id: clientB, doc_type_id: otherType });
    expect(r2.error?.message ?? "").toMatch(/TYPE_OFFICE|NOT_FOUND|violates/);
    const r3 = await createDocument(as.staff, { client_id: clientA, doc_type_id: t.sales, period_id: p.otherMonth });
    expect(r3.error?.message ?? "").toMatch(/PERIOD_OFFICE/);
  });

  it("period kind must suit the type: month-types take month/quarter/year, quarter-types quarter/year, year-types year", async () => {
    for (const period of [p.month, p.quarter, p.year]) {
      const { error } = await createDocument(as.staff, { client_id: clientA, doc_type_id: t.sales, registration_id: reg.gstin, period_id: period });
      expect(error).toBeNull();
    }
    const q1 = await createDocument(as.staff, { client_id: clientA, doc_type_id: t.form16a, period_id: p.month });
    expect(q1.error?.message ?? "").toMatch(/PERIOD_KIND/);
    expect((await createDocument(as.staff, { client_id: clientA, doc_type_id: t.form16a, period_id: p.quarter })).error).toBeNull();
    const y1 = await createDocument(as.staff, { client_id: clientA, doc_type_id: t.form16, period_id: p.quarter });
    expect(y1.error?.message ?? "").toMatch(/PERIOD_KIND/);
    expect((await createDocument(as.staff, { client_id: clientA, doc_type_id: t.form16, period_id: null })).error).toBeNull(); // "Not needed"
  });

  it("a registration must be an active one of the client, of the type's kind (GST → GSTIN, TDS → TAN)", async () => {
    expect((await createDocument(as.staff, { client_id: clientA, doc_type_id: t.salaryTds, registration_id: reg.tan })).error).toBeNull();
    const wrongKind = await createDocument(as.staff, { client_id: clientA, doc_type_id: t.sales, registration_id: reg.tan });
    expect(wrongKind.error?.message ?? "").toMatch(/REGISTRATION/);
    const otherClients = await createDocument(as.staff, { client_id: clientA, doc_type_id: t.sales, registration_id: reg.gstinB });
    expect(otherClients.error?.message ?? "").toMatch(/REGISTRATION/);
    const inactive = await createDocument(as.staff, { client_id: clientA, doc_type_id: t.sales, registration_id: reg.gstinInactive });
    expect(inactive.error?.message ?? "").toMatch(/REGISTRATION/);
    const noKind = await createDocument(as.staff, { client_id: clientA, doc_type_id: t.form16, registration_id: reg.gstin });
    expect(noKind.error?.message ?? "").toMatch(/REGISTRATION/);
  });

  it("Limited users can add for clients they can see, or to the Inbox — not for other clients", async () => {
    expect((await createDocument(as.limited, { client_id: clientA, doc_type_id: t.form16 })).error).toBeNull();
    expect((await createDocument(as.limited, {})).error).toBeNull();
    const hidden = await createDocument(as.limited, { client_id: clientB, doc_type_id: t.form16 });
    expect(hidden.error?.message ?? "").toMatch(DENIED_OR_NOT_FOUND);
  });
});

// ── Classify and edit (AC-8, AC-11) ──────────────────────────────────────────
describe("classify and edit (AC-8, AC-11)", () => {
  it("assigning client + type leaves the Inbox and sets classified_at once — re-classifying keeps the first time", async () => {
    const d = await mustCreateDocument(as.staff, {});
    expect((await documentRow(d.id)).classified_at).toBeNull();
    const r1 = await as.staff.rpc("update_document", { p_id: d.id, p: { client_id: clientB, doc_type_id: t.form16 } });
    expect(r1.error).toBeNull();
    const first = (await documentRow(d.id)).classified_at;
    expect(first).not.toBeNull();
    await new Promise((r) => setTimeout(r, 1100));
    const r2 = await as.staff.rpc("update_document", { p_id: d.id, p: { doc_type_id: t.form16a, period_id: p.quarter } });
    expect(r2.error).toBeNull();
    const row = await documentRow(d.id);
    expect(row.doc_type_id).toBe(t.form16a);
    expect(row.classified_at).toBe(first);
  });

  it("classified_at cannot be written directly", async () => {
    const d = await mustCreateDocument(as.staff, {});
    const r = await as.admin.from("document").update({ classified_at: "2020-01-01T00:00:00Z" }).eq("id", d.id);
    expect(r.error?.message ?? "").toMatch(DENIED);
    expect((await documentRow(d.id)).classified_at).toBeNull();
  });

  it("edits apply the same rules as adding (period kind, registration, soft copy needs a file)", async () => {
    const d = await mustCreateDocument(as.staff, { client_id: clientA, doc_type_id: t.form16 });
    const r1 = await as.staff.rpc("update_document", { p_id: d.id, p: { period_id: p.month } });
    expect(r1.error?.message ?? "").toMatch(/PERIOD_KIND/);
    const r2 = await as.staff.rpc("update_document", { p_id: d.id, p: { received_as: "soft_copy" } });
    expect(r2.error?.message ?? "").toMatch(/SOFT_COPY_NEEDS_FILE/);
    const r3 = await as.staff.rpc("update_document", { p_id: d.id, p: { channel: "courier", remark: "left at reception", received_as: "original" } });
    expect(r3.error).toBeNull();
    expect((await documentRow(d.id)).received_as).toBe("original");
  });

  it("Limited users can edit documents they can see, and can't move one to a client they can't see", async () => {
    const d = await mustCreateDocument(as.limited, {});
    expect((await as.limited.rpc("update_document", { p_id: d.id, p: { client_id: clientA, doc_type_id: t.form16 } })).error).toBeNull();
    const moved = await as.limited.rpc("update_document", { p_id: d.id, p: { client_id: clientB } });
    expect(moved.error?.message ?? "").toMatch(DENIED_OR_NOT_FOUND);
    const onB = await mustCreateDocument(as.staff, { client_id: clientB, doc_type_id: t.form16 });
    const r = await as.limited.rpc("update_document", { p_id: onB.id, p: { remark: "x" } });
    expect(r.error?.message ?? "").toMatch(/NOT_FOUND/);
  });
});

// ── Versions (AC-11, AC-14) ──────────────────────────────────────────────────
describe("versions (AC-11, AC-14)", () => {
  it("a new version keeps the DOC-ID, gets the next number and becomes current; earlier versions are kept", async () => {
    const d = await createSoftCopy(as.staff, officeId, { client_id: clientB, doc_type_id: t.form16 });
    const obj = await uploadObject(officeId, "png", d.id);
    const { data, error } = await as.staff.rpc("add_document_version", { p_document_id: d.id, p_file: { storage_path: obj.path, file_name: "revised.png" } });
    expect(error).toBeNull();
    expect((data as { version_no: number }).version_no).toBe(2);
    const row = await documentRow(d.id);
    expect(row.doc_code).toBe(d.doc_code);
    expect(row.version_count).toBe(2);
    expect(row.current_version_id).toBe((data as { version_id: string }).version_id);
    const { data: versions } = await adminClient().from("document_version").select("version_no, mime_type").eq("document_id", d.id).order("version_no");
    expect(versions).toEqual([{ version_no: 1, mime_type: "application/pdf" }, { version_no: 2, mime_type: "image/png" }]);
  });

  it("a hard copy can get its first scanned file later and stays a hard copy", async () => {
    const d = await mustCreateDocument(as.staff, { received_as: "hard_copy" });
    const obj = await uploadObject(officeId, "pdf", d.id);
    expect((await as.staff.rpc("add_document_version", { p_document_id: d.id, p_file: { storage_path: obj.path, file_name: "scan.pdf" } })).error).toBeNull();
    const row = await documentRow(d.id);
    expect([row.version_count, row.received_as]).toEqual([1, "hard_copy"]);
  });

  it("a version's object must sit under its own document's folder", async () => {
    const a = await mustCreateDocument(as.staff, {});
    const b = await mustCreateDocument(as.staff, {});
    const obj = await uploadObject(officeId, "pdf", b.id);
    const r = await as.staff.rpc("add_document_version", { p_document_id: a.id, p_file: { storage_path: obj.path, file_name: "x.pdf" } });
    expect(r.error?.message ?? "").toMatch(/PATH/);
  });

  it("versions are append-only: no update, no delete, and current_version_id can't be pointed elsewhere", async () => {
    const d = await createSoftCopy(as.staff, officeId);
    const { data: v } = await adminClient().from("document_version").select("id").eq("document_id", d.id).single();
    const up = await as.admin.from("document_version").update({ file_name: "renamed.pdf" }).eq("id", v!.id);
    expect(up.error?.message ?? "").toMatch(DENIED);
    const del = await as.admin.from("document_version").delete().eq("id", v!.id);
    expect(del.error?.message ?? "").toMatch(DENIED);
    const svcDel = await adminClient().from("document_version").delete().eq("id", v!.id);
    expect(svcDel.error?.message ?? "").toMatch(/NO_DELETE|append-only|IMMUTABLE/i);
    const other = await createSoftCopy(as.staff, officeId);
    const { data: ov } = await adminClient().from("document_version").select("id").eq("document_id", other.id).single();
    const hijack = await as.admin.from("document").update({ current_version_id: ov!.id }).eq("id", d.id);
    expect(hijack.error?.message ?? "").toMatch(DENIED);
  });

  it("Limited users can't add a version to a document they can't see", async () => {
    const onB = await mustCreateDocument(as.staff, { client_id: clientB, doc_type_id: t.form16 });
    const obj = await uploadObject(officeId, "pdf", onB.id);
    const r = await as.limited.rpc("add_document_version", { p_document_id: onB.id, p_file: { storage_path: obj.path, file_name: "x.pdf" } });
    expect(r.error?.message ?? "").toMatch(/NOT_FOUND/);
  });
});

// ── Archive and delete (AC-11, AC-14) ────────────────────────────────────────
describe("archive and delete (AC-11, AC-14)", () => {
  it("only Admin/Manager archive and unarchive, with a reason; the DOC-ID is kept and never reused", async () => {
    const d = await mustCreateDocument(as.staff, { client_id: clientB, doc_type_id: t.form16 });
    const s = await as.staff.rpc("archive_document", { p_id: d.id, p_reason: "duplicate" });
    expect(s.error?.message ?? "").toMatch(/ROLE_REQUIRED/);
    const direct = await as.staff.from("document").update({ archived_at: new Date().toISOString() }).eq("id", d.id);
    expect(direct.error?.message ?? "").toMatch(/ROLE_REQUIRED|permission denied/);
    const noReason = await as.manager.rpc("archive_document", { p_id: d.id, p_reason: " " });
    expect(noReason.error?.message ?? "").toMatch(/REASON_REQUIRED/);
    expect((await as.manager.rpc("archive_document", { p_id: d.id, p_reason: "duplicate of another upload" })).error).toBeNull();
    const row = await documentRow(d.id);
    expect(row.archived_at).not.toBeNull();
    expect(row.archived_by).toBe(u.manager.id);
    const next = await mustCreateDocument(as.staff, {});
    expect(parseDocCode(next.doc_code).n).toBeGreaterThan(parseDocCode(d.doc_code).n);
    expect((await as.admin.rpc("unarchive_document", { p_id: d.id })).error).toBeNull();
    expect((await documentRow(d.id)).archived_at).toBeNull();
  });

  it("an archived document can't be edited or given a new version until unarchived", async () => {
    const d = await mustCreateDocument(as.staff, {});
    await as.admin.rpc("archive_document", { p_id: d.id, p_reason: "test" });
    const e = await as.staff.rpc("update_document", { p_id: d.id, p: { remark: "x" } });
    expect(e.error?.message ?? "").toMatch(/ARCHIVED/);
    const obj = await uploadObject(officeId, "pdf", d.id);
    const v = await as.staff.rpc("add_document_version", { p_document_id: d.id, p_file: { storage_path: obj.path, file_name: "x.pdf" } });
    expect(v.error?.message ?? "").toMatch(/ARCHIVED/);
  });

  it("documents are never deleted — not by users, not by the service role", async () => {
    const d = await mustCreateDocument(as.staff, {});
    const r1 = await as.admin.from("document").delete().eq("id", d.id);
    expect(r1.error?.message ?? "").toMatch(DENIED);
    const r2 = await adminClient().from("document").delete().eq("id", d.id);
    expect(r2.error?.message ?? "").toMatch(/NO_DELETE/);
    const r3 = await adminClient().from("doc_counter").delete().eq("office_id", officeId);
    expect(r3.error?.message ?? "").toMatch(/NO_DELETE/);
    expect((await documentRow(d.id)).id).toBe(d.id);
  });

  it("users can't read or write the DOC-ID counter", async () => {
    const r = await as.admin.from("doc_counter").update({ last: 0 }).eq("office_id", officeId);
    expect(r.error?.message ?? "").toMatch(DENIED);
    const { data } = await as.admin.from("doc_counter").select("last");
    expect(data ?? []).toEqual([]);
  });
});

// ── Visibility (AC-9, AC-12) ─────────────────────────────────────────────────
describe("visibility matrix (AC-9, AC-12)", () => {
  const docs = {} as Record<"onA" | "onB" | "inboxLimited" | "inboxStaff" | "limitedMovedToB", string>;
  beforeAll(async () => {
    docs.onA = (await createSoftCopy(as.staff, officeId, { client_id: clientA, doc_type_id: t.form16 })).id;
    docs.onB = (await createSoftCopy(as.staff, officeId, { client_id: clientB, doc_type_id: t.form16 })).id;
    docs.inboxLimited = (await mustCreateDocument(as.limited, { remark: "found in courier bag" })).id;
    docs.inboxStaff = (await mustCreateDocument(as.staff, {})).id;
    // Added by Limited, later classified by Staff to a client Limited can't see.
    docs.limitedMovedToB = (await mustCreateDocument(as.limited, {})).id;
    await as.staff.rpc("update_document", { p_id: docs.limitedMovedToB, p: { client_id: clientB, doc_type_id: t.form16 } });
  });

  const visible = async (who: Who) => {
    const { data, error } = await as[who].from("document").select("id").in("id", Object.values(docs));
    expect(error).toBeNull();
    return new Set((data ?? []).map((r) => r.id as string));
  };

  it.each(["admin", "manager", "staff"] as const)("%s sees every document of the office, classified or not", async (who) => {
    expect((await visible(who)).size).toBe(5);
  });

  it("limited sees its assigned client's documents and only the Inbox items it added", async () => {
    const seen = await visible("limited");
    expect(seen).toEqual(new Set([docs.onA, docs.inboxLimited]));
  });

  it("limited gets 0 rows (not an error) for other documents and their versions", async () => {
    const { data } = await as.limited.from("document").select("id").eq("id", docs.onB).maybeSingle();
    expect(data).toBeNull();
    const { data: v } = await as.limited.from("document_version").select("id").eq("document_id", docs.onB);
    expect(v).toEqual([]);
    const { data: own } = await as.limited.from("document_version").select("id").eq("document_id", docs.onA);
    expect(own?.length).toBe(1);
  });

  it("a Limited user who is assigned a group on a client starts seeing that client's documents", async () => {
    const { data: grp } = await as.staff.rpc("enable_client_group", { p_client_id: clientB, p_doc_group_id: (await adminClient().from("doc_type").select("doc_group_id").eq("id", t.form16).single()).data!.doc_group_id });
    await as.manager.from("client_group").update({ assigned_staff_id: u.limited.id }).eq("id", grp as string);
    expect((await visible("limited")).has(docs.onB)).toBe(true);
    await as.manager.from("client_group").update({ assigned_staff_id: u.staff.id }).eq("id", grp as string);
    expect((await visible("limited")).has(docs.onB)).toBe(false);
  });

  it("another office sees nothing", async () => {
    expect((await visible("outsider")).size).toBe(0);
  });

  it("anonymous callers see nothing", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
    const { data } = await anon.from("document").select("id").limit(1);
    expect(data ?? []).toEqual([]);
  });
});

// ── Activity (AC-17) ─────────────────────────────────────────────────────────
describe("activity (AC-17)", () => {
  it("add, classify, edit, new version, archive and unarchive each write one row — IDs and field names only", async () => {
    const d = await createSoftCopy(as.staff, officeId, { remark: "Ravi dropped this at 5pm" });
    await as.staff.rpc("update_document", { p_id: d.id, p: { client_id: clientA, doc_type_id: t.sales, registration_id: reg.gstin } });
    await as.staff.rpc("update_document", { p_id: d.id, p: { remark: "second remark text", channel: "courier" } });
    const obj = await uploadObject(officeId, "pdf", d.id);
    await as.staff.rpc("add_document_version", { p_document_id: d.id, p_file: { storage_path: obj.path, file_name: "Ravi Traders GST Aug.pdf" } });
    await as.manager.rpc("archive_document", { p_id: d.id, p_reason: "wrong client entirely" });
    await as.manager.rpc("unarchive_document", { p_id: d.id });

    const rows = await activityFor(officeId, d.id);
    expect(rows.map((r) => r.action)).toEqual([
      "document.added", "document.classified", "document.updated", "document.version_added", "document.archived", "document.unarchived",
    ]);
    expect(rows[2].data).toMatchObject({ fields: expect.arrayContaining(["remark", "channel"]) });
    const text = JSON.stringify(rows.map((r) => r.data));
    for (const secret of ["statement.pdf", "Ravi", "second remark text", "wrong client entirely", "33ZZZP"]) expect(text).not.toContain(secret);
    expect(rows.every((r) => !("file_name" in r.data) && !("remark" in r.data) && !("reason" in r.data))).toBe(true);
  });
});

// ── Test office reset (plan D2 extended) ─────────────────────────────────────
describe("reset_test_office", () => {
  it("is still service-role only", async () => {
    const r = await as.admin.rpc("reset_test_office", { p_office_id: officeId });
    expect(r.error).not.toBeNull();
  });
});
