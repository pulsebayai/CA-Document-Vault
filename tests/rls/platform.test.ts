import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { insertClient } from "../support/catalogue";
import { createDocumentOffice, mustCreateDocument } from "../support/documents";
import { testOfficeName, testPan, uniqueTestEmail } from "../support/test-data";
import { PLATFORM_FUNCTIONS, createPlatformAdmin, signedInPlatformAdmin } from "../support/platform";

// Feature 19 — super admin console at the database (spec AC-1, AC-4–AC-6, AC-8–AC-12). Written failing-first (plan
// step 1): red until migrations A + B exist. Two test firms (A, B); a `.test` super admin, which the database lets
// touch test offices only (plan D1), and a deactivated one.

type Res = { data: unknown; error: { message: string } | null };
const svc = () => adminClient();
const marker = `XP${randomBytes(3).toString("hex")}`;
let A: string, B: string;
let adminA: { id: string; email: string }, staffA: { id: string; email: string }, adminB: { id: string; email: string };
let asAdminA: SupabaseClient, asAdminB: SupabaseClient;
let sa: { id: string; email: string; as: SupabaseClient };
let saOff: SupabaseClient;
let clientA: string, clientB: string, docA: string;
const panA = testPan("P", 1901);

const rpc = (who: SupabaseClient, fn: string, args: Record<string, unknown>) => who.rpc(fn, args) as unknown as Promise<Res>;
async function must<T>(p: Promise<Res>): Promise<T> {
  const r = await p;
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}
const audit = async (action: string, office: string) =>
  (await svc().from("platform_audit").select("id, admin_id, action, office_id, detail").eq("action", action).eq("office_id", office)
    .order("id", { ascending: false }).limit(5)).data ?? [];
const activityOf = async (office: string, action: string) =>
  (await svc().from("activity").select("actor_id, data, entity_id").eq("office_id", office).eq("action", action)
    .order("id", { ascending: false }).limit(5)).data ?? [];

beforeAll(async () => {
  A = await createDocumentOffice("platform-a");
  B = await createDocumentOffice("platform-b");
  adminA = await createStaff(A, "platform-a-admin", "admin");
  staffA = await createStaff(A, "platform-a-staff", "staff");
  adminB = await createStaff(B, "platform-b-admin", "admin");
  asAdminA = await signedInClient(adminA.email);
  asAdminB = await signedInClient(adminB.email);
  const ca = await insertClient(asAdminA, A, { name: `${marker} A client`, client_type: "individual", incharge_id: staffA.id, pan: panA, mobile: "9876500077" });
  if (ca.error) throw ca.error;
  clientA = ca.data!.id as string;
  const cb = await insertClient(asAdminB, B, { name: `${marker} B client`, client_type: "individual", incharge_id: adminB.id });
  if (cb.error) throw cb.error;
  clientB = cb.data!.id as string;
  docA = (await mustCreateDocument(asAdminA, { client_id: clientA, received_on: "2026-05-02", remark: `${marker} remark` })).id;
  sa = await signedInPlatformAdmin("platform-sa");
  saOff = await signedInClient((await createPlatformAdmin("platform-sa-off", "active")).email);
  await createPlatformAdmin("platform-sa-off", "deactivated"); // signed in while active, then switched off
}, 180_000);

afterAll(async () => {
  await svc().from("platform_access").update({ closed_at: new Date().toISOString() }).eq("admin_id", sa?.id).is("closed_at", null);
  await retireStaff([adminA?.id, staffA?.id, adminB?.id].filter(Boolean) as string[]);
});

