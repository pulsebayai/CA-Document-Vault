import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, createTestOffice, retireStaff, signedInClient } from "../support/db";

// Spec AC-8, AC-9, AC-10, AC-11 — enforced by the database, not the UI.
let officeId: string;
let otherOfficeId: string;
const ids: string[] = [];
let admin: { id: string; email: string };
let staff: { id: string; email: string };
let asAdmin: SupabaseClient;
let asStaff: SupabaseClient;

beforeAll(async () => {
  officeId = await createTestOffice("rls");
  otherOfficeId = await createTestOffice("rls-other");
  admin = await createStaff(officeId, "rls-admin", "admin");
  staff = await createStaff(officeId, "rls-staff", "staff");
  const outsider = await createStaff(otherOfficeId, "rls-outsider", "admin");
  ids.push(admin.id, staff.id, outsider.id);
  asAdmin = await signedInClient(admin.email);
  asStaff = await signedInClient(staff.email);
});

afterAll(async () => {
  // Keep one admin active per office until the end, then retire everyone (skip if setup failed).
  await retireStaff([staff?.id, ...ids.slice(2)].filter(Boolean) as string[]);
  if (admin) await retireStaff([admin.id]);
});

describe("tenant isolation", () => {
  it("active staff see only their own office and its people", async () => {
    const { data: offices } = await asStaff.from("office").select("id");
    expect(offices?.map((o) => o.id)).toEqual([officeId]);
    const { data: people } = await asStaff.from("staff_user").select("id, office_id");
    expect(people?.every((p) => p.office_id === officeId)).toBe(true);
    expect(people?.length).toBeGreaterThanOrEqual(2); // fixture users are reused across runs
  });

  it("anonymous callers read nothing", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
    const { data } = await anon.from("staff_user").select("id");
    expect(data ?? []).toEqual([]);
  });
});

describe("role enforcement (AC-10)", () => {
  it("non-admin cannot change anyone's role", async () => {
    const { data } = await asStaff.from("staff_user").update({ role: "admin" }).eq("id", staff.id).select("id");
    expect(data ?? []).toEqual([]);
    const { data: row } = await adminClient().from("staff_user").select("role").eq("id", staff.id).single();
    expect(row?.role).toBe("staff");
  });

  it("admin can change a role in their office", async () => {
    const { data, error } = await asAdmin.from("staff_user").update({ role: "manager" }).eq("id", staff.id).select("role");
    expect(error).toBeNull();
    expect(data?.[0]?.role).toBe("manager");
    await asAdmin.from("staff_user").update({ role: "staff" }).eq("id", staff.id);
  });

  it("nobody can insert staff through the API (invites go through the server)", async () => {
    const { error } = await asAdmin.from("staff_user").insert({ id: crypto.randomUUID(), office_id: officeId, full_name: "x", email: "x@example.test", role: "staff" });
    expect(error).not.toBeNull();
  });
});

describe("last admin guard (AC-9)", () => {
  it("the only active admin cannot demote or deactivate themselves", async () => {
    const { error } = await asAdmin.from("staff_user").update({ role: "staff" }).eq("id", admin.id);
    expect(error?.message).toMatch(/LAST_ADMIN/);
    const { error: e2 } = await adminClient().from("staff_user").update({ status: "deactivated" }).eq("id", admin.id);
    expect(e2?.message).toMatch(/LAST_ADMIN/);
  });
});

describe("audit log (AC-11)", () => {
  it("staff can append their own activity but never edit or delete it", async () => {
    const { data, error } = await asStaff.from("activity")
      .insert({ office_id: officeId, actor_id: staff.id, action: "test.ping", entity_type: "test" }).select("id").single();
    expect(error).toBeNull();
    const { error: upd } = await adminClient().from("activity").update({ action: "tampered" }).eq("id", data!.id);
    expect(upd?.message).toMatch(/APPEND_ONLY/);
    const { error: del } = await adminClient().from("activity").delete().eq("id", data!.id);
    expect(del?.message).toMatch(/APPEND_ONLY/);
  });

  it("staff cannot write activity as someone else", async () => {
    const { error } = await asStaff.from("activity").insert({ office_id: officeId, actor_id: admin.id, action: "spoof", entity_type: "test" });
    expect(error).not.toBeNull();
  });
});

describe("deactivation (AC-8)", () => {
  it("a deactivated user reads nothing, even with a still-valid session", async () => {
    const temp = await createStaff(officeId, "rls-temp", "staff");
    ids.push(temp.id);
    const asTemp = await signedInClient(temp.email);
    expect((await asTemp.from("office").select("id")).data?.length).toBe(1);
    await adminClient().from("staff_user").update({ status: "deactivated" }).eq("id", temp.id);
    expect((await asTemp.from("office").select("id")).data ?? []).toEqual([]);
    expect((await asTemp.from("staff_user").select("id")).data ?? []).toEqual([]);
  });
});

describe("no hard delete", () => {
  it("staff rows cannot be deleted, even by the service role", async () => {
    const { error } = await adminClient().from("staff_user").delete().eq("id", staff.id);
    expect(error?.message).toMatch(/NO_DELETE/);
  });
});
