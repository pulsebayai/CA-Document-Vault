import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { activityFor, createDocumentOffice, documentRow, periodId, typeId } from "../support/documents";
import { T, bankOnlyClient } from "../support/expected";

// Feature 13 — Log receipt (spec AC-13 … AC-15, Q1, Q2). Written before migration B (plan step 1).
// Contract: log_receipt(p jsonb) (SECURITY INVOKER) →
//   { client_code, documents: [{ id, doc_code }] } in creation order.
//   p = { client_id (required), doc_type_id?, period_id?, count 1–20, handed_over_name 1–120 (required),
//         returnable?, received_on?, channel? (default hand_delivery), remark? }.
//   Creates `count` hard copies with no file through 03's create_document, in one transaction.
//   Errors: COUNT_INVALID, HANDED_OVER_REQUIRED, CLIENT_REQUIRED, plus create_document's own.

type Who = "staff" | "limited";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
let mine: string, theirs: string, bank: string, apr: string;
type Receipt = { client_code: string; documents: Array<{ id: string; doc_code: string }> };

const receipt = (who: SupabaseClient, p: Record<string, unknown>) =>
  who.rpc("log_receipt", { p: { handed_over_name: "Client's accountant", count: 1, ...p } }) as unknown as
    Promise<{ data: Receipt | null; error: { message: string } | null }>;
const docCount = async () => {
  const { count, error } = await adminClient().from("document").select("id", { count: "exact", head: true }).eq("office_id", officeId);
  if (error) throw error;
  return count ?? 0;
};

beforeAll(async () => {
  officeId = await createDocumentOffice("log-receipt");
  u.staff = await createStaff(officeId, "lr-staff", "staff");
  u.limited = await createStaff(officeId, "lr-limited", "limited");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  mine = await bankOnlyClient(as.staff, officeId, { name: "Receipt Mine", incharge_id: u.limited.id });
  theirs = await bankOnlyClient(as.staff, officeId, { name: "Receipt Theirs", incharge_id: u.staff.id });
  bank = await typeId(officeId, T.bank);
  apr = await periodId(officeId, "2026-04");
}, 120_000);

afterAll(async () => {
  await retireStaff([u.staff, u.limited].filter(Boolean).map((x) => x.id));
});

describe("Log receipt (AC-13, AC-14, AC-15)", () => {
  it("with a type: N filed hard copies with no file, each its own DOC-ID, the client code returned", async () => {
    const { data, error } = await receipt(as.staff, { client_id: mine, doc_type_id: bank, period_id: apr, count: 3, returnable: true,
      received_on: "2026-05-04", channel: "courier", remark: "Three bank passbooks" });
    expect(error).toBeNull();
    expect(data!.documents).toHaveLength(3);
    expect(new Set(data!.documents.map((x) => x.doc_code)).size).toBe(3);
    expect(data!.client_code).toMatch(/^C\d{4,}$/);
    for (const x of data!.documents) {
      expect(await documentRow(x.id)).toMatchObject({ client_id: mine, doc_type_id: bank, period_id: apr, received_as: "hard_copy",
        returnable: true, handed_over_name: "Client's accountant", channel: "courier", received_on: "2026-05-04",
        current_version_id: null, received_by: u.staff.id, status: "received", custody: null });
      expect((await documentRow(x.id)).classified_at).not.toBeNull();
      expect((await activityFor(officeId, x.id)).map((a) => a.action)).toContain("document.added");
    }
  });

  it("without a type: Untagged documents with the client set; defaults hand delivery, today, not returnable", async () => {
    const { data, error } = await receipt(as.staff, { client_id: mine, count: 2 });
    expect(error).toBeNull();
    for (const x of data!.documents) {
      const row = await documentRow(x.id);
      expect(row).toMatchObject({ client_id: mine, doc_type_id: null, classified_at: null, channel: "hand_delivery", returnable: false });
      expect(row.received_on).toBe(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()));
    }
  });

  it("refuses a count outside 1–20, a missing handed-over name or client, and creates nothing", async () => {
    const before = await docCount();
    expect((await receipt(as.staff, { client_id: mine, count: 0 })).error?.message ?? "").toMatch(/COUNT_INVALID/);
    expect((await receipt(as.staff, { client_id: mine, count: 21 })).error?.message ?? "").toMatch(/COUNT_INVALID/);
    expect((await receipt(as.staff, { client_id: mine, handed_over_name: "  " })).error?.message ?? "").toMatch(/HANDED_OVER_REQUIRED/);
    expect((await receipt(as.staff, { client_id: null })).error?.message ?? "").toMatch(/CLIENT_REQUIRED/);
    expect(await docCount()).toBe(before);
  });

  it("is all or nothing: a period from another office fails the whole receipt", async () => {
    const before = await docCount();
    const foreign = "00000000-0000-4000-8000-00000000f00d";
    expect((await receipt(as.staff, { client_id: mine, doc_type_id: bank, period_id: foreign, count: 4 })).error).not.toBeNull();
    expect(await docCount()).toBe(before);
  });

  it("Limited logs receipts for clients they can see, not for others", async () => {
    expect((await receipt(as.limited, { client_id: mine, count: 1 })).error).toBeNull();
    const before = await docCount();
    expect((await receipt(as.limited, { client_id: theirs, count: 2 })).error).not.toBeNull();
    expect(await docCount()).toBe(before);
  });

  it("the handed-over name never reaches activity data", async () => {
    const { data } = await receipt(as.staff, { client_id: mine, handed_over_name: "Ramesh Courier Pvt" });
    const act = await activityFor(officeId, data!.documents[0].id);
    expect(JSON.stringify(act)).not.toMatch(/Ramesh/);
  });
});