describe("identity (AC-1, AC-4)", () => {
  it("an email is either staff or a super admin, never both", async () => {
    const asPlatform = await svc().from("platform_admin").insert({ id: adminA.id, email: adminA.email, full_name: "Clash", status: "active" });
    expect(asPlatform.error?.message ?? "inserted").toMatch(/EMAIL_IN_USE/);
    const { data: u } = await svc().auth.admin.createUser({ email: uniqueTestEmail("platform-clash"), email_confirm: true });
    const asStaff = await svc().from("staff_user").insert({ id: u!.user!.id, office_id: A, full_name: "Clash", email: sa.email, role: "staff", status: "invited" });
    expect(asStaff.error?.message ?? "inserted").toMatch(/EMAIL_IN_USE|duplicate/);
  });

  it("whoami confirms an active super admin", async () => {
    expect(await must<{ id: string }>(rpc(sa.as, "platform_whoami", {}))).toMatchObject({ id: sa.id });
  });

  it("every platform function refuses firm staff (Admin included) and a deactivated super admin, with no audit row", async () => {
    const before = (await svc().from("platform_audit").select("id", { count: "exact", head: true })).count ?? 0;
    const open: string[] = [];
    for (const [fn, args] of Object.entries(PLATFORM_FUNCTIONS)) {
      for (const [who, client] of [["firm admin", asAdminA], ["deactivated super admin", saOff]] as const) {
        const r = await rpc(client, fn, args(A, clientA));
        if (!r.error || !/NOT_PLATFORM_ADMIN/.test(r.error.message)) open.push(`${who}: ${fn} (${r.error?.message.slice(0, 50) ?? "ran"})`);
      }
    }
    expect(open).toEqual([]);
    expect((await svc().from("platform_audit").select("id", { count: "exact", head: true })).count ?? 0).toBe(before);
  }, 120_000);

  it("a super admin sees nothing of any firm through the ordinary tables (not staff anywhere)", async () => {
    for (const t of ["client", "document", "staff_user", "activity"]) {
      const r = await sa.as.from(t).select("id").limit(1);
      expect(r.error ?? r.data).toSatisfy((x: unknown) => !Array.isArray(x) || x.length === 0);
    }
  });
});

describe("firms (AC-5, AC-6)", () => {
  it("lists test firms (for a .test super admin) with counts and no client names", async () => {
    const firms = await must<Array<Record<string, unknown>>>(rpc(sa.as, "platform_firms", {}));
    const a = firms.find((f) => f.id === A)!;
    expect(a).toMatchObject({ name: testOfficeName("platform-a"), status: "active" });
    expect(a).toHaveProperty("staff_active");
    expect(a).toHaveProperty("clients");
    expect(a).toHaveProperty("documents");
    expect(a).toHaveProperty("storage_mb");
    expect(a).toHaveProperty("last_activity_at");
    expect(JSON.stringify(firms)).not.toContain(marker);
    // a .test super admin never sees a real firm
    const { data: real } = await svc().from("office").select("id").eq("is_test", false).limit(1);
    if (real?.length) expect(firms.map((f) => f.id)).not.toContain(real[0].id);
  });

  it("creates a seeded firm and records its first Admin as invited; a second Admin or a super admin's email is refused", async () => {
    const name = testOfficeName(`platform-new-${randomBytes(3).toString("hex")}`);
    const made = await must<{ office_id: string }>(rpc(sa.as, "platform_create_firm", { p: { name, branch: "Pondicherry" } }));
    const office = made.office_id;
    expect((await svc().from("office").select("is_test, name").eq("id", office).single()).data).toMatchObject({ is_test: true, name });
    expect((await svc().from("doc_group").select("id", { count: "exact", head: true }).eq("office_id", office)).count).toBeGreaterThan(0);
    expect(await audit("firm.created", office)).toHaveLength(1);
    const email = uniqueTestEmail("platform-first-admin");
    const { data: u } = await svc().auth.admin.createUser({ email, email_confirm: false });
    await must(rpc(sa.as, "platform_record_first_admin", { p_office: office, p_user: u!.user!.id, p_name: "First Admin", p_email: email }));
    expect((await svc().from("staff_user").select("office_id, role, status").eq("id", u!.user!.id).single()).data)
      .toEqual({ office_id: office, role: "admin", status: "invited" });
    expect(await audit("staff.invited", office)).toHaveLength(1);
    const again = await rpc(sa.as, "platform_record_first_admin", { p_office: office, p_user: u!.user!.id, p_name: "X", p_email: email });
    expect(again.error?.message).toMatch(/ALREADY_SET_UP/);
    const clash = await rpc(sa.as, "platform_record_first_admin", { p_office: A, p_user: sa.id, p_name: "X", p_email: sa.email });
    expect(clash.error?.message).toMatch(/ALREADY_SET_UP|EMAIL_IN_USE/);
  });

  it("a .test super admin can't create a real firm, and can't act on one", async () => {
    const { data: real } = await svc().from("office").select("id").eq("is_test", false).limit(1);
    if (!real?.length) return;
    for (const fn of ["platform_open_access", "platform_suspend_firm"]) {
      const r = await rpc(sa.as, fn, { p_office: real[0].id, p_reason: "must be refused: real firm" });
      expect(r.error?.message, fn).toMatch(/NOT_FOUND/);
    }
  });
});

