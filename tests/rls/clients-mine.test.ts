import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { createCatalogueOffice, groupId, mustInsertClient } from "../support/catalogue";

// Feature 12 — "My clients" on the Clients list (spec AC-27, AC-28). Written before migration B (plan step 1).
// Contract: search_clients(…, p_mine boolean default false). Mine = the user is the incharge, or the assigned staff
// of one of the client's ACTIVE groups or ACTIVE plan rows (06's effective assignee). It only narrows the list:
// access is unchanged, so every client is still found with p_mine = false.
//
// Clients: Own (s1 incharge) · ByGroup (s2 incharge; GST group assigned s1) · ByType (s2 incharge; one GST plan row
// assigned s1) · Other (s2 incharge) · Removed (s2 incharge; GST group assigned s1, then removed → not s1's).

type Who = "manager" | "s1" | "s2";
type Row = { id: string; name: string };
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
const c = {} as Record<"own" | "byGroup" | "byType" | "other" | "removed", string>;

async function list(who: Who, args: Record<string, unknown> = {}) {
  const { data, error } = await as[who].rpc("search_clients", { p_limit: 100, ...args });
  if (error) throw new Error(error.message);
  return (data as Row[]).map((r) => r.id);
}

beforeAll(async () => {
  officeId = await createCatalogueOffice("clients-mine");
  u.manager = await createStaff(officeId, "cm-manager", "manager");
  u.s1 = await createStaff(officeId, "cm-s1", "staff");
  u.s2 = await createStaff(officeId, "cm-s2", "staff");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  const add = async (name: string, incharge: string) =>
    (await mustInsertClient(as.s1, officeId, { name, client_type: "individual", incharge_id: incharge })).id;
  c.own = await add("Mine Own", u.s1.id);
  c.byGroup = await add("Mine By Group", u.s2.id);
  c.byType = await add("Mine By Type", u.s2.id);
  c.other = await add("Mine Other", u.s2.id);
  c.removed = await add("Mine Removed", u.s2.id);
  const gst = await groupId(officeId, "GST");
  for (const id of [c.byGroup, c.byType, c.removed]) {
    const { error } = await as.manager.rpc("enable_client_group", { p_client_id: id, p_doc_group_id: gst });
    if (error) throw new Error(error.message);
  }
  // Assignment is Admin/Manager only (02).
  for (const id of [c.byGroup, c.removed]) {
    const { error } = await as.manager.from("client_group").update({ assigned_staff_id: u.s1.id }).eq("client_id", id).eq("doc_group_id", gst);
    if (error) throw new Error(error.message);
  }
  const { data: row, error: e1 } = await as.manager.from("client_doc_type").select("id").eq("client_id", c.byType).eq("state", "active").limit(1).single();
  if (e1) throw new Error(e1.message);
  const { error: e2 } = await as.manager.from("client_doc_type").update({ assigned_staff_id: u.s1.id }).eq("id", row.id);
  if (e2) throw new Error(e2.message);
  const { error: e3 } = await as.manager.from("client_group").update({ state: "removed" }).eq("client_id", c.removed).eq("doc_group_id", gst);
  if (e3) throw new Error(e3.message);
}, 180_000);

afterAll(async () => {
  await retireStaff([u.manager, u.s1, u.s2].filter(Boolean).map((x) => x.id));
});

describe("My clients (AC-27)", () => {
  it("s1's clients: incharge, assigned group, assigned plan row — not a removed group's assignment", async () => {
    const mine = await list("s1", { p_mine: true });
    expect(mine).toEqual(expect.arrayContaining([c.own, c.byGroup, c.byType]));
    expect(mine).not.toContain(c.other);
    expect(mine).not.toContain(c.removed);
  });

  it("s2's clients: every client it is incharge of, including those assigned to s1 by group or plan row", async () => {
    const mine = await list("s2", { p_mine: true });
    expect(mine).toEqual(expect.arrayContaining([c.byGroup, c.byType, c.other, c.removed]));
    expect(mine).not.toContain(c.own);
  });

  it("without the filter everyone still sees every client (access is unchanged)", async () => {
    for (const k of ["s1", "s2", "manager"] as const) {
      expect(await list(k)).toEqual(expect.arrayContaining(Object.values(c)));
    }
  });

  it("the filter combines with the others (text search)", async () => {
    expect(await list("s1", { p_mine: true, p_query: "Own" })).toEqual([c.own]);
  });
});

// AC-28: with "My clients" on, the list is no slower than 02's list (same 1 s budget, same method: one warm-up call,
// then the median of 5). 1,000 clients: half with this user as incharge, half with someone else.
describe("My clients timing with 1,000 clients (AC-28)", () => {
  let perfOffice: string;
  let me: { id: string; email: string };
  let other: { id: string; email: string };
  let asMe: SupabaseClient;

  beforeAll(async () => {
    perfOffice = await createCatalogueOffice("mine-perf");
    me = await createStaff(perfOffice, "mine-perf-me", "staff");
    other = await createStaff(perfOffice, "mine-perf-other", "staff");
    asMe = await signedInClient(me.email);
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      office_id: perfOffice, name: `Mine perf ${String(i).padStart(4, "0")}`, client_type: "individual",
      incharge_id: i % 2 === 0 ? me.id : other.id,
    }));
    const { error } = await asMe.from("client").insert(rows);
    if (error) throw error;
  }, 120_000);

  afterAll(async () => { await retireStaff([me?.id, other?.id].filter(Boolean) as string[]); });

  it("first page and a search with p_mine each return in under 1 s, and find only this user's 500", async () => {
    const time = async (args: Record<string, unknown>) => {
      const call = () => asMe.rpc("search_clients", { p_limit: 50, ...args });
      await call(); // warm-up, not timed
      const runs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        const { data, error } = await call();
        runs.push(performance.now() - t0);
        expect(error).toBeNull();
        expect((data as unknown[]).length).toBeGreaterThan(0);
      }
      return runs.sort((x, y) => x - y)[2];
    };
    const plain = await time({});
    const mine = await time({ p_mine: true });
    const mineByName = await time({ p_mine: true, p_query: "perf 09" });
    console.info("search_clients p_mine timing (ms)", { plain: Math.round(plain), mine: Math.round(mine), mineByName: Math.round(mineByName) });
    const { data } = await asMe.rpc("search_clients", { p_limit: 1, p_mine: true });
    expect(Number((data as Array<{ total: number }>)[0].total)).toBe(500);
    for (const t of [mine, mineByName]) expect(t).toBeLessThan(1000);
  });
});
