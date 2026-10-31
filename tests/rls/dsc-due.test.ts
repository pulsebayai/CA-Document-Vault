import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createCatalogueOffice } from "../support/catalogue";
import { createDocumentOffice } from "../support/documents";
import { bankOnlyClient } from "../support/expected";
import { testPan } from "../support/test-data";
import { archiveDsc, dscDue, logCustody, mustSaveDsc, newDsc, setRemindDays, setTestToday } from "../support/dsc";

// Feature 14 — Today's "DSC expiring" (spec AC-10, AC-11, T2, T3; NFR Performance). Written before the migration
// (plan step 1). The office date is the test clock (office.test_today); a DSC is valid through its expiry date and is
// due when it expires within the client's remind days (default 30) or has expired. Mirrors src/lib/dsc/expiry.ts.

type Who = "manager" | "staff" | "limited";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
const d = {} as Record<"a30" | "a31" | "aExpired" | "aArchived" | "b40" | "b50" | "cGone", string>;
let clientA: string, clientB: string;
const TODAY = "2026-10-31";

const ids = async (who: SupabaseClient, scope: "mine" | "everyone") => (await dscDue(who, scope)).rows.map((r) => r.id);

beforeAll(async () => {
  officeId = await createDocumentOffice("dsc-due");
  u.manager = await createStaff(officeId, "dsd-manager", "manager");
  u.staff = await createStaff(officeId, "dsd-staff", "staff");
  u.limited = await createStaff(officeId, "dsd-limited", "limited");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  await setTestToday(officeId, TODAY);
  clientA = await bankOnlyClient(as.staff, officeId, { name: "Due A", incharge_id: u.limited.id });
  clientB = await bankOnlyClient(as.staff, officeId, { name: "Due B", incharge_id: u.staff.id });
  const clientC = await bankOnlyClient(as.staff, officeId, { name: "Due C archived", incharge_id: u.staff.id });
  const add = (c: string, holder: string, expires_on: string) => mustSaveDsc(as.staff, newDsc(c, { holder_name: holder, expires_on }));
  d.a30 = await add(clientA, "A thirty", "2026-11-30");
  d.a31 = await add(clientA, "A thirty-one", "2026-12-01");
  d.aExpired = await add(clientA, "A expired", "2026-10-21");
  d.aArchived = await add(clientA, "A archived", "2026-11-05");
  d.b40 = await add(clientB, "B forty", "2026-12-10");
  d.b50 = await add(clientB, "B fifty", "2026-12-20");
  d.cGone = await add(clientC, "C gone", "2026-11-05");
  const r1 = await archiveDsc(as.manager, d.aArchived, "Not managed");
  if (r1.error) throw new Error(r1.error.message);
  const r2 = await as.manager.from("client").update({ archived_at: new Date().toISOString(), archive_reason: "Test" }).eq("id", clientC).select("id");
  if (r2.error) throw r2.error;
  const r3 = await setRemindDays(as.staff, clientB, 45);
  if (r3.error) throw new Error(r3.error.message);
  const r4 = await logCustody(as.staff, { dsc_id: d.a30, direction: "out", person_name: "Client director", on_date: "2026-10-15" });
  if (r4.error) throw new Error(r4.error.message);
}, 120_000);

afterAll(async () => {
  await retireStaff([u.manager, u.staff, u.limited].filter(Boolean).map((x) => x.id));
});

