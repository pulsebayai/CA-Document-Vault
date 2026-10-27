import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, typeId } from "../support/documents";
import { groupId, proposeType } from "../support/catalogue";
import { T, bankOnlyClient, planRow } from "../support/expected";
import { EXCEL, FORMAT_CHOICES, SEEDED, preferredOf, seedPreferences, setPreferred } from "../support/formats";

// Feature 11 — preferences, seed and exceptions (spec AC-1, AC-2, AC-4, AC-5, AC-6, AC-8; plan step 1).
// Written before migration A: every test here fails until the columns, checks, grants and seed exist.

type Who = "admin" | "manager" | "staff" | "limited";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
let clientId: string;
let beforeSeed: number;
let seededCount: number;
const admin = () => adminClient();

beforeAll(async () => {
  officeId = await createDocumentOffice("formats-prefs");
  const { count } = await admin().from("doc_type").select("id", { count: "exact", head: true })
    .eq("office_id", officeId).not("preferred_formats", "is", null);
  beforeSeed = count ?? -1;
  seededCount = await seedPreferences(officeId);
  u.admin = await createStaff(officeId, "fp-admin", "admin");
  u.manager = await createStaff(officeId, "fp-manager", "manager");
  u.staff = await createStaff(officeId, "fp-staff", "staff");
  u.limited = await createStaff(officeId, "fp-limited", "limited");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  // The Limited user is the incharge, so they can see the client but still can't change plan rows.
  clientId = await bankOnlyClient(as.staff, officeId, { name: "Formats prefs client", incharge_id: u.limited.id });
}, 300_000);

afterAll(async () => {
  await retireStaff(Object.values(u).filter(Boolean).map((x) => x.id));
});

describe("pre-loaded preferences (AC-4, S1)", () => {
  it("an automated-test office starts with none (migration C); the seed sets exactly six", () => {
    expect(beforeSeed).toBe(0);
    expect(seededCount).toBe(6);
  });

  it("a freshly seeded office has the six preferences and nothing else", async () => {
    for (const [name, formats] of Object.entries(SEEDED)) {
      expect([...(await preferredOf(officeId, name) ?? [])].sort(), name).toEqual([...formats].sort());
    }
    const { data, error } = await admin().from("doc_type").select("name, preferred_formats")
      .eq("office_id", officeId).not("preferred_formats", "is", null);
    if (error) throw error;
    expect((data ?? []).map((r) => r.name).sort()).toEqual(Object.keys(SEEDED).sort());
  });

  it("the seed skips a renamed type and never overwrites a list that is already set", async () => {
    await admin().from("doc_type").update({ name: "Payroll register (renamed)" }).eq("office_id", officeId).eq("name", "Salary register / attendance");
    await setPreferred(officeId, "Payroll register (renamed)", null);
    await setPreferred(officeId, T.bank, ["pdf"]);
    await setPreferred(officeId, "Salary paid to employees (for TDS)", null);
    try {
      const { data, error } = await admin().rpc("test_seed_preferred_formats", { p_office_id: officeId });
      if (error) throw new Error(error.message);
      expect(data).toBe(1); // only the TDS salary type was missing a list
      expect(await preferredOf(officeId, "Payroll register (renamed)")).toBeNull();
      expect(await preferredOf(officeId, T.bank)).toEqual(["pdf"]);
      expect([...(await preferredOf(officeId, "Salary paid to employees (for TDS)") ?? [])].sort()).toEqual([...EXCEL].sort());
    } finally {
      await admin().from("doc_type").update({ name: "Salary register / attendance" }).eq("office_id", officeId).eq("name", "Payroll register (renamed)");
      await setPreferred(officeId, "Salary register / attendance", EXCEL);
      await setPreferred(officeId, T.bank, EXCEL);
    }
  });

  it("the seed helper is service-role only and refuses a real office", async () => {
    const r1 = await as.admin.rpc("test_seed_preferred_formats", { p_office_id: officeId });
    expect(r1.error?.message ?? "").toMatch(/permission denied|not find|does not exist/i);
    const { data: real } = await admin().from("office").select("id").eq("is_test", false).limit(1).maybeSingle();
    if (real) {
      const r2 = await admin().rpc("test_seed_preferred_formats", { p_office_id: real.id });
      expect(r2.error?.message ?? "").toMatch(/NOT_TEST_OFFICE/);
    }
  });
});

