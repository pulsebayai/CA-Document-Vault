import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { groupId } from "../support/catalogue";
import {
  createDocumentOffice, mustCreateDocument, mustCreateOriginal, mustDispatch, mustReview, periodId, typeId,
} from "../support/documents";
import { T, bankOnlyClient, generateAsOf, mustRpc, rpc, type TodayDocCounts, type TodayDocRow } from "../support/expected";

// Feature 06 step 9 — Today's To review / Ready to dispatch rows and counts (spec AC-2, AC-4, AC-5; 07's states).
// Written before migration 2. Contract: tests/support/expected.ts ("step 9").
//
// Clock 15 Mar 2026: no expected item is asked yet, so every Today row here is a document.
//   Alpha (incharge s1; Banking group assigned s2 → s2's):
//     toReview  hard copy, Mar          → To review
//     ready     original, Apr, reviewed  → Ready to dispatch
//     fixCopy   original, Feb, needs correction → Ready to dispatch (07: still owed back)
//     sent      original, Jan, reviewed + dispatched → not on Today
//     done      hard copy, Dec, reviewed → not on Today (nothing to do)
//     archived  hard copy, Nov, archived → not on Today
//   Bravo (incharge limited): bravoDoc hard copy → To review (limited's)
//   Inbox document (no client) → never on Today.

type Who = "admin" | "manager" | "s1" | "s2" | "limited";
type Card = { client_id: string; name: string; to_review: number; ready: number; rows: Array<TodayDocRow | { kind: string }> };
type Data = { counts: TodayDocCounts; clients: number; cards: Card[]; has_more: boolean };
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
let alpha: string, bravo: string;
const d = {} as Record<"toReview" | "ready" | "fixCopy" | "sent" | "done" | "archived" | "bravoDoc" | "inbox", string>;

const today = (who: SupabaseClient, scope: string, show: string | null = null) =>
  mustRpc<Data>(who, "today_items", { p_scope: scope, p_show: show, p_page: 0, p_limit: 100 });
const docRows = (data: Data) => data.cards.flatMap((c) => c.rows.filter((r): r is TodayDocRow => "document_id" in r));
const ids = (data: Data) => docRows(data).map((r) => r.document_id).sort();

beforeAll(async () => {
  officeId = await createDocumentOffice("today-docs");
  u.admin = await createStaff(officeId, "tdd-admin", "admin");
  u.manager = await createStaff(officeId, "tdd-manager", "manager");
  u.s1 = await createStaff(officeId, "tdd-s1", "staff");
  u.s2 = await createStaff(officeId, "tdd-s2", "staff");
  u.limited = await createStaff(officeId, "tdd-limited", "limited");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  await generateAsOf(as.admin, "2026-03-15");
  alpha = await bankOnlyClient(as.s1, officeId, { name: "Docs Alpha", incharge_id: u.s1.id });
  bravo = await bankOnlyClient(as.s1, officeId, { name: "Docs Bravo", incharge_id: u.limited.id });
  const { error } = await as.manager.from("client_group").update({ assigned_staff_id: u.s2.id })
    .eq("client_id", alpha).eq("doc_group_id", await groupId(officeId, "Banking"));
  if (error) throw error;
  const bank = await typeId(officeId, T.bank);
  const doc = async (client: string, period: string, on: string) =>
    ({ client_id: client, doc_type_id: bank, period_id: await periodId(officeId, period), received_on: on });
  d.toReview = (await mustCreateDocument(as.s1, { ...(await doc(alpha, "2026-03", "2026-03-10")), received_as: "hard_copy" })).id;
  d.ready = (await mustCreateOriginal(as.s1, await doc(alpha, "2025-04", "2026-03-11"), as.s1)).id;
  d.fixCopy = (await mustCreateOriginal(as.s1, await doc(alpha, "2026-02", "2026-03-09"))).id;
  await mustReview(as.s1, d.fixCopy, "needs_correction", "Pages missing");
  d.sent = (await mustCreateOriginal(as.s1, await doc(alpha, "2026-01", "2026-03-08"), as.s1)).id;
  await mustDispatch(as.s1, { client_id: alpha, document_ids: [d.sent], dispatched_on: "2026-03-12" });
  d.done = (await mustCreateDocument(as.s1, { ...(await doc(alpha, "2025-12", "2026-03-07")), received_as: "hard_copy" })).id;
  await mustReview(as.s1, d.done);
  d.archived = (await mustCreateDocument(as.s1, { ...(await doc(alpha, "2025-11", "2026-03-06")), received_as: "hard_copy" })).id;
  expect((await as.manager.rpc("archive_document", { p_id: d.archived, p_reason: "Duplicate upload" })).error).toBeNull();
  d.bravoDoc = (await mustCreateDocument(as.s1, { ...(await doc(bravo, "2026-03", "2026-03-10")), received_as: "hard_copy" })).id;
  d.inbox = (await mustCreateDocument(as.s1, { received_on: "2026-03-10" })).id;
}, 180_000);