describe("dsc_due (AC-11)", () => {
  it("Everyone: expiring within the client's window or expired, soonest first; archived DSCs and clients left out", async () => {
    const r = await dscDue(as.staff, "everyone");
    expect(r.rows.map((x) => x.id)).toEqual([d.aExpired, d.a30, d.b40]);
    expect(r.count).toBe(3);
  });

  it("each row carries what the Today section shows (no password)", async () => {
    const row = (await dscDue(as.staff, "everyone")).rows.find((x) => x.id === d.a30)!;
    expect(row).toMatchObject({
      client_id: clientA, client_name: "Due A", holder_name: "A thirty", expires_on: "2026-11-30", days_left: 30,
      remind_days: 30, out_to: "Client director", out_since: "2026-10-15",
    });
    expect(row.client_code).toMatch(/^C\d{4}$/);
    expect(Object.keys(row)).not.toContain("password_ct");
    expect((await dscDue(as.staff, "everyone")).rows.find((x) => x.id === d.aExpired)).toMatchObject({ days_left: -10, out_to: null });
    expect((await dscDue(as.staff, "everyone")).rows.find((x) => x.id === d.b40)).toMatchObject({ days_left: 40, remind_days: 45 });
  });

  it("Mine = clients I'm incharge of (T3)", async () => {
    expect(await ids(as.staff, "mine")).toEqual([d.b40]);
    expect(await ids(as.limited, "mine")).toEqual([d.aExpired, d.a30]);
    expect(await ids(as.manager, "mine")).toEqual([]);
  });

  it("Limited's Everyone = only the clients they can see", async () => {
    expect(await ids(as.limited, "everyone")).toEqual([d.aExpired, d.a30]);
  });

  it("a received-back DSC shows In office again (out_to null)", async () => {
    const r = await logCustody(as.staff, { dsc_id: d.a30, direction: "in", person_name: "Client director", on_date: "2026-10-20" });
    expect(r.error).toBeNull();
    expect((await dscDue(as.staff, "everyone")).rows.find((x) => x.id === d.a30)).toMatchObject({ out_to: null, out_since: null });
  });

  it("the window moves with the office date and the client's setting", async () => {
    await setTestToday(officeId, "2026-11-01");
    expect(await ids(as.staff, "everyone")).toEqual([d.aExpired, d.a30, d.a31, d.b40]);
    expect((await setRemindDays(as.staff, clientB, 60)).error).toBeNull();
    expect(await ids(as.staff, "mine")).toEqual([d.b40, d.b50]);
    await setTestToday(officeId, TODAY);
    expect((await setRemindDays(as.staff, clientB, 45)).error).toBeNull();
  });

  it("an unknown scope is refused", async () => {
    const { error } = await as.staff.rpc("dsc_due", { p_scope: "all" });
    expect(error?.message ?? "").toMatch(/BAD_SCOPE/);
  });
});

describe("dsc_due speed (spec NFR: < 300 ms at 1,000 clients × 3 DSCs)", () => {
  let perfOffice: string;
  let perfStaff: { id: string; email: string };
  let c: SupabaseClient;

  beforeAll(async () => {
    perfOffice = await createCatalogueOffice("dsc-due-perf");
    perfStaff = await createStaff(perfOffice, "dsd-perf-staff", "staff");
    c = await signedInClient(perfStaff.email);
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      office_id: perfOffice, name: `DSC perf ${String(i).padStart(4, "0")}`, client_type: "individual",
      incharge_id: perfStaff.id, pan: testPan("P", i),
    }));
    const { error } = await c.from("client").insert(rows);
    if (error) throw error;
    // test_seed_dsc spreads expiries over the 400 days around p_today, so roughly a tenth are due.
    const { data, error: e2 } = await adminClient().rpc("test_seed_dsc", { p_office_id: perfOffice, p_per_client: 3, p_today: TODAY });
    if (e2) throw new Error(e2.message);
    expect(data).toBe(3000);
    await setTestToday(perfOffice, TODAY);
  }, 180_000);

  afterAll(async () => { if (perfStaff) await retireStaff([perfStaff.id]); });

  it("Everyone and Mine: median of 5 warm calls under 300 ms", async () => {
    const time = async (scope: "mine" | "everyone") => {
      await dscDue(c, scope);
      const runs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        const r = await dscDue(c, scope);
        runs.push(performance.now() - t0);
        expect(r.count).toBeGreaterThan(0);
      }
      return runs.sort((x, y) => x - y)[2];
    };
    const everyone = await time("everyone");
    const mine = await time("mine");
    console.info("dsc_due timing (ms)", { everyone: Math.round(everyone), mine: Math.round(mine) });
    expect(everyone).toBeLessThan(300);
    expect(mine).toBeLessThan(300);
  }, 120_000);

  it("test_seed_dsc refuses a real office", async () => {
    const real = await createCatalogueOffice("dsc-due-not-test", { isTest: false, reset: false });
    const { error } = await adminClient().rpc("test_seed_dsc", { p_office_id: real, p_per_client: 1, p_today: TODAY });
    expect(error?.message ?? "").toMatch(/NOT_TEST_OFFICE/);
  });
});
