import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, mustCreateDocument, periodId, typeId } from "../support/documents";
import { T, bankOnlyClient } from "../support/expected";
import { feed, insertActivity, mustFeed, type FeedRow } from "../support/activity";

// Feature 15 (spec AC-8, U1; plan step 2) — `activity_feed` with a `document_id` returns exactly the activity rows
// the viewer may see that name the document, by any reference kind, newest first, paged by the cursor. The expected
// rows are computed here, independently of the function: the raw rows (service role) that reference the document
// as the entity, as `data.document_id` or inside `data.document_ids`, kept only if the viewer can read them (RLS on
// the table: 08's activity_select), ordered by (created_at, id) desc. Green against 08's body (before migration A)
// and must stay green after it: the K4 rewrite may change speed, never results.

type Who = "admin" | "staff" | "limited";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
let clientA: string, clientB: string, docA: string, docB: string, docA2: string;

async function oracle(who: SupabaseClient, documentId: string): Promise<number[]> {
  const { data: raw, error } = await adminClient().from("activity").select("id, created_at, entity_type, entity_id, data")
    .eq("office_id", officeId).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(5000);
  if (error) throw error;
  const refs = (raw ?? []).filter((r) => (r.entity_type === "document" && r.entity_id === documentId)
    || (r.data as Record<string, unknown>)?.document_id === documentId
    || (Array.isArray((r.data as Record<string, unknown>)?.document_ids) && ((r.data as { document_ids: string[] }).document_ids).includes(documentId)));
  const ids = refs.map((r) => Number(r.id));
  if (ids.length === 0) return [];
  const { data: visible, error: e2 } = await who.from("activity").select("id").in("id", ids);
  if (e2) throw e2;
  const seen = new Set((visible ?? []).map((r) => Number(r.id)));
  return ids.filter((id) => seen.has(id));
}

async function allPages(who: SupabaseClient, documentId: string, limit: number): Promise<FeedRow[]> {
  const out: FeedRow[] = [];
  let before: { at: string; id: number } | null = null;
  for (let i = 0; i < 50; i++) {
    const page = await mustFeed(who, { document_id: documentId, limit, ...(before ? { before } : {}) });
    out.push(...page.rows);
    if (!page.next) break;
    before = page.next;
  }
  return out;
}

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

beforeAll(async () => {
  officeId = await createDocumentOffice("doc-activity");
  u.admin = await createStaff(officeId, "dact-admin", "admin");
  u.staff = await createStaff(officeId, "dact-staff", "staff");
  u.limited = await createStaff(officeId, "dact-limited", "limited");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  clientA = await bankOnlyClient(as.staff, officeId, { name: "Doc activity A", incharge_id: u.limited.id }); // Limited sees A
  clientB = await bankOnlyClient(as.staff, officeId, { name: "Doc activity B", incharge_id: u.staff.id }); // not B
  const bank = await typeId(officeId, T.bank);
  const apr = await periodId(officeId, "2026-04");
  const mk = async (c: string) => (await mustCreateDocument(as.staff, { client_id: c, doc_type_id: bank, period_id: apr, received_on: "2026-05-02" } as never)).id;
  docA = await mk(clientA);
  docA2 = await mk(clientA);
  docB = await mk(clientB);
  // Every reference kind, on fixed, distinct times (minutes ago), plus near-misses that must not match.
  await insertActivity(officeId, [
    { actor_id: u.staff.id, action: "document.updated", entity_type: "document", entity_id: docA, data: { client_id: clientA, fields: ["remark"] }, created_at: at(50) },
    { actor_id: u.staff.id, action: "dispatch.created", entity_type: "dispatch", entity_id: randomUUID(), data: { client_id: clientA, document_ids: [docA2, docA], method: "courier" }, created_at: at(40) },
    { actor_id: u.admin.id, action: "dispatch.item_removed", entity_type: "dispatch", entity_id: randomUUID(), data: { document_id: docA }, created_at: at(30) },
    { actor_id: u.staff.id, action: "upload_request_item.filed", entity_type: "upload_request_item", entity_id: randomUUID(), data: { client_id: clientA, document_id: docA }, created_at: at(20) },
    { actor_id: u.staff.id, action: "document.updated", entity_type: "document", entity_id: docA2, data: { client_id: clientA, fields: ["remark"] }, created_at: at(15) },
    { actor_id: u.staff.id, action: "document.updated", entity_type: "client", entity_id: docA, data: { client_id: clientA }, created_at: at(12) }, // wrong entity type
    { actor_id: u.staff.id, action: "document.updated", entity_type: "document", entity_id: docB, data: { client_id: clientB, note_id: docA }, created_at: at(10) }, // docA under another key
    // A row about docA filed under client B's context: Staff see it; Limited follow data.client_id (B) and don't.
    { actor_id: u.staff.id, action: "upload_request_item.filed", entity_type: "upload_request_item", entity_id: randomUUID(), data: { client_id: clientB, document_id: docA }, created_at: at(5) },
    // Same timestamp twice: the id breaks the tie.
    { actor_id: u.staff.id, action: "document.updated", entity_type: "document", entity_id: docA, data: { client_id: clientA, fields: ["remark"] }, created_at: at(3) },
    { actor_id: u.staff.id, action: "document.updated", entity_type: "document", entity_id: docA, data: { client_id: clientA, fields: ["channel"] }, created_at: at(3) },
  ]);
}, 120_000);