describe("catalogue rules (AC-1, AC-2)", () => {
  const bad: Array<[string, unknown]> = [
    ["ZIP", ["zip"]], ["an unknown format", ["exe"]], ["upper case", ["PDF"]], ["a duplicate", ["pdf", "pdf"]], ["an empty list", []], ["jpeg (use jpg)", ["jpeg"]],
  ];
  for (const [label, value] of bad) {
    it(`refuses ${label}`, async () => {
      const { error } = await as.admin.from("doc_type").update({ preferred_formats: value }).eq("id", await typeId(officeId, T.form16)).select("id");
      expect(error?.message ?? "").toMatch(/violates check constraint|PREFERRED_FORMATS:/);
    });
  }

  it("accepts every format choice and clears back to null", async () => {
    const id = await typeId(officeId, T.form16);
    const r1 = await as.manager.from("doc_type").update({ preferred_formats: [...FORMAT_CHOICES] }).eq("id", id).select("preferred_formats").single();
    expect(r1.error).toBeNull();
    const r2 = await as.manager.from("doc_type").update({ preferred_formats: null }).eq("id", id).select("preferred_formats").single();
    expect(r2.data?.preferred_formats).toBeNull();
  });

  it("only Admin and Manager can change a type's preference", async () => {
    const id = await typeId(officeId, T.form16);
    for (const who of ["staff", "limited"] as const) {
      const { data } = await as[who].from("doc_type").update({ preferred_formats: ["pdf"] }).eq("id", id).select("id");
      expect(data ?? [], who).toEqual([]);
    }
    expect(await preferredOf(officeId, T.form16)).toBeNull();
  });

  it("a proposed type can't hold a preference", async () => {
    const proposed = await proposeType(as.staff, clientId, await groupId(officeId, "Banking"), "Formats prefs proposed");
    const { error } = await admin().from("doc_type").update({ preferred_formats: ["pdf"] }).eq("id", proposed);
    expect(error?.message ?? "").toMatch(/violates check constraint|PREFERRED_FORMATS:/);
  });
});

describe("client exceptions (AC-5, AC-6, AC-8; plan P1)", () => {
  it("new plan rows start without an exception", async () => {
    const row = await planRow(clientId, T.bank);
    const { data } = await admin().from("client_doc_type").select("any_format").eq("id", row.id).single();
    expect(data?.any_format).toBe(false);
  });

  it("Staff, Manager and Admin can set and clear it", async () => {
    const row = await planRow(clientId, T.bank);
    for (const who of ["staff", "manager", "admin"] as const) {
      const on = await as[who].from("client_doc_type").update({ any_format: true }).eq("id", row.id).select("any_format").single();
      expect(on.data?.any_format, who).toBe(true);
      const off = await as[who].from("client_doc_type").update({ any_format: false }).eq("id", row.id).select("any_format").single();
      expect(off.data?.any_format, who).toBe(false);
    }
  });

  it("Limited can't, even as the client's incharge", async () => {
    const row = await planRow(clientId, T.bank);
    const { data } = await as.limited.from("client_doc_type").update({ any_format: true }).eq("id", row.id).select("id");
    expect(data ?? []).toEqual([]);
    const { data: after } = await admin().from("client_doc_type").select("any_format").eq("id", row.id).single();
    expect(after?.any_format).toBe(false);
  });

  it("survives the row being removed and restored, and the type's preference being cleared", async () => {
    const row = await planRow(clientId, T.bank);
    await as.staff.from("client_doc_type").update({ any_format: true }).eq("id", row.id);
    try {
      await as.staff.from("client_doc_type").update({ state: "removed" }).eq("id", row.id);
      await as.staff.from("client_doc_type").update({ state: "active" }).eq("id", row.id);
      await setPreferred(officeId, T.bank, null);
      await setPreferred(officeId, T.bank, EXCEL);
      const { data } = await admin().from("client_doc_type").select("any_format, state").eq("id", row.id).single();
      expect(data).toEqual({ any_format: true, state: "active" });
    } finally {
      await as.staff.from("client_doc_type").update({ any_format: false, state: "active" }).eq("id", row.id);
      await setPreferred(officeId, T.bank, EXCEL);
    }
  });
});
