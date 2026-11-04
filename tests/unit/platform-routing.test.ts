import { beforeEach, describe, expect, it, vi } from "vitest";

// Feature 19 (spec AC-1, AC-3, AC-7; plan step 5): who lands where — at sign-in (finishSignIn + the login actions),
// on a staff page (requireStaff's refusal path) and on the Platform area (requirePlatformAdmin).

const h = vi.hoisted(() => ({
  admin: null as unknown, server: null as unknown, logActivity: vi.fn(), finish: null as null | ReturnType<typeof vi.fn>,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Map([["host", "vault.example.in"], ["x-forwarded-proto", "https"]]) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); },
  notFound: () => { throw new Error("NOT_FOUND"); },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.admin }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.server }));
vi.mock("@/lib/activity", () => ({ logActivity: (...a: unknown[]) => h.logActivity(...a) }));
vi.mock("@/lib/auth/lockout", () => ({ isLocked: async () => false, recordFailure: async () => ({ locked: false }), clearFailures: async () => undefined }));

type Row = Record<string, unknown> | null;
/** A service-role client whose staff_user / platform_admin lookups return the given rows; records writes. */
function adminDb({ staff = null as Row, platform = null as Row, auditError = null as null | { code: string } } = {}) {
  const writes: Array<[string, string, unknown]> = [];
  const db = {
    writes,
    from: (table: string) => {
      const chain = {
        select: () => chain, eq: () => chain,
        maybeSingle: async () => ({ data: table === "staff_user" ? staff : table === "platform_admin" ? platform : null, error: null }),
        update: (row: unknown) => { writes.push(["update", table, row]); return chain; },
        insert: async (row: unknown) => { writes.push(["insert", table, row]); return { error: table === "platform_audit" ? auditError : null }; },
        then: (ok: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(ok),
      };
      return chain;
    },
  };
  return db;
}
function userClient({ user = { id: "u1" } as Row, staffRow = null as Row, state = "none" as unknown, whoami = null as Row, claims = true } = {}) {
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: staffRow, error: null }) };
  return {
    signOut: vi.fn(async () => ({ error: null })),
    rpc: vi.fn(async (fn: string) => fn === "my_access_state" ? { data: state, error: null }
      : fn === "platform_whoami" ? (whoami ? { data: whoami, error: null } : { data: null, error: { message: "NOT_PLATFORM_ADMIN" } }) : { data: null, error: null }),
    from: () => chain,
    auth: {
      getUser: async () => ({ data: { user } }),
      getClaims: async () => ({ data: claims ? { claims: { sub: "u1" } } : null }),
      signOut: vi.fn(async () => ({ error: null })),
      signInWithOtp: vi.fn(async () => ({ error: null })),
      verifyOtp: vi.fn(async () => ({ data: { user: { id: "u1" } }, error: null })),
      exchangeCodeForSession: vi.fn(async () => ({ error: null })),
    },
  };
}
const caught = async (p: Promise<unknown>) => { try { await p; return "returned"; } catch (e) { return (e as Error).message; } };

beforeEach(() => { vi.resetModules(); h.logActivity.mockReset(); });