afterAll(async () => {
  await retireStaff(Object.values(u).filter(Boolean).map((x) => x.id));
});

describe("activity_feed by document = every visible reference, newest first (AC-8)", () => {
  for (const who of ["admin", "staff", "limited"] as Who[]) {
    it(`${who}: one page equals the independent result, for each document`, async () => {
      for (const d of [() => docA, () => docA2, () => docB]) {
        const expected = await oracle(as[who], d());
        const page = await mustFeed(as[who], { document_id: d(), limit: 100 });
        expect(page.rows.map((r) => r.id)).toEqual(expected);
      }
    });

    it(`${who}: paging by 2 with the cursor returns the same rows, in order, once each`, async () => {
      const expected = await oracle(as[who], docA);
      expect((await allPages(as[who], docA, 2)).map((r) => r.id)).toEqual(expected);
    });
  }

  it("the reference kinds are all there for Staff (entity, document_ids, document_id) and the near-misses are not", async () => {
    const rows = (await mustFeed(as.staff, { document_id: docA, limit: 100 })).rows;
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["dispatch.created", "dispatch.item_removed", "upload_request_item.filed", "document.updated"]));
    expect(rows.some((r) => r.entity_type === "client")).toBe(false);
    expect(rows.some((r) => r.entity_id === docB)).toBe(false);
  });

  it("Limited never sees a row about the document that belongs to a client they can't see", async () => {
    const ids = (await mustFeed(as.limited, { document_id: docA, limit: 100 })).rows.map((r) => r.id);
    const staffIds = (await mustFeed(as.staff, { document_id: docA, limit: 100 })).rows.map((r) => r.id);
    expect(staffIds.length).toBeGreaterThan(ids.length);
    expect((await mustFeed(as.limited, { document_id: docB, limit: 100 })).rows).toEqual([]);
  });

  it("combined with other filters (actions, staff, dates) it still narrows, not widens", async () => {
    const onlyRemoved = await mustFeed(as.staff, { document_id: docA, actions: ["dispatch.item_removed"], limit: 100 });
    expect(onlyRemoved.rows.map((r) => r.action)).toEqual(["dispatch.item_removed"]);
    const byAdmin = await mustFeed(as.staff, { document_id: docA, staff_id: u.admin.id, limit: 100 });
    expect(byAdmin.rows.every((r) => r.actor_id === u.admin.id)).toBe(true);
    const r = await feed(as.staff, { document_id: "not-a-uuid" });
    expect(r.error ?? "").toMatch(/INVALID_FILTER: document_id/);
  });
});
