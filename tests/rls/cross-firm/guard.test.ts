import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createStaff, createTestOffice, signedInClient } from "../../support/db";
import { fnKey, inventory } from "./inventory";
import { FUNCTIONS, TABLES, type Coverage } from "./coverage";

// Feature 18 — the coverage guard (spec AC-2, AC-3). The database lists its own objects; every one needs a cross-firm
// case or a written exemption in coverage.ts, and the broad safety rules (RLS on, invoker views, nothing for anon,
// no Realtime, no Storage policies, no public bucket) hold for all of them.

const valid = (c: Coverage) =>
  ("cases" in c && c.cases.length > 0) || ("via" in c && c.via.length > 0) || ("exempt" in c && c.exempt.trim().length >= 20);

describe("cross-firm coverage guard", () => {
  it("every table and view in the database has a cross-firm case or a reasoned exemption, and nothing extra", async () => {
    const inv = await inventory();
    const names = [...inv.tables.map((t) => t.name), ...inv.views.map((v) => v.name)].sort();
    const missing = names.filter((n) => !(n in TABLES));
    const stale = Object.keys(TABLES).filter((n) => !names.includes(n));
    const weak = Object.entries(TABLES).filter(([, c]) => !valid(c)).map(([n]) => n);
    expect({ missing, stale, weak }).toEqual({ missing: [], stale: [], weak: [] });
  });

  it("every definer function and every function an app role can call has a case, a covering caller or an exemption", async () => {
    const inv = await inventory();
    const keys = inv.functions.map(fnKey).sort();
    const missing = keys.filter((k) => !(k in FUNCTIONS));
    const stale = Object.keys(FUNCTIONS).filter((k) => !keys.includes(k));
    const weak = Object.entries(FUNCTIONS).filter(([, c]) => !valid(c)).map(([k]) => k);
    // a "via" must name objects that are themselves covered by cases
    const badVia = Object.entries(FUNCTIONS).flatMap(([k, c]) =>
      "via" in c ? c.via.filter((v) => !((v in FUNCTIONS && "cases" in FUNCTIONS[v]) || (v in TABLES && "cases" in TABLES[v]))).map((v) => `${k} → ${v}`) : []);
    expect({ missing, stale, weak, badVia }).toEqual({ missing: [], stale: [], weak: [], badVia: [] });
  });

  it("safety rules: RLS on every table, invoker views, nothing for anon, no Realtime tables, no Storage policies or public buckets", async () => {
    const inv = await inventory();
    expect(inv.tables.filter((t) => !t.rls).map((t) => t.name)).toEqual([]);
    expect(inv.tables.filter((t) => t.anon).map((t) => t.name)).toEqual([]);
    expect(inv.views.filter((v) => !v.security_invoker || v.anon).map((v) => v.name)).toEqual([]);
    expect(inv.functions.filter((f) => f.anon).map(fnKey)).toEqual([]);
    expect(inv.realtime).toEqual([]);
    expect(inv.storage).toEqual({ policies: 0, public_buckets: [] });
  });

  it("AC-3: the inventory is for the service role only", async () => {
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } });
    expect((await anon.rpc("test_schema_inventory")).error).not.toBeNull();
    const office = await createTestOffice("xfirm-guard");
    const admin = await createStaff(office, "xfirm-guard-admin", "admin");
    const asAdmin = await signedInClient(admin.email);
    const r = await asAdmin.rpc("test_schema_inventory");
    expect(r.error).not.toBeNull();
    expect(r.data).toBeNull();
  });
});
