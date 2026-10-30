import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { mustInsertClient } from "../support/catalogue";
import { testGstin, testPan } from "../support/test-data";
import { createDocumentOffice, createSoftCopy, mustCreateDocument, periodId, typeId, uploadObject } from "../support/documents";

// Feature 03b — document search enforced by the database (spec AC-5…AC-11). Written before the migration (plan step 1).
//
// Contract under test (plan step 2 implements it). Both functions are SECURITY INVOKER, so RLS decides visibility.
//   search_documents(p jsonb) → { total: int, rows: SearchRow[] }
//   search_document_facets(p jsonb) → setof (facet text, value text, label text, n int)
// Input keys (all optional):
//   text              free text — split on spaces into ≤ 5 words of ≤ 50 chars; every word must match (AND),
//                     in the remark or the current file name (partial, case-insensitive) or the DOC-ID (prefix)
//   filters           { client_id, group_id, doc_type_id, fy_id, period_id, registration_id, received_as, channel,
//                       received_by, from, to (received_on, inclusive), status, state: "classified" | "inbox" }
//   include_archived  boolean, default false
//   sort              "received" (default) | "added" | "docid"      page (1-based, default 1)
//   page_size         default 50, max 50 (suggestions pass 5)
// Facets: group, received_as, channel, received_by, status. Each facet counts the visible documents matching the
// text and the *other* filters (its own filter is ignored); zero counts are not returned; a deactivated receiver's
// label ends in " (inactive)".

type Who = "admin" | "manager" | "staff" | "limited" | "outsider";
type SearchRow = {
  id: string; doc_code: string; client_id: string | null; client_name: string | null; client_code: string | null;
  doc_type_id: string | null; type_name: string | null; group_id: string | null; group_name: string | null;
  period_id: string | null; period_code: string | null; registration_id: string | null;
  received_as: string; channel: string; received_on: string; received_by: string; received_by_name: string;
  status: string; remark: string | null; file_name: string | null; archived_at: string | null; created_at: string;
};
type SearchResult = { total: number; rows: SearchRow[] };
type Facet = { facet: string; value: string; label: string | null; n: number };
type Search = {
  text?: string; filters?: Record<string, unknown>; include_archived?: boolean;
  sort?: string; page?: number; page_size?: number;
};

