import { beforeEach, describe, expect, it, vi } from "vitest";

// Feature 19 (plan step 6): the Platform area's server actions and the one service-role module (invite.ts), with the
// database and Supabase's admin API mocked. The database rules themselves are proven in tests/rls/platform*.test.ts.

const h = vi.hoisted(() => ({
  rpc: vi.fn(), whoami: { id: "sa1", full_name: "Ops", email: "ops@pulsebay.com", test: false } as Record<string, unknown> | null,
  admin: { staff: null as unknown, platform: null as unknown, invite: vi.fn(), create: vi.fn(), del: vi.fn(), audit: vi.fn() },
  revalidate: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => h.revalidate(...a) }));
vi.mock("next/headers", () => ({ headers: async () => new Map([["host", "vault.example.in"], ["x-forwarded-proto", "https"]]) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); },
  notFound: () => { throw new Error("NOT_FOUND"); },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "sa1" } } }) },
    rpc: async (fn: string, args: unknown) => {
      if (fn === "platform_whoami") return h.whoami ? { data: h.whoami, error: null } : { data: null, error: { message: "NOT_PLATFORM_ADMIN" } };
      return h.rpc(fn, args);
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === "staff_user" ? h.admin.staff : h.admin.platform, error: null }) }) }),
      insert: async (row: unknown) => { h.admin.audit(table, row); return { error: null }; },
    }),
    auth: { admin: { inviteUserByEmail: h.admin.invite, createUser: h.admin.create, deleteUser: h.admin.del } },
  }),
}));

const OFFICE = "0b8c5f8e-1d2a-4c3b-9e4f-5a6b7c8d9e0f";
const ACCESS = "1b8c5f8e-1d2a-4c3b-9e4f-5a6b7c8d9e0f";
const form = (f: Record<string, string>) => { const d = new FormData(); for (const [k, v] of Object.entries(f)) d.set(k, v); return d; };
const caught = async (p: Promise<unknown>) => { try { return await p; } catch (e) { return (e as Error).message; } };

beforeEach(() => {
  vi.resetModules();
  h.rpc.mockReset(); h.revalidate.mockReset();
  h.whoami = { id: "sa1", full_name: "Ops", email: "ops@pulsebay.com", test: false };
  h.admin.staff = null; h.admin.platform = null;
  for (const f of [h.admin.invite, h.admin.create, h.admin.del, h.admin.audit]) f.mockReset();
  h.admin.invite.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
  h.admin.create.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
  h.admin.del.mockResolvedValue({ error: null });
  h.rpc.mockResolvedValue({ data: null, error: null });
});

