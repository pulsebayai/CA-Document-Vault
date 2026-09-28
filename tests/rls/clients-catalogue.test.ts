import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { DENIED, createCatalogueOffice, groupId, insertClient, mustInsertClient } from "../support/catalogue";
import { testGstin, testPan, testTan } from "../support/test-data";

// Feature 02 — catalogue, clients and access rules enforced by the database (spec AC-1…12, AC-23).
// Written before the migration (plan step 2): every test here is expected to fail until step 3/4.

const TABLES = [
  "client", "client_registration", "client_contact", "doc_group", "doc_type",
  "financial_year", "period", "client_group", "client_doc_type",
] as const;

let officeId: string;
let otherOfficeId: string;
const u = {} as Record<"admin" | "manager" | "staff" | "limited" | "outsider", { id: string; email: string }>;
const as = {} as Record<keyof typeof u, SupabaseClient>;

beforeAll(async () => {
  officeId = await createCatalogueOffice("cc");
  otherOfficeId = await createCatalogueOffice("cc-other");
  u.admin = await createStaff(officeId, "cc-admin", "admin");
  u.manager = await createStaff(officeId, "cc-manager", "manager");
  u.staff = await createStaff(officeId, "cc-staff", "staff");
  u.limited = await createStaff(officeId, "cc-limited", "limited");
  u.outsider = await createStaff(otherOfficeId, "cc-outsider", "admin");
  for (const k of Object.keys(u) as (keyof typeof u)[]) as[k] = await signedInClient(u[k].email);
});

afterAll(async () => {
  const rest = [u.manager, u.staff, u.limited].filter(Boolean).map((x) => x.id);
  await retireStaff(rest);
  await retireStaff([u.admin, u.outsider].filter(Boolean).map((x) => x.id));
});

// ── Seed (AC-1, AC-5) ────────────────────────────────────────────────────────
describe("seeded catalogue (AC-1)", () => {
  it("has the 10 groups, 47 client documents and 9 firm records from seed-catalogue.md", async () => {
    const { data: groups } = await as.staff.from("doc_group").select("name, enabled_for_new_clients").eq("office_id", officeId);
    expect(groups?.map((g) => g.name).sort()).toEqual(
      ["Accounting", "Audit", "Banking", "GST", "Income Tax", "Other", "Payroll", "ROC/MCA", "Registrations", "TDS/TCS"]);
    expect(groups?.some((g) => g.enabled_for_new_clients)).toBe(false); // none pre-ticked (spec gate)
    const { data: types } = await as.staff.from("doc_type").select("source").eq("office_id", officeId);
    expect(types?.filter((t) => t.source === "client").length).toBe(47);
    expect(types?.filter((t) => t.source === "firm").length).toBe(9);
  });

  it("stores schedules as offsets from period end, with registration kind on GST/TDS types", async () => {
    const { data } = await as.staff.from("doc_type")
      .select("name, period_kind, default_frequency, ask_after_months, ask_day, overdue_after_months, overdue_day, reminders, registration_kind, aliases, used_for")
      .eq("office_id", officeId).eq("name", "Form 16 from employer").single();
    expect(data).toMatchObject({
      period_kind: "year", default_frequency: "yearly", ask_after_months: 2, ask_day: 16,
      overdue_after_months: 3, overdue_day: 10, reminders: true, registration_kind: null,
    });
    expect(data?.aliases).toContain("Form 130");
    const { data: sales } = await as.staff.from("doc_type").select("registration_kind").eq("office_id", officeId)
      .eq("name", "Sales invoices / sales register").single();
    expect(sales?.registration_kind).toBe("gstin");
  });

  it("rejects a firm record with a schedule or reminders (DB check)", async () => {
    const gst = await groupId(officeId, "GST");
    const base = { office_id: officeId, doc_group_id: gst, period_kind: "month", default_frequency: "as_needed", source: "firm" };
    const r1 = await as.admin.from("doc_type").insert({ ...base, code: "x_firm_1", name: "Bad firm record 1", ask_after_months: 1, ask_day: 1, overdue_after_months: 1, overdue_day: 5 });
    expect(r1.error?.message).toMatch(/violates check/);
    const r2 = await as.admin.from("doc_type").insert({ ...base, code: "x_firm_2", name: "Bad firm record 2", reminders: true });
    expect(r2.error?.message).toMatch(/violates check/);
  });
});

