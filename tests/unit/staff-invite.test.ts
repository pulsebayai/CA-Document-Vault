import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Map([["host", "vault.example.in"], ["x-forwarded-proto", "https"]]) }));
vi.mock("@/lib/activity", () => ({ logActivity: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/staff", () => ({
  requireAdmin: async () => ({ id: "admin-b", officeId: "office-b", officeName: "Firm B & Co", officeBranch: null, fullName: "B Admin", email: "admin@b.in", role: "admin" }),
}));

const existing = { row: null as null | { id: string }, platform: null as null | { id: string } }; // 19: per table
const invite = vi.fn(async () => ({ data: { user: { id: "new-user" } }, error: null }));
const createUser = vi.fn(async () => ({ data: { user: { id: "new-user" } }, error: null }));
const insert = vi.fn(async () => ({ error: null }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === "platform_admin" ? existing.platform : existing.row, error: null }) }) }),
      insert,
    }),
    auth: { admin: { inviteUserByEmail: invite, createUser } },
  }),
}));

import { inviteStaff } from "@/lib/staff/actions";

const form = (email: string) => {
  const f = new FormData();
  f.set("fullName", "New Person"); f.set("email", email); f.set("role", "staff");
  return f;
};

// Feature 17 (spec AC-12, AC-13).
describe("inviteStaff across firms", () => {
  beforeEach(() => { existing.row = null; existing.platform = null; invite.mockClear(); createUser.mockClear(); insert.mockClear(); });

  it("19 AC-1: a super admin's email gets the same neutral refusal, before any invite (a super admin is never staff)", async () => {
    existing.platform = { id: "super-admin" };
    const r = await inviteStaff(null, form("ops@pulsebay.com"));
    expect(r).toEqual({ ok: false, error: "This email can't be invited. Use a different address." });
    expect(invite).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
  });

  it("an email already used anywhere gets a neutral refusal that names no firm and no account (AC-12)", async () => {
    existing.row = { id: "someone-at-firm-a" };
    const r = await inviteStaff(null, form("person@firm-a.in"));
    expect(r).toEqual({ ok: false, error: "This email can't be invited. Use a different address." });
    expect(invite).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("the invite email carries the firm's name for the template (AC-13)", async () => {
    const r = await inviteStaff(null, form("new@person.in"));
    expect(r).toMatchObject({ ok: true });
    expect(invite).toHaveBeenCalledWith("new@person.in", { redirectTo: "https://vault.example.in/auth/callback", data: { firm: "Firm B & Co" } });
  });

  it(".test addresses still get an account without any email (unchanged)", async () => {
    await inviteStaff(null, form("fixture@example.test"));
    expect(invite).not.toHaveBeenCalled();
    expect(createUser).toHaveBeenCalledWith({ email: "fixture@example.test", email_confirm: true });
  });
});