afterAll(async () => {
  await retireStaff([u.manager, u.s1, u.s2, u.limited].filter(Boolean).map((x) => x.id));
  if (u.admin) await retireStaff([u.admin.id]);
});

describe("Today document rows (AC-2, AC-5; 07 states)", () => {
  it("Everyone lists To review and Ready to dispatch only — not dispatched, nothing-to-do, archived or Inbox documents", async () => {
    const data = await today(as.manager, "everyone");
    expect(ids(data)).toEqual([d.toReview, d.ready, d.fixCopy, d.bravoDoc].sort());
    expect(data.counts).toMatchObject({ overdue: 0, due_week: 0, to_review: 2, ready: 2 });
    expect(data.clients).toBe(2);
  });

  it("counts = rows for every filter, and the filter keeps only that kind", async () => {
    for (const show of ["to_review", "ready"] as const) {
      const all = await today(as.manager, "everyone");
      const filtered = await today(as.manager, "everyone", show);
      expect(docRows(filtered).every((r) => r.kind === show)).toBe(true);
      expect(docRows(filtered).length).toBe(all.counts[show]);
      expect(filtered.clients).toBe(filtered.cards.length);
    }
    expect((await today(as.manager, "everyone", "ready")).cards.map((c) => c.client_id)).toEqual([alpha]);
  });

  it("row content: DOC-ID, group, type, period, received as/on; ready rows carry the reviewer or Needs correction", async () => {
    const rows = docRows(await today(as.manager, "everyone"));
    const r = rows.find((x) => x.document_id === d.toReview)!;
    expect(r).toMatchObject({ kind: "to_review", group: "Banking", type: T.bank, period: "Mar 2026", received_as: "hard_copy",
      received_on: "2026-03-10", reviewed_on: null, reviewed_by: null, needs_correction: false });
    expect(r.doc_code).toMatch(/^DOC-FY\d{2}-\d{2}-\d{5}$/);
    expect(rows.find((x) => x.document_id === d.ready)).toMatchObject({ kind: "ready", received_as: "original", reviewed_by: "Test tdd-s1", needs_correction: false });
    expect(rows.find((x) => x.document_id === d.ready)!.reviewed_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rows.find((x) => x.document_id === d.fixCopy)).toMatchObject({ kind: "ready", needs_correction: true });
  });

  it("a card lists its rows Overdue → Due → To review → Ready, and counts its own documents", async () => {
    const card = (await today(as.manager, "everyone")).cards.find((c) => c.client_id === alpha)!;
    expect(card.rows.map((r) => r.kind)).toEqual(["to_review", "ready", "ready"]);
    expect(card).toMatchObject({ to_review: 1, ready: 2 });
  });
});

describe("Mine = plan row → group → incharge, for documents too (AC-3)", () => {
  it("Alpha's Banking documents belong to the group's assignee, not the incharge", async () => {
    expect(ids(await today(as.s2, "mine"))).toEqual([d.toReview, d.ready, d.fixCopy].sort());
    expect(ids(await today(as.s1, "mine"))).toEqual([]);
    expect(ids(await today(as.limited, "mine"))).toEqual([d.bravoDoc]);
  });

  it("Limited sees only their clients' documents under Everyone", async () => {
    expect(ids(await today(as.limited, "everyone"))).toEqual([d.bravoDoc]);
  });
});

describe("rows leave Today when the work is done", () => {
  it("Mark reviewed moves a hard copy off Today; dispatch moves an original off it", async () => {
    await mustReview(as.s2, d.toReview);
    await mustDispatch(as.s2, { client_id: alpha, document_ids: [d.ready], dispatched_on: "2026-03-14" });
    const data = await today(as.s2, "mine");
    expect(ids(data)).toEqual([d.fixCopy]);
    expect(data.counts).toMatchObject({ to_review: 0, ready: 1 });
  });

  it("still rejects anything but the enums", async () => {
    expect((await rpc(as.s1, "today_items", { p_scope: "mine", p_show: "reviewed" })).error).toMatch(/BAD_SHOW/);
  });

  it("the Inbox document is untouched and unseen", async () => {
    const { data } = await adminClient().from("document").select("client_id").eq("id", d.inbox).single();
    expect(data!.client_id).toBeNull();
  });
});