describe("financial years (AC-5)", () => {
  it("FY 2025-26 and 2026-27 each have 12 months + 4 quarters + 1 year", async () => {
    for (const code of ["2025-26", "2026-27"]) {
      const { data: fy } = await as.staff.from("financial_year").select("id, start_date, end_date").eq("office_id", officeId).eq("code", code).single();
      expect(fy?.start_date).toBe(`20${code.slice(2, 4)}-04-01`);
      const { data: periods } = await as.staff.from("period").select("kind").eq("financial_year_id", fy!.id);
      const count = (k: string) => periods?.filter((p) => p.kind === k).length;
      expect([count("month"), count("quarter"), count("year")]).toEqual([12, 4, 1]);
    }
  });

  it("admin adds the next FY with its 17 periods; staff cannot; a duplicate FY is rejected", async () => {
    const denied = await as.staff.rpc("add_financial_year");
    expect(denied.error?.message ?? "").toMatch(DENIED);
    const { data: fyId, error } = await as.admin.rpc("add_financial_year");
    expect(error).toBeNull();
    const { data: fy } = await as.admin.from("financial_year").select("code").eq("id", fyId).single();
    expect(fy?.code).toBe("2027-28");
    const { count } = await as.admin.from("period").select("id", { count: "exact", head: true }).eq("financial_year_id", fyId);
    expect(count).toBe(17);
    const dup = await as.admin.from("financial_year").insert({ office_id: officeId, code: "2027-28", start_date: "2027-04-01", end_date: "2028-03-31" });
    expect(dup.error?.message ?? "").toMatch(/duplicate key/);
  });
});

// ── Catalogue writes (AC-2, AC-3, AC-6) ──────────────────────────────────────
describe("catalogue write roles (AC-2, AC-3, AC-6)", () => {
  it("admin and manager can add, rename and deactivate types and groups", async () => {
    const gst = await groupId(officeId, "GST");
    const { data: t, error } = await as.manager.from("doc_type").insert({
      office_id: officeId, doc_group_id: gst, code: "x_mgr", name: "Manager-added type", period_kind: "month",
      default_frequency: "monthly", source: "client", ask_after_months: 1, ask_day: 1, overdue_after_months: 1, overdue_day: 5, reminders: true,
    }).select("id").single();
    expect(error).toBeNull();
    const ren = await as.admin.from("doc_type").update({ name: "Manager-added type (renamed)", active: false }).eq("id", t!.id).select("id");
    expect(ren.data?.length).toBe(1);
    const grp = await as.admin.from("doc_group").update({ enabled_for_new_clients: true }).eq("id", gst).select("id");
    expect(grp.data?.length).toBe(1);
    await as.admin.from("doc_group").update({ enabled_for_new_clients: false }).eq("id", gst);
  });

  it("type names are unique per group, ignoring case", async () => {
    const gst = await groupId(officeId, "GST");
    const { error } = await as.admin.from("doc_type").insert({
      office_id: officeId, doc_group_id: gst, code: "x_dup", name: "BANK STATEMENT", period_kind: "month", default_frequency: "as_needed", source: "client",
    });
    expect(error).toBeNull(); // "Bank statement" lives in Banking, not GST
    const { error: e2 } = await as.admin.from("doc_type").insert({
      office_id: officeId, doc_group_id: gst, code: "x_dup2", name: "sales invoices / SALES register", period_kind: "month", default_frequency: "as_needed", source: "client",
    });
    expect(e2?.message ?? "").toMatch(/duplicate key/);
  });

  it("staff and limited can read the catalogue but every write is rejected", async () => {
    const gst = await groupId(officeId, "GST");
    for (const who of ["staff", "limited"] as const) {
      const c = as[who];
      expect((await c.from("doc_type").select("id").eq("office_id", officeId)).data?.length).toBeGreaterThan(50);
      const ins = await c.from("doc_type").insert({ office_id: officeId, doc_group_id: gst, code: `x_${who}`, name: `By ${who}`, period_kind: "none", default_frequency: "as_needed", source: "client" });
      expect(ins.error?.message ?? "").toMatch(DENIED);
      const upd = await c.from("doc_type").update({ name: "hijacked" }).eq("doc_group_id", gst).select("id");
      expect(upd.data ?? []).toEqual([]);
      const grp = await c.from("doc_group").update({ name: "hijacked" }).eq("id", gst).select("id");
      expect(grp.data ?? []).toEqual([]);
      const gi = await c.from("doc_group").insert({ office_id: officeId, code: `g_${who}`, name: `Group by ${who}`, sort: 99 });
      expect(gi.error?.message ?? "").toMatch(DENIED);
      const fy = await c.from("financial_year").insert({ office_id: officeId, code: "2099-00", start_date: "2099-04-01", end_date: "2100-03-31" });
      expect(fy.error?.message ?? "").toMatch(DENIED);
    }
  });
});