let officeId: string;
let otherOfficeId: string;
const u = {} as Record<Who | "leaver", { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
let clientA: string; // Limited is incharge → Limited can see it
let clientB: string; // Staff is incharge → Limited cannot see it
let gstinA: string;
const t = {} as Record<"sales" | "form16" | "form16a", string>;
const g = {} as Record<"sales" | "form16" | "form16a", string>; // group of each type
const p = {} as Record<"month" | "quarter" | "year" | "lastYear", string>;
const fy = {} as Record<"current" | "last", string>;

async function search(who: Who | SupabaseClient, s: Search) {
  const c = typeof who === "string" ? as[who] : who;
  const res = await c.rpc("search_documents", { p: s });
  return res as { data: SearchResult | null; error: { message: string } | null };
}
async function mustSearch(who: Who, s: Search): Promise<SearchResult> {
  const { data, error } = await search(who, s);
  if (error) throw new Error(error.message);
  return data!;
}
const ids = (r: SearchResult) => r.rows.map((x) => x.id);
const idSet = (r: SearchResult) => new Set(ids(r));

async function facets(who: Who, s: Search): Promise<Facet[]> {
  const { data, error } = await as[who].rpc("search_document_facets", { p: s });
  if (error) throw new Error(error.message);
  return (data ?? []) as Facet[];
}
const facetOf = (fs: Facet[], facet: string) => fs.filter((f) => f.facet === facet);

async function activityCount() {
  const { count, error } = await adminClient().from("activity").select("id", { count: "exact", head: true }).eq("office_id", officeId);
  if (error) throw error;
  return count ?? 0;
}

beforeAll(async () => {
  officeId = await createDocumentOffice("search");
  otherOfficeId = await createDocumentOffice("search-other");
  u.admin = await createStaff(officeId, "search-admin", "admin");
  u.manager = await createStaff(officeId, "search-manager", "manager");
  u.staff = await createStaff(officeId, "search-staff", "staff");
  u.limited = await createStaff(officeId, "search-limited", "limited");
  u.leaver = await createStaff(officeId, "search-leaver", "staff");
  u.outsider = await createStaff(otherOfficeId, "search-outsider", "admin");
  for (const k of ["admin", "manager", "staff", "limited", "outsider"] as Who[]) as[k] = await signedInClient(u[k].email);

  clientA = (await mustInsertClient(as.staff, officeId, { name: "Search client A", client_type: "proprietorship", incharge_id: u.limited.id, pan: testPan("P", 3201) })).id;
  clientB = (await mustInsertClient(as.staff, officeId, { name: "Search client B", client_type: "proprietorship", incharge_id: u.staff.id, pan: testPan("P", 3202) })).id;
  const { data: r, error } = await as.staff.from("client_registration")
    .insert({ office_id: officeId, client_id: clientA, kind: "gstin", number: testGstin(testPan("P", 3201), "33", 1) }).select("id").single();
  if (error) throw error;
  gstinA = r.id as string;

  t.sales = await typeId(officeId, "Sales invoices / sales register"); // GST, month
  t.form16 = await typeId(officeId, "Form 16 from employer"); // year
  t.form16a = await typeId(officeId, "Form 16A from deductors"); // TDS, quarter
  for (const k of Object.keys(t) as (keyof typeof t)[]) {
    g[k] = (await adminClient().from("doc_type").select("doc_group_id").eq("id", t[k]).single()).data!.doc_group_id as string;
  }
  p.month = await periodId(officeId, "2026-08");
  p.quarter = await periodId(officeId, "2026-27-Q1");
  p.year = await periodId(officeId, "2026-27");
  p.lastYear = await periodId(officeId, "2025-26");
  const fyId = async (code: string) =>
    (await adminClient().from("financial_year").select("id").eq("office_id", officeId).eq("code", code).single()).data!.id as string;
  fy.current = await fyId("2026-27");
  fy.last = await fyId("2025-26");
});

afterAll(async () => {
  await retireStaff([u.manager, u.staff, u.limited, u.leaver].filter(Boolean).map((x) => x.id));
  await retireStaff([u.admin, u.outsider].filter(Boolean).map((x) => x.id));
});

// ── Text matching (AC-8) ─────────────────────────────────────────────────────
describe("text matching (AC-8)", () => {
  const d = {} as Record<"bank" | "challan" | "pct" | "under" | "slash" | "pctDecoy" | "underDecoy" | "long", { id: string; doc_code: string }>;
  const long = "x".repeat(50);
  beforeAll(async () => {
    const withFile = async (remark: string, fileName: string) => {
      const obj = await uploadObject(officeId, "pdf");
      return mustCreateDocument(as.staff, { remark, received_as: "soft_copy", file: { storage_path: obj.path, file_name: fileName } });
    };
    d.bank = await withFile("zqm Bank statement HDFC", "hdfc_aug.pdf");
    d.challan = await withFile("zqm GST challan", "challan-scan.pdf");
    d.pct = await mustCreateDocument(as.staff, { remark: "zqm 100% paid" });
    d.pctDecoy = await mustCreateDocument(as.staff, { remark: "zqm 1000 paid" });
    d.under = await mustCreateDocument(as.staff, { remark: "zqm a_b ref" });
    d.underDecoy = await mustCreateDocument(as.staff, { remark: "zqm axb ref" });
    d.slash = await mustCreateDocument(as.staff, { remark: "zqm back\\slash" });
    d.long = await mustCreateDocument(as.staff, { remark: `zqm ${long}TAIL` });
  });

  it("is case-insensitive and partial on the remark", async () => {
    expect(ids(await mustSearch("staff", { text: "zqm STATEMENT" }))).toEqual([d.bank.id]);
  });

  it("is partial on the current file name", async () => {
    expect(ids(await mustSearch("staff", { text: "zqm aug.pd" }))).toEqual([d.bank.id]);
  });

  it("every word must match (AND), each in any field (OR)", async () => {
    // "scan" is only in the file name, "challan" is in both.
    expect(ids(await mustSearch("staff", { text: "zqm challan scan" }))).toEqual([d.challan.id]);
    expect((await mustSearch("staff", { text: "zqm challan hdfc" })).total).toBe(0);
  });

  it("treats %, _ and \\ as plain text", async () => {
    expect(ids(await mustSearch("staff", { text: "zqm 0%" }))).toEqual([d.pct.id]);
    expect(ids(await mustSearch("staff", { text: "zqm a_b" }))).toEqual([d.under.id]);
    expect(ids(await mustSearch("staff", { text: "zqm \\" }))).toEqual([d.slash.id]);
  });

  it("a full DOC-ID in any case, with surrounding spaces, finds that document", async () => {
    expect(ids(await mustSearch("staff", { text: `   ${d.pct.doc_code.toLowerCase()}  ` }))).toEqual([d.pct.id]);
  });

  it("the DOC-ID matches by prefix only, not in the middle", async () => {
    const r = await mustSearch("staff", { text: "zqm doc-fy" });
    expect(r.total).toBe(8); // every zqm document's DOC-ID starts with DOC-FY
    const digits = d.pct.doc_code.slice(-5);
    expect(idSet(await mustSearch("staff", { text: `zqm ${digits}` })).has(d.pct.id)).toBe(false);
  });

  it("uses at most 5 words; the rest are ignored", async () => {
    expect(ids(await mustSearch("staff", { text: "zqm bank statement hdfc aug nosuchwordanywhere" }))).toEqual([d.bank.id]);
  });

  it("cuts each word to 50 characters", async () => {
    expect(ids(await mustSearch("staff", { text: `zqm ${long}NOPE` }))).toEqual([d.long.id]);
  });

  it("matches the current file name only, not an older version's", async () => {
    const obj = await uploadObject(officeId, "pdf");
    const doc = await mustCreateDocument(as.staff, { received_as: "soft_copy", file: { storage_path: obj.path, file_name: "old-name-qzn.pdf" } });
    const v2 = await uploadObject(officeId, "pdf", doc.id);
    const { error } = await as.staff.rpc("add_document_version", { p_document_id: doc.id, p_file: { storage_path: v2.path, file_name: "new-name-qzn.pdf" } });
    expect(error).toBeNull();
    expect((await mustSearch("staff", { text: "old-name-qzn" })).total).toBe(0);
    expect(ids(await mustSearch("staff", { text: "new-name-qzn" }))).toEqual([doc.id]);
  });

  it("with no text and no filters, lists the newest visible documents, at most 50 per page", async () => {
    const r = await mustSearch("staff", {});
    expect(r.total).toBeGreaterThanOrEqual(9);
    expect(r.rows.length).toBe(Math.min(r.total, 50));
  });
});

// ── Filters and rows (AC-5, AC-6) ────────────────────────────────────────────
describe("filters (AC-6) and result rows (AC-5)", () => {
  const f = {} as Record<"sales" | "form16" | "form16a" | "inbox", string>;
  beforeAll(async () => {
    f.sales = (await mustCreateDocument(as.staff, {
      remark: "zqf one", client_id: clientA, doc_type_id: t.sales, period_id: p.month, registration_id: gstinA,
      received_as: "original", channel: "courier", received_on: "2026-08-05",
    })).id;
    // received_by is accepted by create_document (03) but not in the NewDocument fixture type.
    const byManager = {
      remark: "zqf two", client_id: clientA, doc_type_id: t.form16, period_id: p.lastYear,
      received_as: "hard_copy" as const, channel: "email" as const, received_on: "2026-07-01", received_by: u.manager.id,
    };
    f.form16 = (await mustCreateDocument(as.staff, byManager)).id;
    f.form16a = (await mustCreateDocument(as.staff, {
      remark: "zqf three", client_id: clientB, doc_type_id: t.form16a, period_id: p.quarter,
      received_as: "hard_copy", channel: "whatsapp", received_on: "2026-09-10",
    })).id;
    f.inbox = (await mustCreateDocument(as.limited, { remark: "zqf four", received_as: "hard_copy", channel: "hand_delivery", received_on: "2026-09-20" })).id;
  });

  const only = async (filters: Record<string, unknown>) => idSet(await mustSearch("staff", { text: "zqf", filters }));

  it.each([
    ["client_id", (): string => clientA, ["sales", "form16"]],
    ["group_id", (): string => g.sales, ["sales"]],
    ["doc_type_id", (): string => t.form16, ["form16"]],
    ["fy_id", (): string => fy.last, ["form16"]],
    ["period_id", (): string => p.quarter, ["form16a"]],
    ["registration_id", (): string => gstinA, ["sales"]],
    ["received_as", (): string => "original", ["sales"]],
    ["channel", (): string => "email", ["form16"]],
    ["received_by", (): string => u.manager.id, ["form16"]],
    ["from", (): string => "2026-09-01", ["form16a", "inbox"]],
    ["to", (): string => "2026-07-31", ["form16"]],
    ["status", (): string => "received", ["sales", "form16", "form16a", "inbox"]],
    ["state", (): string => "inbox", ["inbox"]],
    ["state", (): string => "classified", ["sales", "form16", "form16a"]],
  ] as const)("filter %s alone", async (key, value, expected) => {
    expect(await only({ [key]: value() })).toEqual(new Set(expected.map((k) => f[k])));
  });

  it("filters combine (AND), including a date range", async () => {
    expect(await only({ client_id: clientA, channel: "courier" })).toEqual(new Set([f.sales]));
    expect(await only({ from: "2026-08-01", to: "2026-08-31" })).toEqual(new Set([f.sales]));
    expect(await only({ client_id: clientA, channel: "whatsapp" })).toEqual(new Set());
  });

  it("FY filter matches the period's FY (current FY covers month and quarter periods)", async () => {
    expect(await only({ fy_id: fy.current })).toEqual(new Set([f.sales, f.form16a]));
  });

  it("a row carries what the results page shows", async () => {
    const [row] = (await mustSearch("staff", { text: "zqf one" })).rows;
    expect(row).toMatchObject({
      id: f.sales, client_id: clientA, client_name: "Search client A", doc_type_id: t.sales,
      type_name: "Sales invoices / sales register", group_id: g.sales, period_code: "2026-08", registration_id: gstinA,
      received_as: "hard_copy", returnable: true, // 12 (spec AC-9/10, approved 2026-10-30): the original is a returnable hard copy
      channel: "courier", received_on: "2026-08-05", received_by: u.staff.id,
      received_by_name: "Test search-staff", status: "received", remark: "zqf one", file_name: null, archived_at: null,
    });
    expect(row.doc_code).toMatch(/^DOC-FY\d{2}-\d{2}-\d{5,}$/);
    expect(row.client_code).toMatch(/^C\d{4,}$/);
    expect(row.group_name).toBeTruthy();
    const [inbox] = (await mustSearch("staff", { text: "zqf four" })).rows;
    expect(inbox).toMatchObject({ client_id: null, client_name: null, type_name: null, group_name: null, period_code: null });
  });

  it("rejects an unknown sort or a malformed filter value", async () => {
    expect((await search("staff", { sort: "name" })).error?.message ?? "").toMatch(/INVALID/i);
    expect((await search("staff", { filters: { client_id: "not-a-uuid" } })).error).not.toBeNull();
  });
});

// ── Sort and paging (AC-5) ───────────────────────────────────────────────────
describe("sort and paging (AC-5)", () => {
  const s = {} as Record<"one" | "two" | "three" | "lastFy", string>;
  beforeAll(async () => {
    s.one = (await mustCreateDocument(as.staff, { remark: "zqs", received_on: "2026-09-01" })).id;
    s.two = (await mustCreateDocument(as.staff, { remark: "zqs", received_on: "2026-08-01" })).id;
    s.three = (await mustCreateDocument(as.staff, { remark: "zqs", received_on: "2026-09-15" })).id;
    // Added last, but its DOC-ID is in FY 2025-26 (fixed-date hook, test offices only).
    s.lastFy = (await mustCreateDocument(as.staff, { remark: "zqs", received_on: "2025-05-30", test_added_at: "2025-06-01T05:00:00Z" })).id;
  });

  it("defaults to newest received first", async () => {
    expect(ids(await mustSearch("staff", { text: "zqs" }))).toEqual([s.three, s.one, s.two, s.lastFy]);
  });

  it("sort=added orders by date added, newest first", async () => {
    const r = ids(await mustSearch("staff", { text: "zqs", sort: "added" })).filter((x) => x !== s.lastFy);
    expect(r).toEqual([s.three, s.two, s.one]);
  });

  it("sort=docid orders by FY then number, newest first", async () => {
    expect(ids(await mustSearch("staff", { text: "zqs", sort: "docid" }))).toEqual([s.three, s.two, s.one, s.lastFy]);
  });

  it("pages keep the total and never overlap", async () => {
    const p1 = await mustSearch("staff", { text: "zqs", page_size: 2, page: 1 });
    const p2 = await mustSearch("staff", { text: "zqs", page_size: 2, page: 2 });
    const p3 = await mustSearch("staff", { text: "zqs", page_size: 2, page: 3 });
    expect([p1.total, p2.total, p3.total]).toEqual([4, 4, 4]);
    expect(ids(p1)).toEqual([s.three, s.one]);
    expect(ids(p2)).toEqual([s.two, s.lastFy]);
    expect(p3.rows).toEqual([]);
  });
});

// ── Archived toggle (AC-6, Q3) ───────────────────────────────────────────────
describe("include archived (AC-6)", () => {
  const a = {} as Record<"live" | "archived", string>;
  beforeAll(async () => {
    a.live = (await mustCreateDocument(as.staff, { remark: "zqa", channel: "courier" })).id;
    a.archived = (await mustCreateDocument(as.staff, { remark: "zqa", channel: "email" })).id;
    const { error } = await as.manager.rpc("archive_document", { p_id: a.archived, p_reason: "duplicate upload" });
    expect(error).toBeNull();
  });

  it("archived documents are hidden by default, in results and facets", async () => {
    expect(ids(await mustSearch("staff", { text: "zqa" }))).toEqual([a.live]);
    expect(facetOf(await facets("staff", { text: "zqa" }), "channel").map((x) => x.value)).toEqual(["courier"]);
  });

  it("include_archived shows them, marked", async () => {
    const r = await mustSearch("staff", { text: "zqa", include_archived: true });
    expect(idSet(r)).toEqual(new Set([a.live, a.archived]));
    expect(r.rows.find((x) => x.id === a.archived)!.archived_at).not.toBeNull();
    expect(facetOf(await facets("staff", { text: "zqa", include_archived: true }), "channel").length).toBe(2);
  });
});

// ── Facet counts (AC-7) ──────────────────────────────────────────────────────
describe("facet counts (AC-7)", () => {
  // Uses the "zqf" documents from the filters block: channels courier/email/whatsapp/hand_delivery,
  // received_as original ×1 + hard_copy ×3, receivers staff ×2 + manager ×1 + limited ×1, 3 classified in 3 groups.
  const filterKey: Record<string, string> = {
    group: "group_id", received_as: "received_as", channel: "channel", received_by: "received_by", status: "status",
  };

  it("returns the five facets, with no zero counts", async () => {
    const fs = await facets("staff", { text: "zqf" });
    expect(new Set(fs.map((x) => x.facet))).toEqual(new Set(Object.keys(filterKey)));
    expect(fs.every((x) => x.n > 0)).toBe(true);
    expect(facetOf(fs, "channel").some((x) => x.value === "portal")).toBe(false);
  });

  it("each count equals the number of results when that value is chosen", async () => {
    const fs = await facets("staff", { text: "zqf" });
    for (const x of fs) {
      const r = await mustSearch("staff", { text: "zqf", filters: { [filterKey[x.facet]]: x.value } });
      expect(r.total, `${x.facet}=${x.value}`).toBe(x.n);
    }
    const byAs = Object.fromEntries(facetOf(fs, "received_as").map((x) => [x.value, x.n]));
    expect(byAs).toEqual({ hard_copy: 4 }); // 12 (spec AC-13): the original is a returnable hard copy
    expect(facetOf(fs, "group").reduce((sum, x) => sum + x.n, 0)).toBe(3); // Inbox documents have no group
  });

  it("a facet ignores its own filter but applies the others", async () => {
    const fs = await facets("staff", { text: "zqf", filters: { channel: "courier" } });
    expect(facetOf(fs, "channel").length).toBe(4); // still offers the other channels
    expect(facetOf(fs, "received_as").map((x) => [x.value, x.n])).toEqual([["hard_copy", 1]]); // narrowed by channel; 12 (AC-13)
  });

  it("received by uses staff names, and marks deactivated staff (inactive)", async () => {
    const leaver = await signedInClient(u.leaver.email);
    await mustCreateDocument(leaver, { remark: "zqi" });
    await mustCreateDocument(as.staff, { remark: "zqi" });
    await createStaff(officeId, "search-leaver", "staff", "deactivated");
    const labels = facetOf(await facets("staff", { text: "zqi" }), "received_by")
      .map((x) => [x.value, x.label]);
    expect(new Map(labels as [string, string][])).toEqual(new Map([
      [u.leaver.id, "Test search-leaver (inactive)"],
      [u.staff.id, "Test search-staff"],
    ]));
  });
});

// ── Visibility (AC-10) ───────────────────────────────────────────────────────
describe("visibility matrix (AC-10)", () => {
  const v = {} as Record<"onA" | "onB" | "inboxLimited" | "inboxStaff" | "limitedMovedToB", string>;
  beforeAll(async () => {
    v.onA = (await createSoftCopy(as.staff, officeId, { client_id: clientA, doc_type_id: t.form16, remark: "zqv" })).id;
    v.onB = (await createSoftCopy(as.staff, officeId, { client_id: clientB, doc_type_id: t.form16, remark: "zqv" })).id;
    v.inboxLimited = (await mustCreateDocument(as.limited, { remark: "zqv", channel: "courier" })).id;
    v.inboxStaff = (await mustCreateDocument(as.staff, { remark: "zqv", channel: "email" })).id;
    v.limitedMovedToB = (await mustCreateDocument(as.limited, { remark: "zqv" })).id;
    const { error } = await as.staff.rpc("update_document", { p_id: v.limitedMovedToB, p: { client_id: clientB, doc_type_id: t.form16 } });
    expect(error).toBeNull();
  });

  const all = () => new Set(Object.values(v));
  const limitedSees = () => new Set([v.onA, v.inboxLimited]);
  const facetTotal = async (who: Who) => facetOf(await facets(who, { text: "zqv" }), "channel").reduce((sum, x) => sum + x.n, 0);

  it.each(["admin", "manager", "staff"] as const)("%s finds every document, classified or not, in results, total, facets and suggestions", async (who) => {
    const r = await mustSearch(who, { text: "zqv" });
    expect(idSet(r)).toEqual(all());
    expect(r.total).toBe(5);
    expect(await facetTotal(who)).toBe(5);
    expect((await mustSearch(who, { text: "zqv", page_size: 5 })).rows.length).toBe(5);
  });

  it("limited finds only its assigned client's documents and the Inbox items it added", async () => {
    const r = await mustSearch("limited", { text: "zqv" });
    expect(idSet(r)).toEqual(limitedSees());
    expect(r.total).toBe(2);
    expect(await facetTotal("limited")).toBe(2);
    const fs = await facets("limited", { text: "zqv" });
    expect(facetOf(fs, "received_by").every((x) => x.n <= 2)).toBe(true);
    const sug = await mustSearch("limited", { text: "zqv", page_size: 5 });
    expect(idSet(sug)).toEqual(limitedSees());
  });

  it("limited gets 0 (not an error) when filtering on a client it can't see, or searching another document's DOC-ID", async () => {
    const r = await mustSearch("limited", { text: "zqv", filters: { client_id: clientB } });
    expect(r).toEqual({ total: 0, rows: [] });
    const onB = (await adminClient().from("document").select("doc_code").eq("id", v.onB).single()).data!.doc_code as string;
    expect((await mustSearch("limited", { text: onB })).total).toBe(0);
    expect(facetOf(await facets("limited", { text: "zqv", filters: { client_id: clientB } }), "channel")).toEqual([]);
  });

  it("a group assignment gives limited the client's documents in search, and removing it takes them away", async () => {
    const { data: grp, error } = await as.staff.rpc("enable_client_group", { p_client_id: clientB, p_doc_group_id: g.form16 });
    expect(error).toBeNull();
    const assign = (staffId: string) => as.manager.from("client_group").update({ assigned_staff_id: staffId }).eq("id", grp as string);
    try {
      await assign(u.limited.id);
      expect(idSet(await mustSearch("limited", { text: "zqv" }))).toEqual(new Set([...limitedSees(), v.onB, v.limitedMovedToB]));
    } finally {
      await assign(u.staff.id); // later tests rely on Limited not seeing client B
    }
    expect(idSet(await mustSearch("limited", { text: "zqv" }))).toEqual(limitedSees());
  });

  it("a type-level assignment does the same", async () => {
    const { data: row } = await adminClient().from("client_doc_type").select("id").eq("client_id", clientB).eq("doc_type_id", t.form16).single();
    const assign = (staffId: string) => as.manager.from("client_doc_type").update({ assigned_staff_id: staffId }).eq("id", row!.id);
    try {
      await assign(u.limited.id);
      expect(idSet(await mustSearch("limited", { text: "zqv" })).has(v.onB)).toBe(true);
    } finally {
      await assign(u.staff.id);
    }
    expect(idSet(await mustSearch("limited", { text: "zqv" })).has(v.onB)).toBe(false);
  });

  it("another office finds nothing", async () => {
    expect(await mustSearch("outsider", { text: "zqv" })).toEqual({ total: 0, rows: [] });
    expect(await facets("outsider", { text: "zqv" })).toEqual([]);
    expect((await mustSearch("outsider", {})).total).toBe(0);
  });

  it("anonymous callers can't run either function", async () => {
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
    const r = await search(anon, { text: "zqv" });
    expect(r.error).not.toBeNull();
    const f = await anon.rpc("search_document_facets", { p: { text: "zqv" } });
    expect(f.error).not.toBeNull();
  });
});

// ── Unfiled own document on a client Limited can't see (review finding, 2026-10-01) ─────────────────────────
// document_select lets the creator keep seeing a document that has a client but no type yet, even when the client
// isn't theirs. Search's extra Limited filter (a planner hint, not enforcement) must not hide it.
describe("limited's own unfiled document on another client (AC-10)", () => {
  let doc: string;
  beforeAll(async () => {
    doc = (await mustCreateDocument(as.limited, { remark: "zqw", channel: "courier" })).id;
    const { error } = await as.staff.rpc("update_document", { p_id: doc, p: { client_id: clientB } });
    expect(error).toBeNull();
  });

  it("RLS still lets limited open it", async () => {
    const { data } = await as.limited.from("document").select("id").eq("id", doc);
    expect(data?.map((d) => d.id)).toEqual([doc]);
  });

  it("limited finds it in results, total, facets and suggestions", async () => {
    const r = await mustSearch("limited", { text: "zqw" });
    expect(idSet(r)).toEqual(new Set([doc]));
    expect(r.total).toBe(1);
    expect(facetOf(await facets("limited", { text: "zqw" }), "channel")).toEqual([expect.objectContaining({ value: "courier", n: 1 })]);
    expect(idSet(await mustSearch("limited", { text: "zqw", page_size: 5 }))).toEqual(new Set([doc]));
  });

  it("once it is filed (type set), limited no longer finds it", async () => {
    const { error } = await as.staff.rpc("update_document", { p_id: doc, p: { doc_type_id: t.form16 } });
    expect(error).toBeNull();
    expect((await mustSearch("limited", { text: "zqw" })).total).toBe(0);
    expect(facetOf(await facets("limited", { text: "zqw" }), "channel")).toEqual([]);
  });
});

// ── Read-only (AC-11) ────────────────────────────────────────────────────────
describe("search is read-only (AC-11)", () => {
  it("writes no activity rows", async () => {
    const before = await activityCount();
    await mustSearch("staff", { text: "zqm bank" });
    await facets("staff", { text: "zqm bank" });
    await mustSearch("limited", { text: "anything", filters: { channel: "courier" } });
    expect(await activityCount()).toBe(before);
  });
});