describe("support access (AC-8 – AC-11)", () => {
  let access: string;

  it("needs a reason of 10–500 characters", async () => {
    expect((await rpc(sa.as, "platform_open_access", { p_office: A, p_reason: "short" })).error?.message).toMatch(/REASON_INVALID/);
  });

  it("opens a 60-minute window: the firm's activity shows it (IDs only) and each active firm Admin gets one bell", async () => {
    access = await must<string>(rpc(sa.as, "platform_open_access", { p_office: A, p_reason: `Ticket 1234 ${marker} support` }));
    const row = (await svc().from("platform_access").select("office_id, admin_id, reason, opened_at, expires_at").eq("id", access).single()).data!;
    expect(row).toMatchObject({ office_id: A, admin_id: sa.id });
    expect(new Date(row.expires_at).getTime() - new Date(row.opened_at).getTime()).toBe(60 * 60 * 1000);
    const act = await activityOf(A, "platform.access_opened");
    expect(act[0]).toMatchObject({ actor_id: null, data: { access_id: access } });
    expect(JSON.stringify(act)).not.toContain(marker); // the reason never reaches activity
    const { data: bells } = await svc().from("notification").select("recipient_id, kind").eq("office_id", A).eq("kind", "platform_access");
    expect((bells ?? []).map((b) => b.recipient_id)).toContain(adminA.id);
    expect((bells ?? []).map((b) => b.recipient_id)).not.toContain(staffA.id);
    expect(await audit("access.opened", A)).not.toHaveLength(0);
  });

  it("the six views return Firm A's data, read-only, PII in full, no storage path / ciphertext / token; each read is logged twice", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["platform_clients", { p_office: A, p_query: null, p_page: 1 }],
      ["platform_client", { p_office: A, p_client: clientA }],
      ["platform_documents", { p_office: A, p_client: clientA, p_page: 1 }],
      ["platform_document", { p_office: A, p_document: docA }],
      ["platform_expected", { p_office: A, p_client: clientA, p_page: 1 }],
      ["platform_activity", { p_office: A, p_page: 1 }],
    ];
    const viewedBefore = (await activityOf(A, "platform.viewed")).length;
    for (const [fn, args] of calls) {
      const data = await must<unknown>(rpc(sa.as, fn, args));
      const text = JSON.stringify(data);
      expect(text, fn).not.toMatch(/storage_path|password_ct|token_hash/);
      if (fn === "platform_client") expect(text).toContain(panA); // Y5a: in full
      if (fn === "platform_clients") expect(text).toContain(`${marker} A client`);
      expect(text, fn).not.toContain(`${marker} B client`);
    }
    expect((await activityOf(A, "platform.viewed")).length).toBeGreaterThan(viewedBefore);
    expect((await audit("viewed", A)).length).toBeGreaterThan(0);
  });

  it("AC-13: the firm sees support access in its own Activity — the client viewed is named, and the document's own history shows the view", async () => {
    type Row = { action: string; client_name: string | null; doc_code: string | null; actor_name: string | null; data: Record<string, unknown> };
    const feed = async (who: SupabaseClient, p: Record<string, unknown>) => ((await must<{ rows: Row[] }>(rpc(who, "activity_feed", { p: { limit: 50, ...p } }))).rows);
    await must(rpc(sa.as, "platform_client", { p_office: A, p_client: clientA }));
    await must(rpc(sa.as, "platform_document", { p_office: A, p_document: docA }));
    const rows = await feed(asAdminA, {});
    expect(rows.some((r) => r.action === "platform.access_opened" && r.actor_name === null)).toBe(true);
    const views = rows.filter((r) => r.action === "platform.viewed");
    expect(views.find((r) => r.data.view === "client")?.client_name).toBe(`${marker} A client`);
    expect(views.find((r) => r.data.view === "document")?.doc_code).toMatch(/^DOC-/);
    // the document's own activity (15's lookups) shows that support viewed it
    expect((await feed(asAdminA, { document_id: docA })).some((r) => r.action === "platform.viewed")).toBe(true);
    // and the client's (08's client filter)
    expect((await feed(asAdminA, { client_id: clientA })).some((r) => r.action === "platform.viewed")).toBe(true);
    // IDs and the view name only: no PII, no reason
    expect(JSON.stringify(views.map((r) => r.data))).not.toMatch(new RegExp(`${panA}|9876500077|${marker}`));
    // Firm B's Admin sees none of it
    expect((await feed(asAdminB, {})).some((r) => r.action.startsWith("platform."))).toBe(false);
  });

  it("is refused for another firm, for another firm's IDs, and once closed or expired", async () => {
    expect((await rpc(sa.as, "platform_clients", { p_office: B, p_query: null, p_page: 1 })).error?.message).toMatch(/NO_ACCESS/);
    expect((await rpc(sa.as, "platform_client", { p_office: A, p_client: clientB })).error?.message).toMatch(/NOT_FOUND/);
    await must(rpc(sa.as, "platform_close_access", { p_access: access }));
    expect((await rpc(sa.as, "platform_clients", { p_office: A, p_query: null, p_page: 1 })).error?.message).toMatch(/NO_ACCESS/);
    const second = await must<string>(rpc(sa.as, "platform_open_access", { p_office: A, p_reason: "Ticket 1235 expiry check" }));
    const past = await svc().from("platform_access") // opened_at moves back too: the table requires expires_at > opened_at
      .update({ opened_at: new Date(Date.now() - 2 * 3600_000).toISOString(), expires_at: new Date(Date.now() - 3600_000).toISOString() })
      .eq("id", second);
    expect(past.error).toBeNull();
    expect((await rpc(sa.as, "platform_clients", { p_office: A, p_query: null, p_page: 1 })).error?.message).toMatch(/NO_ACCESS/);
  });
});

