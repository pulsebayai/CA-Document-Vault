import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { groupId } from "../support/catalogue";
import { createDocumentOffice } from "../support/documents";
import {
  CLOCK_END, CLOCK_START, VOLUME, VOLUME_GROUPS, ping, record, timeIt, timings, volumeOffice, type VolumeCtx,
} from "../support/volume";
import { CLIENT_DOCUMENTS_SELECT } from "@/lib/documents/selects";
import { EXPECTED_SELECT } from "@/lib/expected/shape";
import { testGstin, testPan, testTan } from "../support/test-data";

// 09 volume test (chore, R1 gate; plan sdlc/features/09-volume-test/plan.md, approved by Raja 2026-10-07).
// V1–V10 at pilot volume in the persistent "e2e office volume" (1,000 clients, ≈ 183k expected items,
// 10k documents, 200k activity rows). VOLUME=1 only (Regression input `volume`, or locally); never nightly.
// Each call is the one the app makes (same function, same arguments, as the right role), median of 5 warm calls;
// server time ≈ round trip − a trivial-read ping. **A missed target is recorded, not fixed (Raja 2026-10-07):**
// it is written to the evidence and logged as MISSED, and the test fails only on an error (e.g. a timeout) —
// set VOLUME_STRICT=1 to fail on misses as well.

const strict = process.env.VOLUME_STRICT === "1";
const check = (row: { pass: boolean; id: string }) => { if (strict) expect(row.pass, `${row.id} missed its target`).toBe(true); };

