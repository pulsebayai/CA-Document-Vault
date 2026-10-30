import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { mustInsertClient } from "../support/catalogue";
import {
  createDispatch, createDocumentOffice, createSoftCopy, documentRow, mustCreateDocument, mustDispatch, mustReview, periodId, typeId,
} from "../support/documents";
import { T, mustRpc } from "../support/expected";

// Feature 12 — Returnable replaces "Original" (spec AC-8 … AC-13, AC-16; plan "legacy input rule").
// Written before migration A/B (plan step 1). Contract:
//   document.returnable boolean (true only on a hard copy); received_as is never stored as 'original'.
//   create_document / update_document take `returnable`. When `received_as` is sent WITHOUT `returnable`, the old
//   meaning applies: 'original' → hard copy + returnable; 'hard_copy' / 'soft_copy' → not returnable.
//   07's dispatch, Ready to dispatch, its lock, 03b's search ("return", received_as) and Today use returnable.
//   search_documents: filters.returnable = true; legacy filters.received_as = 'original' = hard copy + returnable.

type Who = "manager" | "staff";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
let client: string;
let bank: string;
let apr: string;

const hard = (extra: Record<string, unknown> = {}) =>
  mustCreateDocument(as.staff, { client_id: client, doc_type_id: bank, period_id: apr, received_on: "2026-05-02", ...extra } as never);
const update = (id: string, p: Record<string, unknown>) => as.staff.rpc("update_document", { p_id: id, p });
type Row = { id: string; received_as: string; returnable: boolean };
const search = async (filters: Record<string, unknown>) => {
  const { data, error } = await as.staff.rpc("search_documents", { p: { filters: { client_id: client, ...filters } } });
  if (error) throw new Error(error.message);
  return (data as { rows: Row[] }).rows;
};

beforeAll(async () => {
  officeId = await createDocumentOffice("returnable");
  u.manager = await createStaff(officeId, "ret-manager", "manager");
  u.staff = await createStaff(officeId, "ret-staff", "staff");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  client = (await mustInsertClient(as.staff, officeId, { name: "Returnable client", client_type: "individual", incharge_id: u.staff.id })).id;
  bank = await typeId(officeId, T.bank);
  apr = await periodId(officeId, "2026-04");
}, 120_000);

afterAll(async () => {
  await retireStaff([u.manager, u.staff].filter(Boolean).map((x) => x.id));
});

describe("storage (AC-9, AC-10)", () => {
  it("no document anywhere is stored as 'original' after the migration", async () => {
    const { count, error } = await adminClient().from("document").select("id", { count: "exact", head: true }).eq("received_as", "original");
    expect(error).toBeNull();
    expect(count).toBe(0);
  });

  // Corrected in step 3 (plan Deviations): the trigger maps 'original' on every write path before the check
  // constraint runs, so even a direct table write can't store it — it lands as hard copy + returnable.
  it("a direct write of 'original' is never stored as 'original' (mapped to hard copy + returnable)", async () => {
    const d = await hard();
    const { error } = await adminClient().from("document").update({ received_as: "original" }).eq("id", d.id);
    expect(error).toBeNull();
    expect(await documentRow(d.id)).toMatchObject({ received_as: "hard_copy", returnable: true });
  });

  it("legacy input 'original' is stored as a hard copy + returnable", async () => {
    const d = await hard({ received_as: "original" });
    expect(await documentRow(d.id)).toMatchObject({ received_as: "hard_copy", returnable: true });
  });

  it("a hard copy can be created returnable or not; a plain hard copy is not returnable", async () => {
    expect(await documentRow((await hard({ received_as: "hard_copy", returnable: true })).id)).toMatchObject({ returnable: true });
    expect(await documentRow((await hard({ received_as: "hard_copy" })).id)).toMatchObject({ received_as: "hard_copy", returnable: false });
  });

  it("only a hard copy can be returnable (AC-8, Q6)", async () => {
    const { error } = await as.staff.rpc("create_document", { p: { received_as: "soft_copy", returnable: true, channel: "email",
      client_id: client, doc_type_id: bank, period_id: apr, file: null } });
    expect(error?.message ?? "").toMatch(/RETURNABLE_HARD_COPY|SOFT_COPY_NEEDS_FILE/);
    const s = await createSoftCopy(as.staff, officeId, { client_id: client, doc_type_id: bank, period_id: apr });
    expect((await update(s.id, { returnable: true })).error?.message ?? "").toMatch(/RETURNABLE_HARD_COPY/);
  });

  it("legacy update rule: received_as without returnable takes the old meaning", async () => {
    const d = await hard({ received_as: "hard_copy", returnable: true });
    expect((await update(d.id, { received_as: "hard_copy" })).error).toBeNull();
    expect(await documentRow(d.id)).toMatchObject({ returnable: false });
    expect((await update(d.id, { received_as: "original" })).error).toBeNull();
    expect(await documentRow(d.id)).toMatchObject({ received_as: "hard_copy", returnable: true });
    expect((await update(d.id, { remark: "no change to returnable" })).error).toBeNull();
    expect(await documentRow(d.id)).toMatchObject({ returnable: true });
  });
});