describe("createFirm", () => {
  const valid = { name: " Sharma & Co ", branch: "Chennai", adminName: "Priya", adminEmail: "Priya@Sharma.in" };

  it("creates the firm, invites the first Admin by email (firm name for the template), records them and lands on the firm", async () => {
    h.rpc.mockImplementation(async (fn: string) => (fn === "platform_create_firm" ? { data: { office_id: OFFICE, result: "created" }, error: null } : { data: null, error: null }));
    const { createFirm } = await import("@/lib/platform/actions");
    expect(await caught(createFirm(null, form(valid)))).toBe(`REDIRECT:/platform/firms/${OFFICE}?created=1`);
    expect(h.rpc).toHaveBeenCalledWith("platform_create_firm", { p: { name: "Sharma & Co", branch: "Chennai" } });
    expect(h.admin.invite).toHaveBeenCalledWith("priya@sharma.in", { redirectTo: "https://vault.example.in/auth/callback", data: { firm: "Sharma & Co" } });
    expect(h.rpc).toHaveBeenCalledWith("platform_record_first_admin", { p_office: OFFICE, p_user: "u1", p_name: "Priya", p_email: "priya@sharma.in" });
  });

  it("field errors come back without any call", async () => {
    const { createFirm } = await import("@/lib/platform/actions");
    const r = await createFirm(null, form({ name: "", branch: "", adminName: "", adminEmail: "nope" }));
    expect(r).toMatchObject({ ok: false, fieldErrors: { name: expect.any(String), adminName: expect.any(String), adminEmail: expect.any(String) } });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("a test super admin invites .test addresses only, and a real one real addresses only", async () => {
    const { createFirm } = await import("@/lib/platform/actions");
    expect(await createFirm(null, form(valid))).not.toMatchObject({ fieldErrors: { adminEmail: expect.any(String) } }); // real + real: goes on
    vi.resetModules(); h.rpc.mockClear();
    h.whoami = { ...h.whoami!, test: true };
    const again = await import("@/lib/platform/actions");
    expect(await again.createFirm(null, form(valid))).toMatchObject({ ok: false, fieldErrors: { adminEmail: /\.test addresses only/ } });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("a failed invite still lands on the new firm, which offers the invite again", async () => {
    h.rpc.mockImplementation(async (fn: string) => (fn === "platform_create_firm" ? { data: { office_id: OFFICE }, error: null } : { data: null, error: null }));
    h.admin.invite.mockResolvedValue({ data: { user: null }, error: { code: "over_email_send_rate_limit", status: 429 } });
    const { createFirm } = await import("@/lib/platform/actions");
    expect(await caught(createFirm(null, form(valid)))).toBe(`REDIRECT:/platform/firms/${OFFICE}?invite=failed`);
    expect(h.rpc).not.toHaveBeenCalledWith("platform_record_first_admin", expect.anything());
  });

  it("a staff action can't run it: the Platform guard refuses before any write (Not Found)", async () => {
    h.whoami = null;
    const { createFirm } = await import("@/lib/platform/actions");
    expect(await caught(createFirm(null, form(valid)))).toBe("NOT_FOUND");
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("inviteFirstAdmin (service role, after the database confirms the caller)", () => {
  const p = { officeId: OFFICE, firmName: "Sharma & Co", fullName: "Priya", email: "priya@sharma.in" };

  it("never touches the admin API unless platform_whoami confirms an active super admin", async () => {
    h.whoami = null;
    const { inviteFirstAdmin } = await import("@/lib/platform/invite");
    expect(await inviteFirstAdmin(p)).toEqual({ ok: false, error: "Not allowed." });
    expect(h.admin.invite).not.toHaveBeenCalled();
    expect(h.admin.create).not.toHaveBeenCalled();
  });

  it("an email that is staff anywhere or a super admin is refused with 17's neutral message, before any invite", async () => {
    h.admin.staff = { id: "s" };
    const { inviteFirstAdmin } = await import("@/lib/platform/invite");
    expect(await inviteFirstAdmin(p)).toEqual({ ok: false, error: "This email can't be invited. Use a different address." });
    h.admin.staff = null; h.admin.platform = { id: "x" };
    expect(await inviteFirstAdmin(p)).toEqual({ ok: false, error: "This email can't be invited. Use a different address." });
    expect(h.admin.invite).not.toHaveBeenCalled();
  });

  it("a .test address gets the account without an email", async () => {
    h.whoami = { ...h.whoami!, test: true };
    const { inviteFirstAdmin } = await import("@/lib/platform/invite");
    expect(await inviteFirstAdmin({ ...p, email: "first@example.test" })).toEqual({ ok: true });
    expect(h.admin.create).toHaveBeenCalledWith({ email: "first@example.test", email_confirm: true });
    expect(h.admin.invite).not.toHaveBeenCalled();
  });

  it("a refused record removes the account it created (a retry starts clean) and says why in plain words", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "23505", message: "ALREADY_SET_UP: this firm already has staff" } });
    const { inviteFirstAdmin } = await import("@/lib/platform/invite");
    expect(await inviteFirstAdmin(p)).toEqual({ ok: false, error: "This firm already has staff." });
    expect(h.admin.del).toHaveBeenCalledWith("u1");
  });

  it("resend: emails the waiting Admin again and records it in the platform audit (IDs only)", async () => {
    h.rpc.mockResolvedValue({ data: { staff_id: "s1", email: "priya@sharma.in", full_name: "Priya" }, error: null });
    const { resendFirstAdminInvite } = await import("@/lib/platform/invite");
    expect(await resendFirstAdminInvite({ officeId: OFFICE, firmName: "Sharma & Co" })).toEqual({ ok: true });
    expect(h.admin.invite).toHaveBeenCalledWith("priya@sharma.in", expect.objectContaining({ data: { firm: "Sharma & Co" } }));
    expect(h.admin.audit).toHaveBeenCalledWith("platform_audit", { admin_id: "sa1", action: "staff.reinvited", office_id: OFFICE, detail: { staff_id: "s1" } });
  });
});

describe("suspend, reactivate, open and close access", () => {
  it("suspend needs a 10–500 character reason, then calls the database with it", async () => {
    const { suspendFirm } = await import("@/lib/platform/actions");
    expect(await suspendFirm(OFFICE, null, form({ reason: "late" }))).toMatchObject({ ok: false, fieldErrors: { reason: expect.stringMatching(/at least 10/) } });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(await suspendFirm(OFFICE, null, form({ reason: "  Unpaid since October  " }))).toMatchObject({ ok: true });
    expect(h.rpc).toHaveBeenCalledWith("platform_suspend_firm", { p_office: OFFICE, p_reason: "Unpaid since October" });
  });

  it("database refusals become plain messages; no codes or details reach the browser", async () => {
    const { reactivateFirm, suspendFirm } = await import("@/lib/platform/actions");
    h.rpc.mockResolvedValue({ data: null, error: { message: "NOT_SUSPENDED" } });
    expect(await reactivateFirm(OFFICE)).toEqual({ ok: false, error: "This firm isn't suspended." });
    h.rpc.mockResolvedValue({ data: null, error: { message: "permission denied for table office (42501)" } });
    expect(await suspendFirm(OFFICE, null, form({ reason: "Unpaid since October" }))).toEqual({ ok: false, error: "Something went wrong. Please try again." });
  });

  it("open and close access pass the firm and the window; a malformed ID never reaches the database", async () => {
    const { closeAccess, openAccess } = await import("@/lib/platform/actions");
    expect(await openAccess(OFFICE, null, form({ reason: "Ticket 42: missing GST files" }))).toMatchObject({ ok: true });
    expect(h.rpc).toHaveBeenCalledWith("platform_open_access", { p_office: OFFICE, p_reason: "Ticket 42: missing GST files" });
    expect(await closeAccess(OFFICE, ACCESS)).toMatchObject({ ok: true });
    expect(h.rpc).toHaveBeenCalledWith("platform_close_access", { p_access: ACCESS });
    h.rpc.mockClear();
    expect(await closeAccess(OFFICE, "x' or 1=1")).toEqual({ ok: false, error: "Invalid request." });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("client search posts the text (never a URL) and trims it; a closed window comes back as no_access", async () => {
    const { searchClients } = await import("@/lib/platform/actions");
    h.rpc.mockResolvedValue({ data: { total: 1, rows: [] }, error: null });
    expect(await searchClients(OFFICE, "  Sharma  ", 2)).toEqual({ ok: true, data: { total: 1, rows: [] } });
    expect(h.rpc).toHaveBeenCalledWith("platform_clients", { p_office: OFFICE, p_query: "Sharma", p_page: 2 });
    h.rpc.mockResolvedValue({ data: null, error: { message: "NO_ACCESS: open read access to this firm first" } });
    expect(await searchClients(OFFICE, "", 1)).toEqual({ ok: false, reason: "no_access" });
  });
});
