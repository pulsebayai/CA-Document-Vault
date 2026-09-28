import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { groupId, mustInsertClient } from "../support/catalogue";
import { activityFor, createDocument, createDocumentOffice, documentRow } from "../support/documents";

// Feature 03 — proposed types join the client's plan; suggestions come first (spec AC-15, AC-16, AC-17).
// Written before the migration (plan step 1).
//
// Contract under test:
//   create_proposed_type(p_client_id uuid, p_doc_group_id uuid, p_name text) → { doc_type_id, client_doc_type_id, client_group_id }
//   suggest_doc_types(p_client_id uuid, p_query text) → rows { doc_type_id, name, group_name, status, in_plan } best first, ≤ 10

type Who = "admin" | "manager" | "staff" | "limited";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
let clientX: string; // GST enabled, Income Tax not
let clientY: string;
let gst: string;
let incomeTax: string;
let banking: string;

type Suggestion = { doc_type_id: string; name: string; group_name: string; status: string; in_plan: boolean };
const suggest = async (who: Who, client: string, q: string) => {
  const { data, error } = await as[who].rpc("suggest_doc_types", { p_client_id: client, p_query: q });
  expect(error).toBeNull();
  return data as Suggestion[];
};
const propose = (who: Who, client: string, group: string, name: string) =>
  as[who].rpc("create_proposed_type", { p_client_id: client, p_doc_group_id: group, p_name: name }) as unknown as Promise<{
    data: { doc_type_id: string; client_doc_type_id: string; client_group_id: string } | null; error: { message: string } | null;
  }>;
const planOf = async (client: string) => {
  const { data, error } = await adminClient().from("client_doc_type")
    .select("id, doc_type_id, client_group_id, frequency, reminders, state, doc_type:doc_type_id(name, status)").eq("client_id", client);
  if (error) throw error;
  return data as unknown as Array<{ id: string; doc_type_id: string; client_group_id: string; frequency: string; reminders: boolean; state: string; doc_type: { name: string; status: string } }>;
};

beforeAll(async () => {
  officeId = await createDocumentOffice("proposed");
  u.admin = await createStaff(officeId, "proposed-admin", "admin");
  u.manager = await createStaff(officeId, "proposed-manager", "manager");
  u.staff = await createStaff(officeId, "proposed-staff", "staff");
  u.limited = await createStaff(officeId, "proposed-limited", "limited");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  gst = await groupId(officeId, "GST");
  incomeTax = await groupId(officeId, "Income Tax");
  banking = await groupId(officeId, "Banking");
  clientX = (await mustInsertClient(as.staff, officeId, { name: "Proposed client X", client_type: "proprietorship", incharge_id: u.limited.id })).id;
  clientY = (await mustInsertClient(as.staff, officeId, { name: "Proposed client Y", client_type: "individual", incharge_id: u.staff.id })).id;
  const { error } = await as.staff.rpc("enable_client_group", { p_client_id: clientX, p_doc_group_id: gst });
  if (error) throw error;
});

afterAll(async () => {
  await retireStaff([u.manager, u.staff, u.limited].filter(Boolean).map((x) => x.id));
  if (u.admin) await retireStaff([u.admin.id]);
});

describe("suggestions come first (AC-15)", () => {
  it("'form 16' finds Form 16 from employer and Form 16A, best match first", async () => {
    const s = await suggest("staff", clientX, "form 16");
    expect(s[0].name).toBe("Form 16 from employer");
    expect(s.map((x) => x.name)).toContain("Form 16A from deductors");
    expect(s.length).toBeLessThanOrEqual(10);
  });

  it("matches aliases: 'form 130' finds Form 16 from employer", async () => {
    const s = await suggest("staff", clientX, "form 130");
    expect(s.map((x) => x.name)).toContain("Form 16 from employer");
  });

  it("tolerates typos: 'purchse invoice' finds Purchase invoices / purchase register", async () => {
    const s = await suggest("staff", clientX, "purchse invoice");
    expect(s[0].name).toBe("Purchase invoices / purchase register");
  });

  it("marks types already in the client's plan and gives the group name", async () => {
    const s = await suggest("staff", clientX, "sales invoices");
    const sales = s.find((x) => x.name === "Sales invoices / sales register")!;
    expect(sales).toMatchObject({ group_name: "GST", in_plan: true, status: "approved" });
    const ySales = (await suggest("staff", clientY, "sales invoices")).find((x) => x.name === "Sales invoices / sales register")!;
    expect(ySales.in_plan).toBe(false);
  });

  it("never offers inactive types", async () => {
    await as.admin.from("doc_type").update({ active: false }).eq("office_id", officeId).eq("name", "E-way bills");
    expect((await suggest("staff", clientX, "e-way bills")).map((x) => x.name)).not.toContain("E-way bills");
  });
});

