import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import {
  createDocumentOffice, createSoftCopy, custodyHistory, documentRow, mustCreateDocument, mustReview, periodId, typeId,
} from "../support/documents";
import { T, bankOnlyClient } from "../support/expected";
import { documentState } from "@/lib/documents/state";

// Feature 13 — migration of existing documents (spec AC-17, intent Q3). Written before migration A (plan step 1).
// Contract: the data step lives in `public.custody_backfill(p_office uuid) returns jsonb` (service role only; the migration
// runs it for every office). It touches only documents with no custody step:
//   live dispatch packet → ready · returnable hard copy with a review decision → ready · other hard copy with a review
//   decision → in_office · To review / Untagged / soft copy → unchanged. Archived documents follow the same rule.
//   *_at = reviewed_at, *_by = null. No history and no activity rows. Returns counts per step.
// Documents created after the migration start with no step, which is exactly the pre-migration shape, so the test seeds
// them and runs the backfill on its own test office.

type Who = "manager" | "staff";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
const d = {} as Record<"toReview" | "plain" | "plainFix" | "ret" | "retFix" | "soft" | "untagged" | "archivedRet", string>;
const TODAY = "2026-10-31";

const snapshot = async (id: string) => {
  const r = await documentRow(id);
  return { archived: r.archived_at !== null, clientId: r.client_id, docTypeId: r.doc_type_id, receivedAs: r.received_as,
    returnable: r.returnable as boolean, status: r.status as string, dispatchedOn: null,
    custody: (r.custody ?? null) as "in_office" | "ready" | null, inOfficeAt: (r.in_office_at ?? null) as string | null };
};

beforeAll(async () => {
  officeId = await createDocumentOffice("custody-migration");
  u.manager = await createStaff(officeId, "cm-manager", "manager");
  u.staff = await createStaff(officeId, "cm-staff", "staff");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  const client = await bankOnlyClient(as.staff, officeId, { name: "Migration client", incharge_id: u.staff.id });
  const base = { client_id: client, doc_type_id: await typeId(officeId, T.bank), period_id: await periodId(officeId, "2026-04"),
    received_as: "hard_copy" as const };
  const mk = async (extra: Record<string, unknown> = {}) => (await mustCreateDocument(as.staff, { ...base, ...extra } as never)).id;
  d.toReview = await mk({ returnable: true });
  d.plain = await mk(); await mustReview(as.staff, d.plain);
  d.plainFix = await mk(); await mustReview(as.staff, d.plainFix, "needs_correction", "Blurred");
  d.ret = await mk({ returnable: true }); await mustReview(as.staff, d.ret);
  d.retFix = await mk({ returnable: true }); await mustReview(as.staff, d.retFix, "needs_correction", "Wrong year");
  d.soft = (await createSoftCopy(as.staff, officeId, { client_id: base.client_id, doc_type_id: base.doc_type_id, period_id: base.period_id })).id;
  await mustReview(as.staff, d.soft);
  d.untagged = await mk({ doc_type_id: null });
  d.archivedRet = await mk({ returnable: true }); await mustReview(as.staff, d.archivedRet);
  expect((await as.manager.rpc("archive_document", { p_id: d.archivedRet, p_reason: "Duplicate" })).error).toBeNull();
}, 120_000);

afterAll(async () => {
  await retireStaff([u.manager, u.staff].filter(Boolean).map((x) => x.id));
});

describe("custody backfill (AC-17)", () => {
  it("can't be called by staff", async () => {
    expect((await as.manager.rpc("custody_backfill", { p_office: officeId })).error).not.toBeNull();
  });

  it("places each document by today's look, keeps every shown state, writes no history", async () => {
    const { data, error } = await adminClient().rpc("custody_backfill", { p_office: officeId });
    expect(error).toBeNull();
    expect(data).toMatchObject({ in_office: 2, ready: 3 }); // plain, plainFix · ret, retFix, archivedRet

    const want: Record<keyof typeof d, string | null> = { toReview: null, plain: "in_office", plainFix: "in_office", ret: "ready",
      retFix: "ready", soft: null, untagged: null, archivedRet: "ready" };
    for (const [k, id] of Object.entries(d) as Array<[keyof typeof d, string]>) {
      const row = await documentRow(id);
      expect(row.custody ?? null, k).toBe(want[k]);
      if (want[k]) {
        expect(row.in_office_at, k).toBe(row.reviewed_at);
        expect(row.in_office_by ?? null, k).toBeNull();
      }
      expect(await custodyHistory(id), k).toEqual([]);
    }
    // Shown state = what 07/12 showed before 13 (Ready was derived from returnable + a review decision), except that a
    // reviewed plain hard copy now shows "Document in office" instead of "Reviewed".
    const shown: Record<keyof typeof d, string> = { toReview: "to_review", plain: "in_office", plainFix: "needs_correction",
      ret: "ready", retFix: "ready", soft: "reviewed", untagged: "inbox", archivedRet: "archived" };
    for (const [k, id] of Object.entries(d) as Array<[keyof typeof d, string]>) {
      expect(documentState(await snapshot(id), TODAY).kind, k).toBe(shown[k]);
    }
  });

  it("is idempotent: a second run changes nothing", async () => {
    const { data, error } = await adminClient().rpc("custody_backfill", { p_office: officeId });
    expect(error).toBeNull();
    expect(data).toMatchObject({ in_office: 0, ready: 0 });
  });
});

describe("after the real migration (every office on this database)", () => {
  it("every document in a live dispatch packet is Ready", async () => {
    const { data: items, error } = await adminClient().from("dispatch_item").select("document_id").is("removed_at", null).limit(1000);
    expect(error).toBeNull();
    const ids = (items ?? []).map((x) => x.document_id as string);
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await adminClient().from("document").select("id, custody").in("id", ids.slice(i, i + 200));
      expect((data ?? []).filter((x) => x.custody !== "ready")).toEqual([]);
    }
  });
});
