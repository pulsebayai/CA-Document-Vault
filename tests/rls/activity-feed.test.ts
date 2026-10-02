import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { mustInsertClient } from "../support/catalogue";
import { createDocumentOffice, mustCreateDocument, mustCreateOriginal, mustDispatch, periodId, typeId } from "../support/documents";
import { T } from "../support/expected";
import { feed, insertActivity, mustFeed, type FeedRow } from "../support/activity";

// Feature 08 — activity_feed (spec AC-5, AC-7 … AC-10, AC-15). Written before the migration (plan step 2).
// Contract: tests/support/activity.ts. Activity isn't purged between runs, so every assertion is scoped to a client,
// document or actor created/used only by this file, with synthetic rows at fixed times.
// Client A: Limited is incharge. Client B: Staff is incharge (Limited can't see it).

type Who = "admin" | "staff" | "limited" | "signin";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
let clientA: string;
let clientB: string;
let bank: string;
let apr: string;

const actions = (rows: FeedRow[]) => rows.map((r) => r.action);
const idsOf = (rows: FeedRow[]) => rows.map((r) => r.id);
const iso = (s: string) => new Date(s).toISOString();

beforeAll(async () => {
  officeId = await createDocumentOffice("activity-feed");
  u.admin = await createStaff(officeId, "fd-admin", "admin");
  u.staff = await createStaff(officeId, "fd-staff", "staff");
  u.limited = await createStaff(officeId, "fd-limited", "limited");
  u.signin = await createStaff(officeId, "fd-signin", "staff");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  clientA = (await mustInsertClient(as.staff, officeId, { name: "Feed A", client_type: "individual", incharge_id: u.limited.id })).id;
  clientB = (await mustInsertClient(as.staff, officeId, { name: "Feed B", client_type: "individual", incharge_id: u.staff.id })).id;
  bank = await typeId(officeId, T.bank);
  apr = await periodId(officeId, "2026-04");
}, 120_000);

afterAll(async () => {
  await retireStaff([u.staff, u.limited, u.signin].filter(Boolean).map((x) => x.id));
  await retireStaff([u.admin].filter(Boolean).map((x) => x.id));
});

describe("order and paging (AC-5)", () => {
  it("newest first by (time, id); 50 per page; Load earlier continues with no gap or repeat", async () => {
    const base = Date.parse("2026-09-01T06:00:00Z");
    const rows = Array.from({ length: 120 }, (_, i) => ({
      actor_id: u.staff.id, action: "client.updated", entity_type: "client", entity_id: clientA,
      data: { client_id: clientA, fields: ["name"] },
      // Pairs share a timestamp so the id tie-break is exercised.
      created_at: new Date(base + Math.floor(i / 2) * 60_000).toISOString(),
    }));
    const inserted = await insertActivity(officeId, rows);
    const expected = [...inserted].sort((a, b) => b - a); // same order as (created_at desc, id desc) here

    const p1 = await mustFeed(as.staff, { client_id: clientA, to: "2026-09-01" });
    expect(p1.rows).toHaveLength(50);
    expect(p1.next).not.toBeNull();
    const p2 = await mustFeed(as.staff, { client_id: clientA, to: "2026-09-01", before: p1.next });
    const p3 = await mustFeed(as.staff, { client_id: clientA, to: "2026-09-01", before: p2.next });
    expect(p3.rows).toHaveLength(20);
    expect(p3.next).toBeNull();
    expect([...idsOf(p1.rows), ...idsOf(p2.rows), ...idsOf(p3.rows)]).toEqual(expected);
  });

  it("limit is capped at 100", async () => {
    const page = await mustFeed(as.staff, { client_id: clientA, to: "2026-09-01", limit: 500 });
    expect(page.rows).toHaveLength(100);
  });
});

describe("display fields (AC-5, AC-6)", () => {
  it("joins actor, client, DOC-ID, type and group under the viewer's RLS; system rows have no actor", async () => {
    const d = await mustCreateDocument(as.staff, { client_id: clientA, doc_type_id: bank, period_id: apr, received_on: "2026-05-02" });
    const { rows } = await mustFeed(as.admin, { document_id: d.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "document.added", actor_id: u.staff.id, actor_name: "Test fd-staff",
      client_id: clientA, client_name: "Feed A", document_id: d.id, doc_code: d.doc_code,
      doc_type_name: T.bank, doc_group_name: "Banking",
    });
    const [sys] = await insertActivity(officeId, [{
      actor_id: null, action: "expected.auto_waived", entity_type: "expected_doc", entity_id: null,
      data: { client_id: clientA, code: "removed" }, created_at: iso("2026-08-01T06:00:00Z"),
    }]);
    const page = await mustFeed(as.admin, { client_id: clientA, from: "2026-08-01", to: "2026-08-01" });
    expect(page.rows.find((r) => r.id === sys)).toMatchObject({ actor_id: null, actor_name: null, client_name: "Feed A" });
  });

  it("Limited sees the same page minus rows it can't read", async () => {
    const [a, b] = await insertActivity(officeId, [
      { actor_id: u.staff.id, action: "client.updated", entity_type: "client", entity_id: clientA, data: { client_id: clientA }, created_at: iso("2026-07-01T06:00:00Z") },
      { actor_id: u.staff.id, action: "client.updated", entity_type: "client", entity_id: clientB, data: { client_id: clientB }, created_at: iso("2026-07-01T06:01:00Z") },
    ]);
    const lim = await mustFeed(as.limited, { from: "2026-07-01", to: "2026-07-01", staff_id: u.staff.id });
    expect(idsOf(lim.rows)).toContain(a);
    expect(idsOf(lim.rows)).not.toContain(b);
    const hidden = await mustFeed(as.limited, { client_id: clientB });
    expect(hidden.rows).toEqual([]);
  });
});

