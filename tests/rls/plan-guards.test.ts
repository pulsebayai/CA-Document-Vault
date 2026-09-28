import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createCatalogueOffice, groupId } from "../support/catalogue";

// Feature 02 step 13 — review findings (written before the fix):
// 1. A paused group must not be un-paused by Staff by switching it off and on again (AC-20, S2).
// 2. Changing a client's incharge must move the groups that followed the old incharge; otherwise a Limited
//    ex-incharge keeps seeing the client through them (AC-10, AC-12).
// 3. A plan row's start period must belong to the same office (tenant isolation).

let officeId: string;
let otherOfficeId: string;
let gst: string;
let tds: string;
let it_: string;
const u = {} as Record<"manager" | "staff" | "limited" | "limited2", { id: string; email: string }>;
const as = {} as Record<keyof typeof u, SupabaseClient>;

const newClient = async (name: string, incharge: string, groups: string[]) => {
  const { data, error } = await as.staff.rpc("create_client", { p: { name, client_type: "individual", incharge_id: incharge, group_ids: groups } });
  if (error) throw error;
  return data.id as string;
};
const groupRow = async (clientId: string, docGroup: string) => {
  const { data, error } = await adminClient().from("client_group").select("id, state, assigned_staff_id")
    .eq("client_id", clientId).eq("doc_group_id", docGroup).single();
  if (error) throw error;
  return data as { id: string; state: string; assigned_staff_id: string | null };
};

beforeAll(async () => {
  officeId = await createCatalogueOffice("plan-guards");
  otherOfficeId = await createCatalogueOffice("plan-guards-other");
  u.manager = await createStaff(officeId, "guard-manager", "manager");
  u.staff = await createStaff(officeId, "guard-staff", "staff");
  u.limited = await createStaff(officeId, "guard-limited", "limited");
  u.limited2 = await createStaff(officeId, "guard-limited2", "limited");
  for (const k of Object.keys(u) as (keyof typeof u)[]) as[k] = await signedInClient(u[k].email);
  [gst, tds, it_] = await Promise.all(["GST", "TDS/TCS", "Income Tax"].map((g) => groupId(officeId, g)));
});

afterAll(async () => {
  await retireStaff(Object.values(u).filter(Boolean).map((x) => x.id));
});

describe("a paused group stays paused for Staff (AC-20, S2)", () => {
  let clientId: string;
  beforeAll(async () => {
    clientId = await newClient("Paused group client", u.staff.id, [gst]);
    const g = await groupRow(clientId, gst);
    const { error } = await as.manager.from("client_group").update({ state: "paused", remark: "client abroad" }).eq("id", g.id);
    if (error) throw error;
  });

  it("staff cannot switch off a paused group (switching back on would resume it)", async () => {
    const { error } = await as.staff.rpc("disable_client_group", { p_client_id: clientId, p_doc_group_id: gst });
    expect(error?.message ?? "").toMatch(/ROLE_REQUIRED/);
    expect((await groupRow(clientId, gst)).state).toBe("paused");
  });

  it("a manager can switch it off; re-enabling is then an ordinary enable", async () => {
    const off = await as.manager.rpc("disable_client_group", { p_client_id: clientId, p_doc_group_id: gst });
    expect(off.error).toBeNull();
    expect((await groupRow(clientId, gst)).state).toBe("removed");
    const on = await as.staff.rpc("enable_client_group", { p_client_id: clientId, p_doc_group_id: gst });
    expect(on.error).toBeNull();
    expect((await groupRow(clientId, gst)).state).toBe("active");
  });

  it("staff can still switch off an active group", async () => {
    const other = await newClient("Active group client", u.staff.id, [gst]);
    const { error } = await as.staff.rpc("disable_client_group", { p_client_id: other, p_doc_group_id: gst });
    expect(error).toBeNull();
  });
});

describe("changing the incharge moves the groups that followed the old incharge (AC-10, AC-12)", () => {
  let clientId: string;
  beforeAll(async () => {
    // Limited user L is incharge; GST and TDS follow L; Income Tax is deliberately assigned to Staff.
    clientId = await newClient("Incharge change client", u.limited.id, [gst, tds, it_]);
    const itRow = await groupRow(clientId, it_);
    const { error } = await as.manager.from("client_group").update({ assigned_staff_id: u.staff.id }).eq("id", itRow.id);
    if (error) throw error;
    expect((await as.limited.from("client").select("id").eq("id", clientId)).data).toHaveLength(1);
  });

  it("via update_client: groups assigned to the old incharge move to the new one; others stay", async () => {
    const { error } = await as.manager.rpc("update_client", {
      p_client_id: clientId, p: { name: "Incharge change client", client_type: "individual", incharge_id: u.manager.id, registrations: [] },
    });
    expect(error).toBeNull();
    expect((await groupRow(clientId, gst)).assigned_staff_id).toBe(u.manager.id);
    expect((await groupRow(clientId, tds)).assigned_staff_id).toBe(u.manager.id);
    expect((await groupRow(clientId, it_)).assigned_staff_id).toBe(u.staff.id);
  });

  it("the Limited ex-incharge no longer sees the client or its plan (RLS returns 0 rows)", async () => {
    expect((await as.limited.from("client").select("id").eq("id", clientId)).data).toEqual([]);
    expect((await as.limited.from("client_group").select("id").eq("client_id", clientId)).data).toEqual([]);
    expect((await as.limited.from("client_doc_type").select("id").eq("client_id", clientId)).data).toEqual([]);
  });

  it("a direct incharge update (not via update_client) is covered too", async () => {
    const other = await newClient("Direct incharge client", u.limited2.id, [gst]);
    const { error } = await as.manager.from("client").update({ incharge_id: u.staff.id }).eq("id", other);
    expect(error).toBeNull();
    expect((await groupRow(other, gst)).assigned_staff_id).toBe(u.staff.id);
    expect((await as.limited2.from("client").select("id").eq("id", other)).data).toEqual([]);
  });

  it("logs one activity row with IDs and a count only", async () => {
    const { data } = await adminClient().from("activity").select("action, data")
      .eq("office_id", officeId).eq("action", "client_group.reassigned").eq("data->>client_id", clientId);
    expect(data).toHaveLength(1);
    expect(data![0].data).toEqual({ client_id: clientId, from_staff_id: u.limited.id, to_staff_id: u.manager.id, groups: 2 });
  });
});

describe("plan rows can't point at another office's period (tenant isolation)", () => {
  it("start_period_id from another office is rejected", async () => {
    const clientId = await newClient("Period guard client", u.staff.id, [gst]);
    const { data: row } = await adminClient().from("client_doc_type").select("id").eq("client_id", clientId).limit(1).single();
    const { data: foreign } = await adminClient().from("period").select("id").eq("office_id", otherOfficeId).eq("kind", "month").limit(1).single();
    const { error } = await as.staff.from("client_doc_type").update({ start_period_id: foreign!.id }).eq("id", row!.id);
    expect(error?.message ?? "").toMatch(/PERIOD_OFFICE/);
  });
});