// ── Clients (AC-8 … AC-11) ───────────────────────────────────────────────────
describe("client create + code (AC-8)", () => {
  it("staff can add a client; the vault assigns consecutive codes that cannot be set or changed", async () => {
    const a = await mustInsertClient(as.staff, officeId, { name: "Code test A", client_type: "individual", incharge_id: u.staff.id, pan: testPan("P", 1) });
    expect(a.code).toMatch(/^C\d{4,}$/);
    // A failed insert (duplicate PAN) must not burn a number: no gaps.
    const bad = await insertClient(as.staff, officeId, { name: "Dup PAN", client_type: "individual", incharge_id: u.staff.id, pan: testPan("P", 1) });
    expect(bad.error?.message ?? "").toMatch(/duplicate key/);
    const forced = await as.staff.from("client").insert({ office_id: officeId, name: "Forced code", client_type: "huf", incharge_id: u.staff.id, code: "C9999" });
    expect(forced.error?.message ?? "").toMatch(/permission denied/); // code is never client-supplied
    const b = await mustInsertClient(as.staff, officeId, { name: "Code test B", client_type: "huf", incharge_id: u.staff.id });
    expect(Number(b.code.slice(1))).toBe(Number(a.code.slice(1)) + 1);
    const upd = await as.admin.from("client").update({ code: "C0001" }).eq("id", a.id).select("code");
    expect(upd.error?.message ?? "").toMatch(DENIED);
  });

  it("limited users cannot add clients", async () => {
    const { error } = await insertClient(as.limited, officeId, { name: "By limited", client_type: "individual", incharge_id: u.limited.id });
    expect(error?.message ?? "").toMatch(DENIED);
  });

  it("codes are per office", async () => {
    const other = await mustInsertClient(as.outsider, otherOfficeId, { name: "Other office client", client_type: "trust", incharge_id: u.outsider.id });
    const { data: mine } = await as.admin.from("client").select("code").eq("office_id", officeId);
    expect(mine?.length).toBeGreaterThan(0);
    expect(other.code).toBe("C0001"); // reset_test_office restarts the counter for test offices
  });
});

describe("identifier rules in the database (AC-8, AC-9 backstop)", () => {
  it("rejects a malformed PAN, a PAN whose 4th letter contradicts the type, a bad mobile", async () => {
    const r1 = await insertClient(as.staff, officeId, { name: "Bad PAN", client_type: "individual", incharge_id: u.staff.id, pan: "ABCDE12345" });
    expect(r1.error?.message).toMatch(/violates check|PAN/);
    const r2 = await insertClient(as.staff, officeId, { name: "Wrong letter", client_type: "individual", incharge_id: u.staff.id, pan: testPan("C", 2) });
    expect(r2.error?.message).toMatch(/violates check|PAN_TYPE/);
    const r3 = await insertClient(as.staff, officeId, { name: "Bad mobile", client_type: "individual", incharge_id: u.staff.id, mobile: "12345" });
    expect(r3.error?.message).toMatch(/violates check/);
    // Warn-only letters (society/co-op) are allowed through.
    const ok = await insertClient(as.staff, officeId, { name: "Society OK", client_type: "society", incharge_id: u.staff.id, pan: testPan("L", 3) });
    expect(ok.error).toBeNull();
  });

  it("a GSTIN must contain the client's PAN; a TAN must be well-formed; numbers are unique per office", async () => {
    const pan = testPan("F", 4);
    const c = await mustInsertClient(as.staff, officeId, { name: "Reg test", client_type: "partnership", incharge_id: u.staff.id, pan });
    const good = await as.staff.from("client_registration").insert({ office_id: officeId, client_id: c.id, kind: "gstin", number: testGstin(pan) }).select("state_code").single();
    expect(good.error).toBeNull();
    expect(good.data?.state_code).toBe("33"); // derived, not typed
    const wrong = await as.staff.from("client_registration").insert({ office_id: officeId, client_id: c.id, kind: "gstin", number: testGstin(testPan("F", 5)) });
    expect(wrong.error?.message).toMatch(/GSTIN_PAN|violates/);
    const tan = await as.staff.from("client_registration").insert({ office_id: officeId, client_id: c.id, kind: "tan", number: testTan(4) });
    expect(tan.error).toBeNull();
    const badTan = await as.staff.from("client_registration").insert({ office_id: officeId, client_id: c.id, kind: "tan", number: "ZZZ123456Z" });
    expect(badTan.error?.message).toMatch(/violates check/);
    const dup = await as.staff.from("client_registration").insert({ office_id: officeId, client_id: c.id, kind: "tan", number: testTan(4) });
    expect(dup.error?.message).toMatch(/duplicate key/);
  });
});

