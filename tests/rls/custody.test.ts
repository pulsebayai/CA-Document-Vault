import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import {
  activityFor, createDispatch, createDocumentOffice, createSoftCopy, custodyHistory, documentRow, mustCreateDocument, mustDispatch,
  mustMarkReady, mustReview, mustSetCustody, periodId, setCustody, typeId, undoCustody, undoReview, uploadObject,
} from "../support/documents";
import { T, bankOnlyClient } from "../support/expected";
import { documentState, isReadyToDispatch } from "@/lib/documents/state";

// Feature 13 — hard-copy custody (spec AC-1 … AC-9, S1, S2, S3, S5). Written before migrations A/B (plan step 1).
// Contract: tests/support/documents.ts ("13 hard-copy custody").

type Who = "manager" | "staff" | "limited";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
let client: string, other: string, bank: string, apr: string, may: string;

const hard = (extra: Record<string, unknown> = {}) =>
  mustCreateDocument(as.staff, { client_id: client, doc_type_id: bank, period_id: apr, received_on: "2026-05-02",
    received_as: "hard_copy", ...extra } as never);
const returnable = (extra: Record<string, unknown> = {}) => hard({ returnable: true, ...extra });
const reviewed = async (d: Promise<{ id: string; doc_code: string }>, outcome: "reviewed" | "needs_correction" = "reviewed") => {
  const x = await d;
  await mustReview(as.staff, x.id, outcome, outcome === "needs_correction" ? "Wrong year" : null);
  return x;
};
const update = (id: string, p: Record<string, unknown>) => as.staff.rpc("update_document", { p_id: id, p });
const skipReason = async (who: SupabaseClient, id: string, step: "in_office" | "ready") => {
  const { data, error } = await setCustody(who, [id], step);
  if (error) throw new Error(error.message);
  return data!.skipped.find((s) => s.id === id)?.reason ?? null;
};

beforeAll(async () => {
  officeId = await createDocumentOffice("custody");
  u.manager = await createStaff(officeId, "cus-manager", "manager");
  u.staff = await createStaff(officeId, "cus-staff", "staff");
  u.limited = await createStaff(officeId, "cus-limited", "limited");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  client = await bankOnlyClient(as.staff, officeId, { name: "Custody client", incharge_id: u.limited.id }); // Limited sees it
  other = await bankOnlyClient(as.staff, officeId, { name: "Custody other", incharge_id: u.staff.id }); // Limited doesn't
  bank = await typeId(officeId, T.bank);
  apr = await periodId(officeId, "2026-04");
  may = await periodId(officeId, "2026-05");
}, 120_000);

afterAll(async () => {
  await retireStaff([u.manager, u.staff, u.limited].filter(Boolean).map((x) => x.id));
});

describe("Document in office (AC-1, AC-3, S1)", () => {
  it("a reviewed hard copy is marked in office, with who and when, one history row and one activity row", async () => {
    const d = await reviewed(hard());
    const r = await mustSetCustody(as.staff, [d.id], "in_office");
    expect(r.done).toEqual([d.id]);
    const row = await documentRow(d.id);
    expect(row).toMatchObject({ custody: "in_office", in_office_by: u.staff.id, ready_at: null, ready_by: null });
    expect(row.in_office_at).not.toBeNull();
    expect((await custodyHistory(d.id)).map((h) => [h.step, h.implied, h.actor_id])).toEqual([["in_office", false, u.staff.id]]);
    const act = (await activityFor(officeId, d.id)).filter((a) => a.action === "document.in_office");
    expect(act).toHaveLength(1);
    expect(act[0]).toMatchObject({ actor_id: u.staff.id, data: { client_id: client, doc_type_id: bank } });
  });

  it("a Needs-correction hard copy counts as reviewed (S1)", async () => {
    const d = await reviewed(hard(), "needs_correction");
    expect((await mustSetCustody(as.staff, [d.id], "in_office")).done).toEqual([d.id]);
  });

  it("is refused for To review, Untagged, soft copies, archived documents and documents already in office", async () => {
    const toReview = await hard();
    expect(await skipReason(as.staff, toReview.id, "in_office")).toBe("NOT_REVIEWED");
    const untagged = await mustCreateDocument(as.staff, { client_id: client, received_as: "hard_copy" });
    expect(await skipReason(as.staff, untagged.id, "in_office")).toBe("NOT_CLASSIFIED");
    const soft = await createSoftCopy(as.staff, officeId, { client_id: client, doc_type_id: bank, period_id: apr });
    await mustReview(as.staff, soft.id);
    expect(await skipReason(as.staff, soft.id, "in_office")).toBe("SOFT_COPY");
    const archived = await reviewed(hard());
    expect((await as.manager.rpc("archive_document", { p_id: archived.id, p_reason: "Duplicate" })).error).toBeNull();
    expect(await skipReason(as.staff, archived.id, "in_office")).toBe("ARCHIVED");
    const twice = await reviewed(hard());
    await mustSetCustody(as.staff, [twice.id], "in_office");
    expect(await skipReason(as.staff, twice.id, "in_office")).toBe("ALREADY");
    expect((await custodyHistory(twice.id))).toHaveLength(1);
  });

  it("a bad step or more than 200 IDs is refused as a whole", async () => {
    const d = await reviewed(hard());
    expect((await as.staff.rpc("set_custody", { p_ids: [d.id], p_step: "lost" })).error?.message ?? "").toMatch(/STEP_INVALID/);
    const many = Array.from({ length: 201 }, () => d.id);
    expect((await setCustody(as.staff, many, "in_office")).error?.message ?? "").toMatch(/TOO_MANY/);
    expect(await documentRow(d.id)).toMatchObject({ custody: null });
  });

  it("custody columns can't be written directly, even by a manager", async () => {
    const d = await reviewed(hard());
    await as.manager.from("document").update({ custody: "in_office" }).eq("id", d.id);
    expect(await documentRow(d.id)).toMatchObject({ custody: null });
  });
});