describe("audit (AC-12)", () => {
  it("lists the super admin's actions and can't be changed by anyone, the service role included", async () => {
    const list = await must<{ rows: Array<{ action: string }> }>(rpc(sa.as, "platform_audit_list", { p: { office_id: A } }));
    expect(list.rows.map((r) => r.action)).toContain("access.opened");
    const { data: one } = await svc().from("platform_audit").select("id").eq("office_id", A).limit(1).single();
    expect((await svc().from("platform_audit").update({ action: "x" }).eq("id", one!.id)).error).not.toBeNull();
    expect((await svc().from("platform_audit").delete().eq("id", one!.id)).error).not.toBeNull();
    expect((await asAdminA.from("platform_audit").select("id").limit(1)).data ?? []).toEqual([]);
  });
});

// Step 10 review fixes (sdlc-reviewer I-4/I-5, security review M-1/M-2/L-2, coverage gap). Written failing-first.
describe("step 10 review fixes", () => {
  const newStafflessFirm = async () =>
    (await must<{ office_id: string }>(rpc(sa.as, "platform_create_firm", { p: { name: testOfficeName(`platform-fix-${randomBytes(3).toString("hex")}`) } }))).office_id;

  it("coverage gap: a super admin's own account can't be recorded as a firm's first Admin (a staff-less firm, so the clash check is what refuses)", async () => {
    const office = await newStafflessFirm();
    const r = await rpc(sa.as, "platform_record_first_admin", { p_office: office, p_user: sa.id, p_name: "X", p_email: sa.email });
    expect(r.error?.message).toMatch(/EMAIL_IN_USE/);
  });

  it("I-5/L-2: the waiting Admin is shown without their email; resending is a logged action that returns the address to the server", async () => {
    const office = await newStafflessFirm();
    const email = uniqueTestEmail("platform-reinvite");
    const { data: u } = await svc().auth.admin.createUser({ email, email_confirm: false });
    await must(rpc(sa.as, "platform_record_first_admin", { p_office: office, p_user: u!.user!.id, p_name: "Waiting Admin", p_email: email }));
    const target = await must<Record<string, unknown>>(rpc(sa.as, "platform_invite_target", { p_office: office }));
    expect(target).toEqual({ staff_id: u!.user!.id, full_name: "Waiting Admin" }); // no email: an unlogged read returns no PII
    const before = (await audit("staff.reinvited", office)).length;
    const begun = await must<Record<string, unknown>>(rpc(sa.as, "platform_begin_reinvite", { p_office: office }));
    expect(begun).toEqual({ staff_id: u!.user!.id, email, full_name: "Waiting Admin" });
    expect((await audit("staff.reinvited", office)).length).toBe(before + 1); // logged before the server sends anything
    // a firm whose staff have signed in has nobody waiting: nothing is sent and nothing is returned
    expect((await rpc(sa.as, "platform_begin_reinvite", { p_office: A })).error?.message).toMatch(/NOTHING_WAITING/);
    expect(await must<unknown>(rpc(sa.as, "platform_invite_target", { p_office: A }))).toBeNull();
  });

  it("I-4: a super admin's sign-in is recorded by the database as the user (no service role)", async () => {
    const before = (await svc().from("platform_audit").select("id").eq("admin_id", sa.id).eq("action", "auth.signed_in")).data?.length ?? 0;
    await must(rpc(sa.as, "platform_signed_in", { p_method: "code" }));
    const rows = (await svc().from("platform_audit").select("detail").eq("admin_id", sa.id).eq("action", "auth.signed_in").order("id", { ascending: false })).data ?? [];
    expect(rows.length).toBe(before + 1);
    expect(rows[0].detail).toEqual({ method: "code" });
    expect((await rpc(sa.as, "platform_signed_in", { p_method: "anything" })).error?.message).toMatch(/INVALID/);
    expect((await rpc(asAdminA, "platform_signed_in", { p_method: "code" })).error?.message).toMatch(/NOT_PLATFORM_ADMIN/);
  });

  it("M-1: asking PostgREST to roll back a read still leaves its log rows, or is refused", async () => {
    const access = await must<string>(rpc(sa.as, "platform_open_access", { p_office: A, p_reason: "Rollback check (security review M-1)" }));
    const viewed = async () => (await svc().from("platform_audit").select("id").eq("access_id", access).eq("action", "viewed")).data?.length ?? 0;
    const { data: s } = await sa.as.auth.getSession();
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/platform_client`, {
      method: "POST",
      headers: {
        apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, Authorization: `Bearer ${s.session!.access_token}`,
        "Content-Type": "application/json", Prefer: "tx=rollback",
      },
      body: JSON.stringify({ p_office: A, p_client: clientA }),
    });
    const body = await res.text();
    if (res.ok && body.includes(panA)) expect(await viewed()).toBe(1); // got the PII → the log row must exist
    else expect(await viewed()).toBeLessThanOrEqual(1);
    await must(rpc(sa.as, "platform_close_access", { p_access: access }));
  });

  it("M-2: a super admin whose sign-in email was changed loses platform access until the record matches again", async () => {
    const other = await createPlatformAdmin("platform-sa-email");
    const as = await signedInClient(other.email);
    expect((await rpc(as, "platform_whoami", {})).error).toBeNull(); // control
    const moved = uniqueTestEmail("platform-sa-moved");
    try {
      expect((await svc().auth.admin.updateUserById(other.id, { email: moved, email_confirm: true })).error).toBeNull();
      expect((await rpc(as, "platform_whoami", {})).error?.message).toMatch(/NOT_PLATFORM_ADMIN/);
      expect((await rpc(as, "platform_firms", {})).error?.message).toMatch(/NOT_PLATFORM_ADMIN/);
    } finally {
      await svc().auth.admin.updateUserById(other.id, { email: other.email, email_confirm: true });
    }
    expect((await rpc(as, "platform_whoami", {})).error).toBeNull();
  });
});