describe("create a proposed type (AC-15)", () => {
  let proposed: { doc_type_id: string; client_doc_type_id: string; client_group_id: string };

  it("a group that isn't enabled gets a client group row holding only the proposed type", async () => {
    const { data, error } = await propose("staff", clientX, incomeTax, "Crypto exchange tax statement");
    expect(error).toBeNull();
    proposed = data!;
    const { data: type } = await adminClient().from("doc_type")
      .select("status, source, proposed_by, proposed_for_client_id, default_frequency, reminders, active, doc_group_id").eq("id", proposed.doc_type_id).single();
    expect(type).toMatchObject({
      status: "proposed", source: "client", proposed_by: u.staff.id, proposed_for_client_id: clientX,
      default_frequency: "as_needed", reminders: false, active: true, doc_group_id: incomeTax,
    });
    const itRows = (await planOf(clientX)).filter((r) => r.client_group_id === proposed.client_group_id);
    expect(itRows.map((r) => r.doc_type.name)).toEqual(["Crypto exchange tax statement"]); // no other Income Tax types copied
    expect(itRows[0]).toMatchObject({ frequency: "as_needed", reminders: false, state: "active" });
    const { data: grp } = await adminClient().from("client_group").select("state, doc_group_id").eq("id", proposed.client_group_id).single();
    expect(grp).toEqual({ state: "active", doc_group_id: incomeTax });
  });

  it("in an enabled group it joins the existing group row and leaves the other types alone", async () => {
    const before = await planOf(clientX);
    const { data, error } = await propose("staff", clientX, gst, "Job work challans");
    expect(error).toBeNull();
    const gstGroup = before.find((r) => r.doc_type.name === "Sales invoices / sales register")!.client_group_id;
    expect(data!.client_group_id).toBe(gstGroup);
    const after = await planOf(clientX);
    expect(after.length).toBe(before.length + 1);
  });

  it("writes one activity row with IDs only", async () => {
    const rows = await activityFor(officeId, proposed.doc_type_id);
    expect(rows.map((r) => r.action)).toEqual(["doc_type.proposed"]);
    expect(rows[0].data).toMatchObject({ client_id: clientX, doc_group_id: incomeTax });
    expect(JSON.stringify(rows[0].data)).not.toContain("Crypto");
  });

  it("the client's own proposed type is suggested for that client only", async () => {
    const forX = await suggest("staff", clientX, "crypto exchange");
    expect(forX.find((x) => x.doc_type_id === proposed.doc_type_id)).toMatchObject({ status: "proposed", in_plan: true });
    const forY = await suggest("staff", clientY, "crypto exchange");
    expect(forY.map((x) => x.doc_type_id)).not.toContain(proposed.doc_type_id);
  });

  it("documents can be filed under it for that client only", async () => {
    const ok = await createDocument(as.staff, { client_id: clientX, doc_type_id: proposed.doc_type_id });
    expect(ok.error).toBeNull();
    expect((await documentRow(ok.data!.id)).classified_at).not.toBeNull();
    const other = await createDocument(as.staff, { client_id: clientY, doc_type_id: proposed.doc_type_id });
    expect(other.error?.message ?? "").toMatch(/TYPE_NOT_OFFERED/);
  });

  it("another client may propose the same name separately (05 merges them on approval)", async () => {
    const { data, error } = await propose("staff", clientY, incomeTax, "Crypto exchange tax statement");
    expect(error).toBeNull();
    expect(data!.doc_type_id).not.toBe(proposed.doc_type_id);
  });

  it("the same name twice for the same client, or the name of an existing approved type, is refused", async () => {
    const again = await propose("staff", clientX, incomeTax, "crypto exchange TAX statement");
    expect(again.error?.message ?? "").toMatch(/DUPLICATE_TYPE/);
    const approved = await propose("staff", clientY, incomeTax, "Form 16 from employer");
    expect(approved.error?.message ?? "").toMatch(/DUPLICATE_TYPE/);
  });

  it("names are 1–120 characters", async () => {
    expect((await propose("staff", clientY, banking, "  ")).error?.message ?? "").toMatch(/NAME|violates/);
    expect((await propose("staff", clientY, banking, "x".repeat(121))).error?.message ?? "").toMatch(/NAME|violates/);
  });

  it("Limited users can't propose types (they change collection plans) — they file to the Inbox instead", async () => {
    const r = await propose("limited", clientX, banking, "Locker rent receipt");
    expect(r.error?.message ?? "").toMatch(/ROLE_REQUIRED/);
  });

  it("a proposed type can't be created by a direct insert that skips the plan", async () => {
    const r = await as.staff.from("doc_type").insert({
      office_id: officeId, doc_group_id: banking, code: "x_sneaky", name: "Sneaky type", period_kind: "none",
      default_frequency: "as_needed", source: "client", status: "proposed", proposed_for_client_id: clientY,
    });
    expect(r.error).not.toBeNull(); // catalogue inserts stay Admin/Manager (02 policy)
  });

  it("status proposed ⇔ proposed_for_client_id is set", async () => {
    const r = await as.admin.from("doc_type").insert({
      office_id: officeId, doc_group_id: banking, code: "x_half_proposed", name: "Half proposed", period_kind: "none",
      default_frequency: "as_needed", source: "client", status: "proposed",
    });
    expect(r.error?.message ?? "").toMatch(/violates|PROPOSED/);
  });
});

describe("'Proposed by staff' panel data (AC-16)", () => {
  it("Admin and Manager can list pending proposed types with proposer and client", async () => {
    for (const who of ["admin", "manager"] as const) {
      const { data, error } = await as[who].from("doc_type")
        .select("id, name, doc_group_id, proposed_by, proposed_for_client_id, created_at")
        .eq("office_id", officeId).eq("status", "proposed");
      expect(error).toBeNull();
      expect(data!.length).toBeGreaterThanOrEqual(3);
      expect(data!.every((r) => r.proposed_by && r.proposed_for_client_id)).toBe(true);
    }
  });
});