describe("Ready to dispatch (AC-2, AC-6, AC-8)", () => {
  it("a returnable document in office can be marked ready; a plain one or one not in office can't", async () => {
    const r = await reviewed(returnable());
    expect(await skipReason(as.staff, r.id, "ready")).toBe("NOT_IN_OFFICE");
    await mustSetCustody(as.staff, [r.id], "in_office");
    expect((await mustSetCustody(as.staff, [r.id], "ready")).done).toEqual([r.id]);
    expect(await documentRow(r.id)).toMatchObject({ custody: "ready", ready_by: u.staff.id });
    expect((await custodyHistory(r.id)).map((h) => h.step)).toEqual(["in_office", "ready"]);
    expect((await activityFor(officeId, r.id)).map((a) => a.action)).toContain("document.ready");

    const plain = await reviewed(hard());
    await mustSetCustody(as.staff, [plain.id], "in_office");
    expect(await skipReason(as.staff, plain.id, "ready")).toBe("NOT_RETURNABLE");
  });

  it("only a document marked ready shows (and is listed) as Ready to dispatch; a merely reviewed returnable one is To place", async () => {
    const plainReviewed = await reviewed(returnable({ period_id: may }));
    const ready = await reviewed(returnable({ period_id: may }));
    await mustMarkReady(as.staff, ready.id);
    const { data, error } = await as.staff.rpc("search_documents", { p: { filters: { client_id: client, period_id: may } } });
    expect(error).toBeNull();
    const rows = (data as { rows: Array<Record<string, unknown> & { id: string; return_state: string | null }> }).rows;
    expect(rows.find((x) => x.id === ready.id)).toMatchObject({ return_state: "ready", custody: "ready" });
    expect(rows.find((x) => x.id === plainReviewed.id)).toMatchObject({ return_state: "to_place", custody: null });
    for (const x of rows) {
      const d = { archived: x.archived_at !== null, clientId: x.client_id as string, docTypeId: x.doc_type_id as string,
        receivedAs: x.received_as as string, returnable: x.returnable as boolean, status: x.status as string,
        dispatchedOn: x.dispatched_on as string | null, custody: x.custody as "in_office" | "ready" | null,
        inOfficeAt: x.in_office_at as string | null };
      expect(isReadyToDispatch(d), x.id).toBe(x.return_state === "ready");
      expect(documentState(d, "2026-10-31").kind === "in_office", x.id).toBe(x.return_state === "in_office" && x.status === "reviewed");
    }
  });
});