describe("incharge and archive are Admin/Manager only (AC-10, AC-11)", () => {
  it("staff can edit details but not incharge; manager can change incharge", async () => {
    const c = await mustInsertClient(as.staff, officeId, { name: "Edit test", client_type: "individual", incharge_id: u.staff.id });
    const det = await as.staff.from("client").update({ name: "Edit test (renamed)", email: "client@example.test" }).eq("id", c.id).select("id");
    expect(det.error).toBeNull();
    expect(det.data?.length).toBe(1);
    const inc = await as.staff.from("client").update({ incharge_id: u.admin.id }).eq("id", c.id);
    expect(inc.error?.message ?? "").toMatch(/ROLE_REQUIRED|permission denied/);
    const mgr = await as.manager.from("client").update({ incharge_id: u.admin.id }).eq("id", c.id).select("incharge_id").single();
    expect(mgr.data?.incharge_id).toBe(u.admin.id);
  });

  it("staff cannot archive; manager archives; PAN frees up; unarchive is blocked while another active client holds the PAN", async () => {
    const pan = testPan("P", 6);
    const c = await mustInsertClient(as.staff, officeId, { name: "Archive test", client_type: "individual", incharge_id: u.staff.id, pan });
    const byStaff = await as.staff.from("client").update({ archived_at: new Date().toISOString() }).eq("id", c.id);
    expect(byStaff.error?.message ?? "").toMatch(/ROLE_REQUIRED|permission denied/);
    const byMgr = await as.manager.from("client").update({ archived_at: new Date().toISOString(), archived_by: u.manager.id }).eq("id", c.id).select("id");
    expect(byMgr.data?.length).toBe(1);
    const reuse = await mustInsertClient(as.staff, officeId, { name: "Same PAN, new client", client_type: "individual", incharge_id: u.staff.id, pan });
    expect(reuse.pan).toBe(pan);
    const unarch = await as.manager.from("client").update({ archived_at: null, archived_by: null }).eq("id", c.id);
    expect(unarch.error?.message ?? "").toMatch(/duplicate key/);
  });
});

describe("no hard delete (AC-11)", () => {
  it("DELETE is rejected on every new table, even for the service role", async () => {
    const svc = adminClient();
    // Make sure every table has at least one row in this office.
    const c = await mustInsertClient(as.staff, officeId, { name: "Delete test", client_type: "partnership", incharge_id: u.staff.id, pan: testPan("F", 10) });
    await as.staff.from("client_registration").insert({ office_id: officeId, client_id: c.id, kind: "tan", number: testTan(10) });
    await svc.from("client_contact").insert({ office_id: officeId, client_id: c.id, name: "Test contact", role: "accountant" });
    await as.staff.rpc("enable_client_group", { p_client_id: c.id, p_doc_group_id: await groupId(officeId, "Accounting") });
    for (const t of TABLES) {
      const { data: row } = await svc.from(t).select("id").eq("office_id", officeId).limit(1).maybeSingle();
      expect(row, `${t} has a row to try`).not.toBeNull();
      const { error } = await svc.from(t).delete().eq("id", row!.id);
      expect(error?.message, t).toMatch(/NO_DELETE/);
      const byAdmin = await as.admin.from(t).delete().eq("id", row!.id);
      expect(byAdmin.error?.message ?? "", t).toMatch(/permission denied|NO_DELETE/);
    }
  });
});