describe("finishSignIn: what the signed-in user is", () => {
  const finish = async (admin: ReturnType<typeof adminDb>, client = userClient()) => {
    h.admin = admin;
    const { finishSignIn } = await import("@/lib/auth/finish");
    return { state: await finishSignIn(client as never, "code"), client, admin };
  };

  it("active staff of a working firm → staff, with the sign-in audit row", async () => {
    const r = await finish(adminDb({ staff: { id: "u1", office_id: "o1", status: "active", office: { suspended_at: null } } }));
    expect(r.state).toBe("staff");
    expect(h.logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.signed_in", officeId: "o1" }));
    expect(r.client.auth.signOut).not.toHaveBeenCalled();
  });

  it("invited staff are activated on first sign-in (unchanged from 01)", async () => {
    const r = await finish(adminDb({ staff: { id: "u1", office_id: "o1", status: "invited", office: { suspended_at: null } } }));
    expect(r.state).toBe("staff");
    expect(r.admin.writes[0]).toEqual(["update", "staff_user", expect.objectContaining({ status: "active" })]);
  });

  it("staff of a suspended firm → suspended, signed out, an invite is not activated and nothing is logged", async () => {
    const r = await finish(adminDb({ staff: { id: "u1", office_id: "o1", status: "invited", office: { suspended_at: "2026-11-04T09:00:00Z" } } }));
    expect(r.state).toBe("suspended");
    expect(r.client.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(r.admin.writes).toEqual([]);
    expect(h.logActivity).not.toHaveBeenCalled();
  });

  it("deactivated staff → none, signed out (a super admin row is never consulted for a staff email)", async () => {
    const r = await finish(adminDb({ staff: { id: "u1", office_id: "o1", status: "deactivated", office: { suspended_at: null } }, platform: { id: "u1", status: "active" } }));
    expect(r.state).toBe("none");
    expect(r.client.auth.signOut).toHaveBeenCalled();
  });

  it("an active super admin → platform, with one platform audit row and no firm activity", async () => {
    const r = await finish(adminDb({ platform: { id: "u1", status: "active" } }));
    expect(r.state).toBe("platform");
    expect(r.admin.writes).toEqual([["insert", "platform_audit", { admin_id: "u1", action: "auth.signed_in", detail: { method: "code" } }]]);
    expect(h.logActivity).not.toHaveBeenCalled();
  });

  it("a super admin whose sign-in can't be recorded is signed out (fail closed)", async () => {
    const r = await finish(adminDb({ platform: { id: "u1", status: "active" }, auditError: { code: "57014" } }));
    expect(r.state).toBe("none");
    expect(r.client.auth.signOut).toHaveBeenCalled();
  });

  it("a deactivated super admin, or nobody we know → none, signed out", async () => {
    expect((await finish(adminDb({ platform: { id: "u1", status: "deactivated" } }))).state).toBe("none");
    expect((await finish(adminDb())).state).toBe("none");
    expect((await finish(adminDb(), userClient({ user: null }))).state).toBe("none");
  });
});

describe("login actions: where sign-in lands", () => {
  const form = (fields: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v); return f; };
  const withFinish = async (state: string) => {
    vi.doMock("@/lib/auth/finish", () => ({ finishSignIn: async () => state }));
    h.admin = adminDb();
    h.server = userClient();
    return import("@/lib/auth/actions");
  };

  it.each([["staff", "REDIRECT:/today"], ["platform", "REDIRECT:/platform"]])("code sign-in as %s → %s", async (state, to) => {
    const { loginStep } = await withFinish(state);
    expect(await caught(loginStep({ step: "code", email: "a@b.in", message: "" }, form({ intent: "verify", code: "123456" })))).toBe(to);
  });

  it("code sign-in for a suspended firm's staff or a removed user shows the notice in the form", async () => {
    let { loginStep } = await withFinish("suspended");
    expect(await loginStep({ step: "code", email: "a@b.in", message: "" }, form({ intent: "verify", code: "123456" })))
      .toEqual({ step: "email", error: "This firm's access is paused. Contact your firm's administrator." });
    vi.resetModules();
    ({ loginStep } = await withFinish("none"));
    expect(await loginStep({ step: "code", email: "a@b.in", message: "" }, form({ intent: "verify", code: "123456" })))
      .toEqual({ step: "email", error: "Your access has been removed. Contact your administrator." });
  });

  it.each([["staff", "/today"], ["platform", "/platform"], ["suspended", "/login?reason=paused"], ["none", "/login?reason=removed"]])(
    "link and invite sign-in as %s → %s", async (state, to) => {
      const { completeLinkSignIn, completeInviteSignIn } = await withFinish(state);
      expect(await caught(completeLinkSignIn("code"))).toBe(`REDIRECT:${to}`);
      expect(await caught(completeInviteSignIn())).toBe(`REDIRECT:${to}`);
    });

  it("a sign-in code is sent to an active super admin, never to a deactivated one (no account is created)", async () => {
    vi.doMock("@/lib/auth/finish", () => ({ finishSignIn: async () => "none" }));
    const send = async (platform: Row) => {
      vi.resetModules();
      h.admin = adminDb({ platform });
      const client = userClient();
      h.server = client;
      const { loginStep } = await import("@/lib/auth/actions");
      const r = await loginStep({ step: "email" }, form({ intent: "send", email: "Ops@Pulsebay.com" }));
      return { r, sent: client.auth.signInWithOtp.mock.calls };
    };
    const ok = await send({ status: "active" });
    expect(ok.sent).toEqual([[{ email: "ops@pulsebay.com", options: { shouldCreateUser: false, emailRedirectTo: "https://vault.example.in/auth/callback" } }]]);
    const off = await send({ status: "deactivated" });
    expect(off.sent).toEqual([]);
    expect(off.r).toEqual(ok.r); // the same neutral answer either way
  });
});

describe("requireStaff: a staff page opened by someone who isn't working staff", () => {
  const open = async (client: ReturnType<typeof userClient>) => {
    h.server = client;
    const { requireStaff } = await import("@/lib/auth/staff");
    return caught(requireStaff());
  };

  it.each([["platform", "/platform"], ["suspended", "/auth/paused"], ["none", "/auth/removed"], ["staff", "/auth/removed"], [null, "/auth/removed"]])(
    "my_access_state %s → %s", async (state, to) => {
      expect(await open(userClient({ state }))).toBe(`REDIRECT:${to}`);
    });

  it("signed out → /login; active staff get through without the extra database call", async () => {
    expect(await open(userClient({ claims: false }))).toBe("REDIRECT:/login");
    const client = userClient({ staffRow: { id: "u1", office_id: "o1", full_name: "A", email: "a@b.in", role: "staff", office: { name: "F", branch: null } } });
    expect(await open(client)).toBe("returned");
    expect(client.rpc).not.toHaveBeenCalled();
  });
});

describe("requirePlatformAdmin: the Platform area", () => {
  const open = async (client: ReturnType<typeof userClient>) => {
    h.server = client;
    const { requirePlatformAdmin } = await import("@/lib/platform/guard");
    return requirePlatformAdmin();
  };

  it("signed out → /login; staff or a deactivated super admin (platform_whoami refuses) → Not Found", async () => {
    await expect(open(userClient({ claims: false }))).rejects.toThrow("REDIRECT:/login");
    await expect(open(userClient())).rejects.toThrow("NOT_FOUND");
  });

  it("an active super admin gets through, as the database describes them", async () => {
    await expect(open(userClient({ whoami: { id: "u1", full_name: "Ops", email: "ops@pulsebay.com", test: false } })))
      .resolves.toEqual({ id: "u1", fullName: "Ops", email: "ops@pulsebay.com", test: false });
  });
});
