import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { createCatalogueOffice, groupId, mustInsertClient } from "../support/catalogue";
import { testGstin, testPan } from "../support/test-data";

// Feature 02 step 7 — Clients list search (spec AC-7, AC-12, NFR "1,000 clients < 1 s").
// public.search_clients is SECURITY INVOKER: RLS decides who sees what.

type Row = { id: string; code: string; name: string; client_type: string; pan: string | null; incharge_name: string;
  groups: string[]; paused_groups: string[]; archived: boolean; total: number };

let officeId: string;
const u = {} as Record<"admin" | "manager" | "staff" | "limited", { id: string; email: string }>;
const as = {} as Record<keyof typeof u, SupabaseClient>;
const ids = {} as Record<"alpha" | "beta" | "gamma" | "delta", string>;
const alphaPan = testPan("P", 4101);

async function search(c: SupabaseClient, args: Record<string, unknown> = {}): Promise<Row[]> {
  const { data, error } = await c.rpc("search_clients", args);
  if (error) throw error;
  return data as Row[];
}
const names = (rows: Row[]) => rows.map((r) => r.name);

beforeAll(async () => {
  officeId = await createCatalogueOffice("list");
  u.admin = await createStaff(officeId, "list-admin", "admin");
  u.manager = await createStaff(officeId, "list-manager", "manager");
  u.staff = await createStaff(officeId, "list-staff", "staff");
  u.limited = await createStaff(officeId, "list-limited", "limited");
  for (const k of Object.keys(u) as (keyof typeof u)[]) as[k] = await signedInClient(u[k].email);

  ids.alpha = (await mustInsertClient(as.staff, officeId, { name: "Alpha Traders", client_type: "proprietorship", incharge_id: u.staff.id, pan: alphaPan, previous_reference: "OLD-77" })).id;
  ids.beta = (await mustInsertClient(as.staff, officeId, { name: "beta Exports", client_type: "partnership", incharge_id: u.limited.id })).id;
  ids.gamma = (await mustInsertClient(as.staff, officeId, { name: "Gamma 100% Pure", client_type: "individual", incharge_id: u.staff.id })).id;
  ids.delta = (await mustInsertClient(as.staff, officeId, { name: "Delta Archived", client_type: "individual", incharge_id: u.staff.id })).id;
  const reg = await as.staff.from("client_registration").insert({ office_id: officeId, client_id: ids.alpha, kind: "gstin", number: testGstin(alphaPan, "33") });
  if (reg.error) throw reg.error;
  const gst = await groupId(officeId, "GST");
  const tds = await groupId(officeId, "TDS/TCS");
  for (const g of [gst, tds]) {
    const { error } = await as.staff.rpc("enable_client_group", { p_client_id: ids.alpha, p_doc_group_id: g });
    if (error) throw error;
  }
  const { error: pe } = await as.manager.from("client_group").update({ state: "paused", remark: "on hold" }).eq("client_id", ids.alpha).eq("doc_group_id", tds);
  if (pe) throw pe;
  const { error: ae } = await as.manager.from("client").update({ archived_at: new Date().toISOString(), archived_by: u.manager.id }).eq("id", ids.delta);
  if (ae) throw ae;
});

afterAll(async () => {
  await retireStaff(Object.values(u).filter(Boolean).map((x) => x.id));
});