describe("dispatch (AC-6, S2)", () => {
  it("a Ready document dispatches, and undo dispatch returns it to Ready", async () => {
    const r = await reviewed(returnable());
    await mustMarkReady(as.staff, r.id);
    await mustDispatch(as.staff, { client_id: client, document_ids: [r.id], dispatched_on: "2026-05-10" });
    expect(await documentRow(r.id)).toMatchObject({ custody: "ready" });
    expect((await as.manager.rpc("undo_dispatch_item", { p_document_id: r.id, p_reason: "Wrong packet" })).error).toBeNull();
    expect(await documentRow(r.id)).toMatchObject({ custody: "ready" });
  });

  it("S2: a reviewed returnable copy nobody marked ready still dispatches, recording both steps as implied", async () => {
    const r = await reviewed(returnable());
    await mustDispatch(as.staff, { client_id: client, document_ids: [r.id], dispatched_on: "2026-05-10" });
    const row = await documentRow(r.id);
    expect(row).toMatchObject({ custody: "ready", in_office_by: u.staff.id, ready_by: u.staff.id });
    expect((await custodyHistory(r.id)).map((h) => [h.step, h.implied])).toEqual([["in_office", true], ["ready", true]]);
    // In office already: only Ready is implied.
    const r2 = await reviewed(returnable());
    await mustSetCustody(as.staff, [r2.id], "in_office");
    await mustDispatch(as.staff, { client_id: client, document_ids: [r2.id], dispatched_on: "2026-05-10" });
    expect((await custodyHistory(r2.id)).map((h) => [h.step, h.implied])).toEqual([["in_office", false], ["ready", true]]);
  });

  it("dispatch eligibility is otherwise 07/12's: a plain hard copy or a To review returnable copy is refused", async () => {
    const plain = await reviewed(hard());
    await mustSetCustody(as.staff, [plain.id], "in_office");
    expect((await createDispatch(as.staff, { client_id: client, document_ids: [plain.id] })).error?.message ?? "").toMatch(/NOT_ELIGIBLE/);
    const toReview = await returnable();
    expect((await createDispatch(as.staff, { client_id: client, document_ids: [toReview.id] })).error?.message ?? "").toMatch(/NOT_ELIGIBLE/);
    expect(await documentRow(toReview.id)).toMatchObject({ custody: null });
  });
});

describe("undo (AC-4, S3)", () => {
  it("Ready → In office → not placed, each logged, history kept; no reason needed", async () => {
    const r = await reviewed(returnable());
    await mustMarkReady(as.staff, r.id);
    expect((await undoCustody(as.staff, r.id)).error).toBeNull();
    expect(await documentRow(r.id)).toMatchObject({ custody: "in_office", ready_at: null, ready_by: null });
    expect((await undoCustody(as.staff, r.id)).error).toBeNull();
    expect(await documentRow(r.id)).toMatchObject({ custody: null, in_office_at: null, in_office_by: null });
    expect((await custodyHistory(r.id)).map((h) => h.step)).toEqual(["in_office", "ready", "undo_ready", "undo_in_office"]);
    const undone = (await activityFor(officeId, r.id)).filter((a) => a.action === "document.custody_undone");
    expect(undone.map((a) => a.data.step)).toEqual(["ready", "in_office"]);
    expect((await undoCustody(as.staff, r.id)).error?.message ?? "").toMatch(/NOT_IN_CUSTODY/);
  });

  it("undo is refused while the document is in a live dispatch packet", async () => {
    const r = await reviewed(returnable());
    await mustMarkReady(as.staff, r.id);
    await mustDispatch(as.staff, { client_id: client, document_ids: [r.id], dispatched_on: "2026-05-10" });
    expect((await undoCustody(as.staff, r.id)).error?.message ?? "").toMatch(/DISPATCHED/);
    expect(await documentRow(r.id)).toMatchObject({ custody: "ready" });
  });
});

describe("roles (AC-4, Q5)", () => {
  it("Limited moves and undoes documents of clients they can see, and can't touch others", async () => {
    const mine = await reviewed(returnable());
    await mustMarkReady(as.limited, mine.id);
    expect((await undoCustody(as.limited, mine.id)).error).toBeNull();
    const theirs = await reviewed(hard({ client_id: other }));
    expect(await skipReason(as.limited, theirs.id, "in_office")).toBe("NOT_FOUND");
    await mustSetCustody(as.staff, [theirs.id], "in_office");
    expect((await undoCustody(as.limited, theirs.id)).error?.message ?? "").toMatch(/NOT_FOUND/);
    expect(await documentRow(theirs.id)).toMatchObject({ custody: "in_office" });
  });
});