describe("dispatch follows returnable (AC-11, AC-12)", () => {
  it("a reviewed returnable hard copy can be dispatched; a reviewed plain hard copy can't", async () => {
    const r = await hard({ received_as: "hard_copy", returnable: true });
    const plain = await hard({ received_as: "hard_copy" });
    await mustReview(as.staff, r.id);
    await mustReview(as.staff, plain.id);
    expect((await createDispatch(as.staff, { client_id: client, document_ids: [plain.id], dispatched_on: "2026-05-10" })).error?.message ?? "")
      .toMatch(/NOT_ELIGIBLE/);
    expect((await createDispatch(as.staff, { client_id: client, document_ids: [r.id], dispatched_on: "2026-05-10" })).error).toBeNull();
  });

  it("while dispatched, Returnable can't be turned off (07's lock extended)", async () => {
    const r = await hard({ received_as: "hard_copy", returnable: true });
    await mustReview(as.staff, r.id);
    await mustDispatch(as.staff, { client_id: client, document_ids: [r.id], dispatched_on: "2026-05-10" });
    expect((await update(r.id, { received_as: "hard_copy", returnable: false })).error?.message ?? "").toMatch(/DISPATCHED/);
    expect(await documentRow(r.id)).toMatchObject({ returnable: true });
  });
});

describe("search and Today follow returnable (AC-11, AC-13)", () => {
  let ready: string, plainReviewed: string;
  beforeAll(async () => {
    ready = (await hard({ received_as: "hard_copy", returnable: true, received_on: "2026-05-03" })).id;
    plainReviewed = (await hard({ received_as: "hard_copy", received_on: "2026-05-03" })).id;
    await mustReview(as.staff, ready);
    await mustReview(as.staff, plainReviewed);
  });

  it("rows carry returnable; the Returnable filter lists returnable hard copies only", async () => {
    const rows = await search({ returnable: true });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.returnable && r.received_as === "hard_copy")).toBe(true);
    expect(rows.map((r) => r.id)).toContain(ready);
    expect(rows.map((r) => r.id)).not.toContain(plainReviewed);
  });

  it("an old received_as=original filter means hard copy + returnable", async () => {
    const legacy = (await search({ received_as: "original" })).map((r) => r.id).sort();
    expect(legacy).toEqual((await search({ returnable: true })).map((r) => r.id).sort());
  });

  it("Return = ready lists a reviewed returnable hard copy, not a reviewed plain one", async () => {
    const ids = (await search({ return: "ready" })).map((r) => r.id);
    expect(ids).toContain(ready);
    expect(ids).not.toContain(plainReviewed);
  });

  it("the received-as facet offers hard copy (never 'original')", async () => {
    const { data, error } = await as.staff.rpc("search_document_facets", { p: { filters: { client_id: client } } });
    expect(error).toBeNull();
    const values = (data as Array<{ facet: string; value: string }>).filter((f) => f.facet === "received_as").map((f) => f.value);
    expect(values).toContain("hard_copy");
    expect(values).not.toContain("original");
  });

  it("Today shows a reviewed returnable hard copy as Ready to dispatch, and not a plain one", async () => {
    type Data = { cards: Array<{ rows: Array<{ kind: string; document_id?: string; returnable?: boolean }> }> };
    const data = await mustRpc<Data>(as.staff, "today_items", { p_scope: "everyone", p_show: null, p_page: 0, p_limit: 100 });
    const rows = data.cards.flatMap((c) => c.rows);
    expect(rows.find((r) => r.document_id === ready)).toMatchObject({ kind: "ready", returnable: true });
    expect(rows.find((r) => r.document_id === plainReviewed)).toBeUndefined();
  });
});

describe("client upload links stay soft copies (AC-16)", () => {
  it("returnable defaults to false and a link upload never sets it", async () => {
    const s = await createSoftCopy(as.staff, officeId, { client_id: client, doc_type_id: bank, period_id: apr });
    expect(await documentRow(s.id)).toMatchObject({ received_as: "soft_copy", returnable: false, handed_over_kind: null });
  });
});
