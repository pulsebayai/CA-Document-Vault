import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { DENIED, createCatalogueOffice, groupId } from "../support/catalogue";
import { testGstin, testPan, testTan } from "../support/test-data";

// Feature 02 step 8 — add / edit / archive clients through create_client / update_client
// (spec AC-8, AC-10, AC-11, AC-23). Both functions are SECURITY INVOKER: RLS and triggers apply.

let officeId: string;
let gst: string;
const u = {} as Record<"manager" | "staff" | "limited", { id: string; email: string }>;
const as = {} as Record<keyof typeof u, SupabaseClient>;

const activityFor = async (clientId: string) => {
  const { data, error } = await adminClient().from("activity").select("action, data").eq("entity_id", clientId).order("id");
  if (error) throw error;
  return data!;
};

beforeAll(async () => {
  officeId = await createCatalogueOffice("client-edit");
  u.manager = await createStaff(officeId, "edit-manager", "manager");
  u.staff = await createStaff(officeId, "edit-staff", "staff");
  u.limited = await createStaff(officeId, "edit-limited", "limited");
  for (const k of Object.keys(u) as (keyof typeof u)[]) as[k] = await signedInClient(u[k].email);
  gst = await groupId(officeId, "GST");
});
afterAll(async () => { await retireStaff(Object.values(u).filter(Boolean).map((x) => x.id)); });

describe("create_client (AC-8, AC-23)", () => {
  it("creates client, registrations and groups in one call, assigns the code, logs field names only", async () => {
    const pan = testPan("P", 8101);
    const { data, error } = await as.staff.rpc("create_client", { p: {
      name: "Create Co", client_type: "proprietorship", pan, email: "owner@example.test", mobile: "9876543210", incharge_id: u.staff.id,
      registrations: [{ kind: "gstin", number: testGstin(pan, "33") }, { kind: "tan", number: testTan(8101) }], group_ids: [gst],
    } });
    expect(error).toBeNull();
    expect(data.code).toMatch(/^C\d{4}$/);
    const id = data.id as string;
    const { data: regs } = await as.staff.from("client_registration").select("kind, state_code, active").eq("client_id", id).order("kind");
    expect(regs).toEqual([{ kind: "gstin", state_code: "33", active: true }, { kind: "tan", state_code: null, active: true }]);
    const { data: plan } = await as.staff.from("client_doc_type").select("id").eq("client_id", id);
    expect(plan!.length).toBeGreaterThan(0);
    const log = await activityFor(id);
    expect(log.map((l) => l.action)).toEqual(["client.created"]);
    expect(log[0].data).toMatchObject({ fields: ["email", "mobile", "pan"], registrations: 2, group_ids: [gst] });
    expect(JSON.stringify(log)).not.toMatch(new RegExp(`${pan}|owner@|9876543210`));
  });

  it("is all-or-nothing: a GSTIN already used elsewhere rolls back the client and its code", async () => {
    const pan = testPan("P", 8102);
    const first = await as.staff.rpc("create_client", { p: { name: "Holder", client_type: "individual", pan, incharge_id: u.staff.id,
      registrations: [{ kind: "gstin", number: testGstin(pan, "29") }] } });
    expect(first.error).toBeNull();
    const clash = await as.staff.rpc("create_client", { p: { name: "Clash Co", client_type: "individual", incharge_id: u.staff.id,
      registrations: [{ kind: "gstin", number: testGstin(pan, "29") }] } });
    expect(clash.error?.message ?? "").toMatch(/duplicate key/);
    const { data: none } = await as.staff.from("client").select("id").eq("name", "Clash Co");
    expect(none).toEqual([]);
    const next = await as.staff.rpc("create_client", { p: { name: "Next Co", client_type: "individual", incharge_id: u.staff.id } });
    const n = (c: string) => Number(c.slice(1));
    expect(n(next.data.code)).toBe(n(first.data.code) + 1); // the failed call used no code
  });

  it("limited users cannot add clients", async () => {
    const { error } = await as.limited.rpc("create_client", { p: { name: "Nope", client_type: "individual", incharge_id: u.limited.id } });
    expect(error?.message ?? "").toMatch(DENIED);
  });
});