describe("filters (AC-7, AC-10)", () => {
  it("client filter matches rows whose client comes from the entity, not only data.client_id", async () => {
    const d = await mustCreateDocument(as.staff, { client_id: clientB, doc_type_id: bank, period_id: apr, received_on: "2026-05-02" });
    const [row] = await insertActivity(officeId, [{ actor_id: u.staff.id, action: "document.version_added", entity_type: "document", entity_id: d.id, data: { version_no: 2 } }]);
    expect(idsOf((await mustFeed(as.staff, { client_id: clientB })).rows)).toContain(row);
    expect(idsOf((await mustFeed(as.staff, { client_id: clientA })).rows)).not.toContain(row);
  });

  it("staff, action list and IST date range combine", async () => {
    const rows = await insertActivity(officeId, [
      // 1 Oct 00:15 IST = 30 Sep 18:45 UTC
      { actor_id: u.limited.id, action: "document.reviewed", entity_type: "client", entity_id: clientA, data: { client_id: clientA }, created_at: iso("2026-09-30T18:45:00Z") },
      { actor_id: u.staff.id, action: "document.reviewed", entity_type: "client", entity_id: clientA, data: { client_id: clientA }, created_at: iso("2026-09-30T18:46:00Z") },
      { actor_id: u.limited.id, action: "client.updated", entity_type: "client", entity_id: clientA, data: { client_id: clientA }, created_at: iso("2026-09-30T18:47:00Z") },
      // 30 Sep 23:59 IST
      { actor_id: u.limited.id, action: "document.reviewed", entity_type: "client", entity_id: clientA, data: { client_id: clientA }, created_at: iso("2026-09-30T18:29:00Z") },
    ]);
    const page = await mustFeed(as.staff, {
      client_id: clientA, staff_id: u.limited.id, actions: ["document.reviewed", "dispatch.created"], from: "2026-10-01", to: "2026-10-01",
    });
    expect(idsOf(page.rows)).toEqual([rows[0]]);
    const sept30 = await mustFeed(as.staff, { client_id: clientA, staff_id: u.limited.id, actions: ["document.reviewed"], from: "2026-09-30", to: "2026-09-30" });
    expect(idsOf(sept30.rows)).toEqual([rows[3]]);
  });

  it("document filter returns the document's own rows and dispatch rows naming it, newest first", async () => {
    const d = await mustCreateOriginal(as.staff, { client_id: clientA, doc_type_id: bank, period_id: apr, received_on: "2026-05-02" }, as.staff);
    await mustDispatch(as.staff, { client_id: clientA, document_ids: [d.id], dispatched_on: "2026-09-01" });
    const { error } = await as.admin.rpc("undo_dispatch_item", { p_document_id: d.id, p_reason: "Wrong packet" });
    if (error) throw new Error(error.message);
    const page = await mustFeed(as.staff, { document_id: d.id });
    expect(actions(page.rows)).toEqual(["dispatch.item_removed", "dispatch.created", "document.reviewed", "document.added"]);
  });

  it("rejects malformed filters with a plain error code", async () => {
    for (const p of [{ client_id: "x" }, { from: "1 Oct" }, { before: { at: "nope", id: 1 } }, { actions: "document.added" }]) {
      expect((await feed(as.staff, p)).error ?? "").toMatch(/INVALID/);
    }
  });
});

describe("sign-ins (AC-8)", () => {
  it("are hidden unless the action filter asks for them", async () => {
    const [signin, other] = await insertActivity(officeId, [
      { actor_id: u.signin.id, action: "auth.signed_in", entity_type: "staff_user", entity_id: u.signin.id, data: { method: "code" } },
      { actor_id: u.signin.id, action: "client.updated", entity_type: "client", entity_id: clientA, data: { client_id: clientA } },
    ]);
    const plain = await mustFeed(as.admin, { staff_id: u.signin.id, limit: 100 });
    expect(idsOf(plain.rows)).toContain(other);
    expect(actions(plain.rows)).not.toContain("auth.signed_in");
    const only = await mustFeed(as.admin, { staff_id: u.signin.id, actions: ["auth.signed_in"], limit: 100 });
    expect(idsOf(only.rows)).toContain(signin);
    expect(new Set(actions(only.rows))).toEqual(new Set(["auth.signed_in"]));
  });
});

// AC-15 — nightly only. Median of 5 warm calls, so one slow round trip (US runner → Mumbai) can't fail it.
describe.skipIf(!process.env.RUN_SLOW)("first page speed (nightly)", () => {
  it("first Activity page < 1 s for Staff and Limited", async () => {
    for (const k of ["staff", "limited"] as const) {
      await mustFeed(as[k]);
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        await mustFeed(as[k]);
        times.push(performance.now() - t0);
      }
      expect(times.sort((a, b) => a - b)[2]).toBeLessThan(1000);
    }
  });
});
