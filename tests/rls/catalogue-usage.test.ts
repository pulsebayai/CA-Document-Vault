import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { createCatalogueOffice, groupId, mustInsertClient } from "../support/catalogue";

// Feature 02 step 6 — "Used by N clients" on Settings › Document catalogue (spec UX flows).
// public.doc_type_usage is a security-invoker view: counts follow the caller's RLS.

let officeId: string;
let gst: string;
let salesTypeId: string;
const u = {} as Record<"admin" | "manager" | "staff" | "limited", { id: string; email: string }>;
const as = {} as Record<keyof typeof u, SupabaseClient>;
const SALES = "Sales invoices / sales register";

const usage = async (c: SupabaseClient) => {
  const { data, error } = await c.from("doc_type_usage").select("doc_type_id, clients").eq("doc_type_id", salesTypeId).maybeSingle();
  if (error) throw error;
  return data?.clients ?? 0;
};

beforeAll(async () => {
  officeId = await createCatalogueOffice("usage");
  u.admin = await createStaff(officeId, "usage-admin", "admin");
  u.manager = await createStaff(officeId, "usage-manager", "manager");
  u.staff = await createStaff(officeId, "usage-staff", "staff");
  u.limited = await createStaff(officeId, "usage-limited", "limited");
  for (const k of Object.keys(u) as (keyof typeof u)[]) as[k] = await signedInClient(u[k].email);
  gst = await groupId(officeId, "GST");
  const { data } = await as.admin.from("doc_type").select("id").eq("doc_group_id", gst).eq("name", SALES).single();
  salesTypeId = data!.id as string;
});

afterAll(async () => {
  await retireStaff(Object.values(u).filter(Boolean).map((x) => x.id));
});

describe("doc_type_usage (Used by N clients)", () => {
  let mine: string; let other: string;

  it("counts clients with the type active in their plan", async () => {
    expect(await usage(as.admin)).toBe(0);
    mine = (await mustInsertClient(as.staff, officeId, { name: "Usage client A", client_type: "individual", incharge_id: u.limited.id })).id;
    other = (await mustInsertClient(as.staff, officeId, { name: "Usage client B", client_type: "individual", incharge_id: u.staff.id })).id;
    for (const id of [mine, other]) {
      const { error } = await as.staff.rpc("enable_client_group", { p_client_id: id, p_doc_group_id: gst });
      expect(error).toBeNull();
    }
    expect(await usage(as.admin)).toBe(2);
    expect(await usage(as.staff)).toBe(2);
  });

  it("a Limited user only counts the clients they can see", async () => {
    expect(await usage(as.limited)).toBe(1);
  });

  it("removed types and archived clients are not counted", async () => {
    const { data: row } = await as.staff.from("client_doc_type").select("id").eq("client_id", other).eq("doc_type_id", salesTypeId).single();
    await as.staff.from("client_doc_type").update({ state: "removed" }).eq("id", row!.id);
    expect(await usage(as.admin)).toBe(1);
    await as.manager.from("client").update({ archived_at: new Date().toISOString(), archived_by: u.manager.id }).eq("id", mine);
    expect(await usage(as.admin)).toBe(0);
  });

  it("is not readable without signing in", async () => {
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
    const { data, error } = await anon.from("doc_type_usage").select("doc_type_id");
    expect(error !== null || (data ?? []).length === 0).toBe(true);
  });
});