describe("custody survives a review reset and edits (AC-5, AC-7, S5)", () => {
  it("a new period resets the review to To review and keeps the custody step; it isn't Ready until reviewed again", async () => {
    const r = await reviewed(returnable());
    await mustMarkReady(as.staff, r.id);
    expect((await update(r.id, { period_id: may })).error).toBeNull();
    expect(await documentRow(r.id)).toMatchObject({ status: "received", custody: "ready" });
    expect((await createDispatch(as.staff, { client_id: client, document_ids: [r.id] })).error?.message ?? "").toMatch(/NOT_ELIGIBLE/);
    await mustReview(as.staff, r.id);
    expect((await mustDispatch(as.staff, { client_id: client, document_ids: [r.id] })).id).toBeTruthy();
  });

  it("undo review keeps the custody step too", async () => {
    const d = await reviewed(hard());
    await mustSetCustody(as.staff, [d.id], "in_office");
    expect((await undoReview(as.staff, d.id, "Clicked the wrong row")).error).toBeNull();
    expect(await documentRow(d.id)).toMatchObject({ status: "received", custody: "in_office" });
  });

  it("S5: switching to soft copy is refused while in custody; unticking Returnable is refused while Ready", async () => {
    const obj = await uploadObject(officeId, "pdf");
    const withFile = await reviewed(returnable({ file: { storage_path: obj.path, file_name: "scan.pdf" } }));
    await mustSetCustody(as.staff, [withFile.id], "in_office");
    expect((await update(withFile.id, { received_as: "soft_copy", returnable: false })).error?.message ?? "").toMatch(/CUSTODY_SOFT_COPY/);
    await mustSetCustody(as.staff, [withFile.id], "ready");
    expect((await update(withFile.id, { received_as: "hard_copy", returnable: false })).error?.message ?? "").toMatch(/CUSTODY_READY/);
    expect(await documentRow(withFile.id)).toMatchObject({ received_as: "hard_copy", returnable: true, custody: "ready" });
    // After undoing Ready, Returnable can be unticked; the document stays in office.
    expect((await undoCustody(as.staff, withFile.id)).error).toBeNull();
    expect((await update(withFile.id, { received_as: "hard_copy", returnable: false })).error).toBeNull();
    expect(await documentRow(withFile.id)).toMatchObject({ returnable: false, custody: "in_office" });
  });

  it("archive keeps the custody step; an archived document can't be moved or undone", async () => {
    const d = await reviewed(hard());
    await mustSetCustody(as.staff, [d.id], "in_office");
    expect((await as.manager.rpc("archive_document", { p_id: d.id, p_reason: "Duplicate" })).error).toBeNull();
    expect(await documentRow(d.id)).toMatchObject({ custody: "in_office" });
    expect((await undoCustody(as.staff, d.id)).error?.message ?? "").toMatch(/ARCHIVED/);
  });
});

describe("bulk (AC-9)", () => {
  it("each ID is done or skipped with a reason; one bad ID doesn't stop the rest", async () => {
    const a = await reviewed(hard());
    const b = await reviewed(hard());
    const notReviewed = await hard();
    const r = await mustSetCustodyLoose(as.staff, [a.id, notReviewed.id, b.id], "in_office");
    expect(r.done.sort()).toEqual([a.id, b.id].sort());
    expect(r.skipped).toEqual([{ id: notReviewed.id, reason: "NOT_REVIEWED" }]);
  });

  it("200 documents are moved in under 5 s", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 200; i += 20) {
      const batch = await Promise.all(Array.from({ length: 20 }, () => reviewed(hard({ period_id: may }))));
      ids.push(...batch.map((x) => x.id));
    }
    const t0 = Date.now();
    const r = await mustSetCustodyLoose(as.staff, ids, "in_office");
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.done).toHaveLength(200);
  }, 300_000);
});

describe("history table", () => {
  it("is readable like the document and never writable directly", async () => {
    const d = await reviewed(hard());
    await mustSetCustody(as.staff, [d.id], "in_office");
    const { data } = await as.staff.from("document_custody").select("step").eq("document_id", d.id);
    expect(data).toEqual([{ step: "in_office" }]);
    const ins = await as.manager.from("document_custody").insert({ office_id: officeId, document_id: d.id, step: "ready", implied: false });
    expect(ins.error).not.toBeNull();
    const theirs = await reviewed(hard({ client_id: other }));
    await mustSetCustody(as.staff, [theirs.id], "in_office");
    expect((await as.limited.from("document_custody").select("id").eq("document_id", theirs.id)).data).toEqual([]);
    const { count } = await adminClient().from("document_custody").select("id", { count: "exact", head: true }).eq("document_id", theirs.id);
    expect(count).toBe(1);
  });
});

async function mustSetCustodyLoose(who: SupabaseClient, ids: string[], step: "in_office" | "ready") {
  const { data, error } = await setCustody(who, ids, step);
  if (error) throw new Error(error.message);
  return data!;
}