describe.skipIf(!process.env.VOLUME)("volume (09, R1 gate)", () => {
  let v: VolumeCtx;
  let pingMs: number;
  const search = (as: SupabaseClient, p: Record<string, unknown>) => as.rpc("search_documents", { p });
  const facets = (as: SupabaseClient, p: Record<string, unknown>) => as.rpc("search_document_facets", { p });
  const page1 = { filters: {}, include_archived: false, sort: "received", page: 1 };

  beforeAll(async () => {
    v = await volumeOffice();
    pingMs = await ping(v.as.staff);
    console.log("volume: ping (ms)", Math.round(pingMs));
  }, 3_600_000);

  afterAll(() => {
    mkdirSync("test-results", { recursive: true });
    writeFileSync("test-results/volume-timings.json", JSON.stringify({ pingMs: Math.round(pingMs ?? 0), seed: v?.seed ?? null, timings }, null, 2));
  });

  it("V1 header suggestions (5 clients + 5 documents, as the header sends them) < 300 ms", async () => {
    const rt = await timeIt(() => Promise.all([
      v.as.staff.rpc("search_clients", { p_query: "bank", p_limit: 5, p_offset: 0 }),
      search(v.as.staff, { text: "bank", ...page1, page_size: 5 }),
    ]));
    check(record("V1", "Header suggestions (\"bank\")", 300, rt, pingMs));
  });

  it("V2 /documents first page + facets < 1 s", async () => {
    const rt = await timeIt(() => Promise.all([search(v.as.staff, page1), facets(v.as.staff, page1)]));
    check(record("V2", "/documents page 1 + facets (Staff, no text)", 1000, rt, pingMs));
    const rt2 = await timeIt(() => Promise.all([search(v.as.staff, { ...page1, text: "bank" }), facets(v.as.staff, { ...page1, text: "bank" })]));
    check(record("V2", "/documents page 1 + facets (Staff, \"bank\")", 1000, rt2, pingMs));
  });

  it("V3 a Limited user's search < 1 s", async () => {
    const rt = await timeIt(() => Promise.all([search(v.as.limited, { ...page1, text: "bank" }), facets(v.as.limited, { ...page1, text: "bank" })]));
    check(record("V3", "/documents page 1 + facets (Limited, \"bank\")", 1000, rt, pingMs));
  });

  // V4 (daily job < 60 s) is timed inside the database by scripts/volume-v4.sql: the job runs in pg_cron, which has no
  // statement timeout, while every API call here is cut off at 8 s (the job alone is longer than that at this size).

  it("V5 Clients list · Client › Expected · Client › Documents < 1 s each", async () => {
    const list = (hasOverdue: boolean) => Promise.all([
      v.as.staff.rpc("search_clients", { p_query: null, p_client_type: null, p_incharge_id: null, p_include_archived: false,
        p_limit: 50, p_offset: 0, p_has_overdue: hasOverdue }),
      v.as.staff.from("client").select("id", { count: "exact", head: true }).is("archived_at", null),
    ]);
    check(record("V5a", "Clients list, page 1 with overdue counts", 1000, await timeIt(() => list(false)), pingMs));
    check(record("V5a", "Clients list, \"Has overdue\"", 1000, await timeIt(() => list(true)), pingMs));
    const expectedTab = async () => {
      const out = [];
      for (let from = 0; ; from += 1000) {
        const r = await v.as.staff.from("expected_doc").select(EXPECTED_SELECT).eq("client_id", v.busyClientId).order("id").range(from, from + 999);
        out.push(r);
        if (r.error || (r.data ?? []).length < 1000) break;
      }
      out.push(await v.as.staff.from("client_registration").select("kind, active").eq("client_id", v.busyClientId));
      return out;
    };
    check(record("V5b", "Client › Expected (busiest Staff client)", 1000, await timeIt(expectedTab), pingMs));
    const docsTab = () => Promise.all([
      v.as.staff.from("document").select(CLIENT_DOCUMENTS_SELECT).eq("client_id", v.busyClientId).not("classified_at", "is", null)
        .is("archived_at", null).order("received_on", { ascending: false }).limit(2000),
      expectedTab(),
    ]);
    check(record("V5c", "Client › Documents (list + open-item cards)", 1000, await timeIt(docsTab), pingMs));
  }, 180_000);

  it("V6 Collection metric < 2 s", async () => {
    const rt = await timeIt(() => v.as.admin.rpc("collection_metric", { p_from: "2026-04-01", p_to: CLOCK_END }));
    check(record("V6", "Collection metric, FY 2026-27", 2000, rt, pingMs));
  }, 180_000);

  it("V7 a document save adds < 50 ms against an empty office", async () => {
    // Baseline: the same client shape (6 groups, GSTIN + TAN, same clock) in a small office reset each run.
    const base = await createDocumentOffice("volume-baseline");
    const admin = await createStaff(base, "volbase-admin", "admin");
    const asBase = await signedInClient(admin.email);
    try {
      await asBase.rpc("run_expected_generation", { p_as_of: CLOCK_START });
      const groups = await Promise.all(VOLUME_GROUPS.map((g) => groupId(base, g)));
      const pan = testPan("P", 6999);
      const { error } = await asBase.rpc("import_clients", { p_rows: [{ name: "Baseline client", client_type: "proprietorship", pan,
        incharge_id: admin.id, registrations: [{ kind: "gstin", number: testGstin(pan) }, { kind: "tan", number: testTan(69999) }], group_ids: groups }] });
      if (error) throw error;
      await asBase.rpc("run_expected_generation", { p_as_of: CLOCK_END });
      const item = async (as: SupabaseClient, clientFilter: (q: any) => any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const { data, error: e } = await clientFilter(as.from("expected_doc").select("client_id, doc_type_id, period_id, registration_id")).limit(1).single();
        if (e) throw e;
        return { ...data, received_as: "hard_copy", channel: "courier" };
      };
      const pBase = await item(asBase, (q) => q);
      const pVol = await item(v.as.admin, (q) => q.eq("client_id", v.busyClientId));
      const tBase = await timeIt(() => asBase.rpc("create_document", { p: pBase }));
      const tVol = await timeIt(() => v.as.admin.rpc("create_document", { p: pVol }));
      const row = record("V7", "Document save (linking trigger), volume office − empty office", 50, tVol - tBase + pingMs, pingMs,
        `volume ${Math.round(tVol)} ms, empty ${Math.round(tBase)} ms round trip`);
      check(row);
    } finally {
      await retireStaff([admin.id]);
    }
  }, 180_000);

  it("V8 Today for a Staff member with ~150 clients ≤ 1 s", async () => {
    const rt = await timeIt(() => v.as.staff.rpc("today_items", { p_scope: "mine", p_show: null, p_page: 0 }));
    check(record("V8", `Today, "Mine" (${VOLUME.staffClients} clients)`, 1000, rt, pingMs));
  }, 180_000);

  it("V9 Activity: first page (Staff, Limited) · client filter · document card < 1 s", async () => {
    const feed = (as: SupabaseClient, p: Record<string, unknown>) => as.rpc("activity_feed", { p });
    check(record("V9a", "Activity first page (Staff)", 1000, await timeIt(() => feed(v.as.staff, {})), pingMs));
    check(record("V9b", "Activity first page (Limited)", 1000, await timeIt(() => feed(v.as.limited, {})), pingMs));
    check(record("V9c", "/activity?client= (busiest client)", 1000, await timeIt(() => feed(v.as.staff, { client_id: v.busyClientId })), pingMs));
    check(record("V9d", "Document page Activity card (20 rows)", 1000, await timeIt(() => feed(v.as.staff, { document_id: v.busyDocumentId, limit: 20 })), pingMs));
  }, 180_000);

  it("V10 bulk Mark reviewed, 200 documents < 5 s", async () => {
    // 200 fresh hard copies each run (the office keeps them; counts only grow, so the seed check still holds).
    const { data: item } = await v.as.admin.from("expected_doc").select("client_id, doc_type_id, period_id, registration_id")
      .eq("client_id", v.busyClientId).limit(1).single();
    const { error } = await v.as.admin.rpc("seed_test_documents", { p_docs: Array.from({ length: 200 }, () => ({ ...item, received_as: "hard_copy", channel: "courier" })) });
    if (error) throw error;
    const { data: fresh } = await v.as.admin.from("document").select("id").eq("client_id", v.busyClientId).eq("status", "received")
      .order("created_at", { ascending: false }).limit(200);
    expect(fresh).toHaveLength(200);
    const t0 = performance.now();
    const { data, error: e2 } = await v.as.staff.rpc("review_documents", { p_ids: fresh!.map((d) => d.id) });
    const rt = performance.now() - t0;
    expect(e2).toBeNull();
    expect((data as unknown[]).length).toBe(200);
    check(record("V10", "Bulk Mark reviewed, 200 documents (one call)", 5000, rt, pingMs));
  }, 180_000);
});