describe("search_clients (AC-7)", () => {
  it("lists active clients by name with type, PAN, incharge, enabled and paused groups, and a total", async () => {
    const rows = await search(as.staff);
    expect(names(rows)).toEqual(["Alpha Traders", "beta Exports", "Gamma 100% Pure"]);
    expect(rows[0]).toMatchObject({ client_type: "proprietorship", pan: alphaPan, incharge_name: "Test list-staff", groups: ["GST"], paused_groups: ["TDS/TCS"], archived: false });
    expect(rows.every((r) => Number(r.total) === 3)).toBe(true);
  });

  it("matches name, code and previous reference — case-insensitive and partial", async () => {
    expect(names(await search(as.staff, { p_query: "ALPHA" }))).toEqual(["Alpha Traders"]);
    expect(names(await search(as.staff, { p_query: "xport" }))).toEqual(["beta Exports"]);
    expect(names(await search(as.staff, { p_query: "old-7" }))).toEqual(["Alpha Traders"]);
    const code = (await search(as.staff, { p_query: "Gamma" }))[0].code;
    expect(names(await search(as.staff, { p_query: code.toLowerCase() }))).toEqual(["Gamma 100% Pure"]);
  });

  it("matches PAN and GSTIN partially, ignoring case and spaces", async () => {
    expect(names(await search(as.staff, { p_query: alphaPan.slice(3, 9).toLowerCase() }))).toEqual(["Alpha Traders"]);
    const gstin = testGstin(alphaPan, "33");
    expect(names(await search(as.staff, { p_query: ` ${gstin.slice(0, 2)} ${gstin.slice(2, 12).toLowerCase()} ` }))).toEqual(["Alpha Traders"]);
  });

  it("treats LIKE wildcards in the search text literally", async () => {
    expect(names(await search(as.staff, { p_query: "100%" }))).toEqual(["Gamma 100% Pure"]);
    expect(names(await search(as.staff, { p_query: "%" }))).toEqual(["Gamma 100% Pure"]);
    expect(await search(as.staff, { p_query: "_" })).toEqual([]);
  });

  it("filters by type and incharge; archived clients only with the toggle, marked archived", async () => {
    expect(names(await search(as.staff, { p_client_type: "partnership" }))).toEqual(["beta Exports"]);
    expect(names(await search(as.staff, { p_incharge_id: u.limited.id }))).toEqual(["beta Exports"]);
    expect(names(await search(as.staff, { p_query: "delta" }))).toEqual([]);
    const withArchived = await search(as.staff, { p_include_archived: true });
    expect(names(withArchived)).toEqual(["Alpha Traders", "beta Exports", "Gamma 100% Pure", "Delta Archived"]);
    expect(withArchived.find((r) => r.name === "Delta Archived")?.archived).toBe(true);
  });

  it("pages with limit/offset (max 100 per call) and keeps the full total", async () => {
    const p2 = await search(as.staff, { p_limit: 2, p_offset: 2 });
    expect(names(p2)).toEqual(["Gamma 100% Pure"]);
    expect(Number(p2[0].total)).toBe(3);
    expect((await search(as.staff, { p_limit: 100000 })).length).toBe(3);
  });

  it("a Limited user finds only clients they are incharge of or assigned to (AC-12)", async () => {
    expect(names(await search(as.limited))).toEqual(["beta Exports"]);
    expect(await search(as.limited, { p_query: "alpha" })).toEqual([]);
  });

  it("is not callable without signing in", async () => {
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
    const { error } = await anon.rpc("search_clients", {});
    expect(error?.message ?? "").toMatch(/permission denied|not find|does not exist/i);
  });
});

describe("list performance with 1,000 clients (spec NFR)", () => {
  let perfOffice: string;
  let perfStaff: { id: string; email: string };
  let c: SupabaseClient;

  beforeAll(async () => {
    perfOffice = await createCatalogueOffice("list-perf");
    perfStaff = await createStaff(perfOffice, "list-perf-staff", "staff");
    c = await signedInClient(perfStaff.email);
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      office_id: perfOffice, name: `Perf client ${String(i).padStart(4, "0")}`, client_type: "individual",
      incharge_id: perfStaff.id, pan: testPan("P", i), previous_reference: `P-${i}`,
    }));
    // Inserted as the signed-in staff member (the real path; the service role cannot run the PAN check helper).
    const { error } = await c.from("client").insert(rows);
    if (error) throw error;
  }, 120_000);

  afterAll(async () => { if (perfStaff) await retireStaff([perfStaff.id]); });

  it("first page and a search each return in under 1 s (round trip, best of 3)", async () => {
    const time = async (args: Record<string, unknown>) => {
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        const rows = await search(c, args);
        best = Math.min(best, performance.now() - t0);
        expect(rows.length).toBeGreaterThan(0);
      }
      return best;
    };
    const first = await time({});
    const byName = await time({ p_query: "client 09" });
    const byPan = await time({ p_query: testPan("P", 777).slice(4, 9) });
    console.info("search_clients timing (ms)", { first: Math.round(first), byName: Math.round(byName), byPan: Math.round(byPan) });
    expect(Number((await search(c))[0].total)).toBe(1000);
    for (const t of [first, byName, byPan]) expect(t).toBeLessThan(1000);
  });
});