describe("update_client (AC-10, AC-23)", () => {
  let id: string;
  const pan = testPan("F", 8103);
  const base = () => ({ name: "Edit Co", client_type: "partnership", pan, registrations: [{ kind: "gstin", number: testGstin(pan, "33") }] });

  beforeAll(async () => {
    const { data, error } = await as.staff.rpc("create_client", { p: { ...base(), incharge_id: u.staff.id } });
    if (error) throw error;
    id = data.id;
  });

  it("staff edit details; one activity row lists changed field names only", async () => {
    const { error } = await as.staff.rpc("update_client", { p_client_id: id, p: { ...base(), name: "Edit Co Renamed", email: "a@example.test" } });
    expect(error).toBeNull();
    const log = await activityFor(id);
    expect(log.at(-1)).toMatchObject({ action: "client.updated", data: { fields: ["name", "email"], registrations_added: 0, registrations_removed: 0 } });
    expect(JSON.stringify(log)).not.toMatch(/a@example/);
  });

  it("incharge changes are Admin/Manager only (AC-10)", async () => {
    const byStaff = await as.staff.rpc("update_client", { p_client_id: id, p: { ...base(), name: "Edit Co Renamed", incharge_id: u.manager.id } });
    expect(byStaff.error?.message ?? "").toMatch(/ROLE_REQUIRED/);
    const byMgr = await as.manager.rpc("update_client", { p_client_id: id, p: { ...base(), name: "Edit Co Renamed", incharge_id: u.manager.id } });
    expect(byMgr.error).toBeNull();
    expect((await as.staff.from("client").select("incharge_id").eq("id", id).single()).data?.incharge_id).toBe(u.manager.id);
  });

  it("removing a registration deactivates it; adding it back reactivates the same row", async () => {
    const without = await as.staff.rpc("update_client", { p_client_id: id, p: { ...base(), name: "Edit Co Renamed", registrations: [] } });
    expect(without.error).toBeNull();
    const regs1 = (await as.staff.from("client_registration").select("id, active").eq("client_id", id)).data!;
    expect(regs1).toHaveLength(1);
    expect(regs1[0].active).toBe(false);
    const back = await as.staff.rpc("update_client", { p_client_id: id, p: { ...base(), name: "Edit Co Renamed" } });
    expect(back.error).toBeNull();
    const regs2 = (await as.staff.from("client_registration").select("id, active").eq("client_id", id)).data!;
    expect(regs2).toEqual([{ id: regs1[0].id, active: true }]);
  });

  it("limited users cannot edit", async () => {
    const { error } = await as.limited.rpc("update_client", { p_client_id: id, p: base() });
    expect(error?.message ?? "").toMatch(DENIED);
  });
});

describe("archive with an optional reason (AC-11)", () => {
  let id: string;
  beforeAll(async () => {
    const { data, error } = await as.staff.rpc("create_client", { p: { name: "Archive Me", client_type: "individual", incharge_id: u.staff.id } });
    if (error) throw error;
    id = data.id;
  });

  it("staff cannot set the reason or archive; manager archives with a reason", async () => {
    const s = await as.staff.from("client").update({ archive_reason: "left the firm" }).eq("id", id);
    expect(s.error?.message ?? "").toMatch(/ROLE_REQUIRED|permission denied/);
    const m = await as.manager.from("client").update({ archived_at: new Date().toISOString(), archive_reason: "left the firm" }).eq("id", id).select("archived_by, archive_reason").single();
    expect(m.data).toEqual({ archived_by: u.manager.id, archive_reason: "left the firm" });
  });

  it("an archived client cannot be edited until unarchived; unarchiving clears the reason", async () => {
    const edit = await as.staff.rpc("update_client", { p_client_id: id, p: { name: "Archive Me 2", client_type: "individual" } });
    expect(edit.error?.message ?? "").toMatch(/ARCHIVED/);
    const un = await as.manager.from("client").update({ archived_at: null }).eq("id", id).select("archived_by, archive_reason").single();
    expect(un.data).toEqual({ archived_by: null, archive_reason: null });
  });
});