// ── Visibility (AC-12) + tenant isolation ────────────────────────────────────
describe("limited users see only their clients (AC-12)", () => {
  let mine: string, viaGroup: string, hidden: string;

  beforeAll(async () => {
    mine = (await mustInsertClient(as.admin, officeId, { name: "Limited is incharge", client_type: "individual", incharge_id: u.limited.id })).id;
    viaGroup = (await mustInsertClient(as.admin, officeId, { name: "Limited assigned to group", client_type: "individual", incharge_id: u.admin.id })).id;
    hidden = (await mustInsertClient(as.admin, officeId, { name: "Not for limited", client_type: "individual", incharge_id: u.admin.id, pan: testPan("P", 8) })).id;
    await as.admin.from("client_registration").insert({ office_id: officeId, client_id: hidden, kind: "gstin", number: testGstin(testPan("P", 8)) });
    const banking = await groupId(officeId, "Banking");
    const { data: cg, error } = await as.admin.rpc("enable_client_group", { p_client_id: viaGroup, p_doc_group_id: banking });
    if (error) throw error;
    await as.admin.from("client_group").update({ assigned_staff_id: u.limited.id }).eq("id", cg);
    await as.admin.rpc("enable_client_group", { p_client_id: hidden, p_doc_group_id: banking });
  });

  it("returns only clients where they are incharge or assigned to an active group", async () => {
    const { data } = await as.limited.from("client").select("id");
    const ids = data?.map((r) => r.id) ?? [];
    expect(ids).toContain(mine);
    expect(ids).toContain(viaGroup);
    expect(ids).not.toContain(hidden);
  });

  it("child rows of hidden clients are invisible too", async () => {
    for (const t of ["client_registration", "client_group", "client_doc_type"] as const) {
      const { data } = await as.limited.from(t).select("id").eq("client_id", hidden);
      expect(data ?? [], t).toEqual([]);
    }
  });

  it("losing the assignment (group removed) hides the client again", async () => {
    await as.admin.rpc("disable_client_group", { p_client_id: viaGroup, p_doc_group_id: await groupId(officeId, "Banking") });
    const { data } = await as.limited.from("client").select("id").eq("id", viaGroup);
    expect(data ?? []).toEqual([]);
  });

  it("limited users cannot edit even their own clients", async () => {
    const { data } = await as.limited.from("client").update({ name: "changed by limited" }).eq("id", mine).select("id");
    expect(data ?? []).toEqual([]);
  });
});

describe("tenant isolation on all new tables", () => {
  it("another office's admin reads nothing from this office", async () => {
    for (const t of TABLES) {
      const { data, error } = await as.outsider.from(t).select("id, office_id");
      expect(error, t).toBeNull();
      expect(data?.every((r) => r.office_id === otherOfficeId), t).toBe(true);
    }
  });

  it("cannot write into another office", async () => {
    const { error } = await insertClient(as.outsider, officeId, { name: "Cross-office", client_type: "individual", incharge_id: u.outsider.id });
    expect(error?.message ?? "").toMatch(DENIED);
    const gst = await groupId(officeId, "GST");
    const upd = await as.outsider.from("doc_group").update({ name: "x" }).eq("id", gst).select("id");
    expect(upd.data ?? []).toEqual([]);
  });

  it("incharge must be active staff of the same office", async () => {
    const { error } = await insertClient(as.admin, officeId, { name: "Foreign incharge", client_type: "individual", incharge_id: u.outsider.id });
    expect(error?.message ?? "").toMatch(/INCHARGE|violates/);
  });
});

// ── Audit (AC-23) ────────────────────────────────────────────────────────────
describe("activity never stores PII values (AC-23)", () => {
  it("the database rejects activity data with PII keys or PAN/GSTIN/email/mobile-shaped values", async () => {
    const svc = adminClient();
    const base = { office_id: officeId, actor_id: u.admin.id, action: "client.updated", entity_type: "client" };
    const bad = [
      { pan: "x" }, { fields: ["name"], email: "x" }, { note: testPan("P", 9) }, { note: testGstin(testPan("P", 9)) },
      { note: "someone@example.test" }, { nested: { v: "9876543210" } },
    ];
    for (const data of bad) {
      const { error } = await svc.from("activity").insert({ ...base, data });
      expect(error?.message, JSON.stringify(Object.keys(data))).toMatch(/ACTIVITY_PII/);
    }
    const ok = await svc.from("activity").insert({ ...base, data: { fields: ["pan", "email"], client_id: crypto.randomUUID() } });
    expect(ok.error).toBeNull(); // field NAMES are fine
  });
});

// ── Test-office purge guard (plan D2) ────────────────────────────────────────
describe("reset_test_office (plan D2)", () => {
  it("is not callable by signed-in users", async () => {
    const { error } = await as.admin.rpc("reset_test_office", { p_office_id: officeId });
    expect(error?.message ?? "").toMatch(/permission denied|not found|Could not find/i);
  });

  it("refuses an office that is not flagged is_test", async () => {
    const realLike = await createCatalogueOffice("cc-not-test", { isTest: false, reset: false });
    const { error } = await adminClient().rpc("reset_test_office", { p_office_id: realLike });
    expect(error?.message ?? "").toMatch(/NOT_TEST_OFFICE/);
  });
});
