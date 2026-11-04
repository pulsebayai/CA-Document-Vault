import { describe, expect, it, vi } from "vitest";
import { describePlan, parseArgs, run } from "../../scripts/platform-admin-core.mjs";

// Feature 19 (spec Y1, AC-1): the operator's super-admin script — argument checks and refusals, the order of writes,
// and that nothing is ever deleted except an account this same run created.

const ENV = { NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnop.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_x" };
const ADD = ["--env", "staging", "--email", " Ops@Pulsebay.com ", "--name", " Ops Person "];

describe("parseArgs", () => {
  it("reads the email, the name and the environment; adding is the default action", () => {
    expect(parseArgs(ADD, ENV).opts).toMatchObject({
      env: "staging", email: "ops@pulsebay.com", name: "Ops Person", action: "add", test: false, yes: false,
      production: false, projectRef: "abcdefghijklmnop",
    });
    expect(parseArgs(["--env", "dev", "--email", "a@b.in", "--deactivate"], ENV).opts?.action).toBe("deactivate");
    expect(parseArgs(["--env", "dev", "--email", "a@b.in", "--reactivate"], ENV).opts?.action).toBe("reactivate");
  });

  it("refuses what it can't do safely", () => {
    const err = (argv: string[], env: Record<string, string | undefined> = ENV) => parseArgs(argv, env).error;
    expect(err(ADD.slice(2))).toMatch(/--env dev\|staging\|prod is required/);
    expect(err(["--env", "production", ...ADD.slice(2)])).toMatch(/--env dev\|staging\|prod is required/);
    expect(err(["--env", "dev", "--email", "not-an-email", "--name", "A"])).toMatch(/valid email/);
    expect(err(["--env", "dev", "--email", "a@b.in"])).toMatch(/--name is required/);
    expect(err(["--env", "dev", "--email", "a@b.in", "--name", "x".repeat(121)])).toMatch(/--name is required/);
    expect(err(["--env", "dev", "--email", "a@b.in", "--name", "A", "--deactivate"])).toMatch(/--name is only for adding/);
    expect(err(["--env", "dev", "--email", "a@b.in", "--deactivate", "--reactivate"])).toMatch(/Choose one/);
    expect(err(ADD, { ...ENV, SUPABASE_SECRET_KEY: undefined })).toMatch(/SUPABASE_SECRET_KEY are required/);
    expect(err([...ADD, "--force"])).toMatch(/Unknown option --force/);
    expect(err(["--env", "dev", "--email"])).toMatch(/--email needs a value/);
  });

  it("a .test address needs --test, and --test takes only a .test address", () => {
    const fixture = ["--env", "dev", "--email", "sa@example.test", "--name", "SA"];
    expect(parseArgs(fixture, ENV).error).toMatch(/add --test/);
    expect(parseArgs([...fixture, "--test"], ENV).opts?.test).toBe(true);
    expect(parseArgs([...ADD, "--test"], ENV).error).toMatch(/--test only takes a \.test address/);
  });

  it("production (--env prod, or APP_ENV=production even with another --env) needs --yes-production, and never --test", () => {
    const prod = ["--env", "prod", ...ADD.slice(2)];
    expect(parseArgs(prod, ENV).error).toMatch(/add --yes-production/);
    expect(parseArgs(ADD, { ...ENV, APP_ENV: "production" }).error).toMatch(/add --yes-production/); // fail closed
    expect(parseArgs([...prod, "--yes-production"], ENV).opts?.production).toBe(true);
    expect(parseArgs(["--env", "prod", "--email", "s@example.test", "--name", "S", "--test", "--yes-production"], ENV).error)
      .toMatch(/--test never runs against production/);
  });

  it("the plan names the project and the action, but not the email address", () => {
    const lines = describePlan(parseArgs(["--env", "prod", ...ADD.slice(2), "--yes-production"], ENV).opts).join("\n");
    expect(lines).toMatch(/Environment: prod · project: abcdefghijklmnop \(PRODUCTION\)/);
    expect(lines).toMatch(/Add super admin: Ops Person — signs in with the email code; no email is sent/);
    expect(lines).not.toMatch(/ops@pulsebay\.com/i);
    expect(describePlan(parseArgs(["--env", "dev", "--email", "a@b.in", "--deactivate"], ENV).opts).join("\n")).toMatch(/open support windows close/);
  });
});

type Err = null | { code?: string; message?: string };
function fakeDb({
  admin = null as null | { id: string; status: string }, staff = false, authUser = null as null | { id: string; email: string },
  createError = null as Err, insertError = null as Err, auditError = null as Err,
} = {}) {
  const calls: string[] = [];
  const writes: Array<[string, string, unknown]> = [];
  const eqChain = (table: string) => {
    const chain = {
      eq: () => chain,
      is: () => chain,
      maybeSingle: async () => {
        calls.push(`check:${table}`);
        return { data: table === "platform_admin" ? admin : staff ? { id: "s1" } : null, error: null };
      },
      then: (ok: (v: { error: Err }) => unknown) => Promise.resolve({ error: null }).then(ok),
    };
    return chain;
  };
  const db = {
    from: (table: string) => ({
      select: () => eqChain(table),
      insert: async (row: unknown) => {
        calls.push(`insert:${table}`); writes.push(["insert", table, row]);
        return { error: table === "platform_admin" ? insertError : table === "platform_audit" ? auditError : null };
      },
      update: (row: unknown) => { calls.push(`update:${table}`); writes.push(["update", table, row]); return eqChain(table); },
      delete: () => { throw new Error("nothing is ever deleted"); },
    }),
    auth: { admin: {
      listUsers: vi.fn(async () => { calls.push("listUsers"); return { data: { users: authUser ? [authUser] : [] }, error: null }; }),
      createUser: vi.fn(async () => {
        calls.push("createUser");
        return createError ? { data: { user: null }, error: createError } : { data: { user: { id: "u1" } }, error: null };
      }),
      deleteUser: vi.fn(async () => { calls.push("deleteUser"); return { error: null }; }),
    } },
  };
  return { db, calls, writes };
}

describe("run: add", () => {
  const opts = parseArgs([...ADD, "--yes"], ENV).opts;

  it("checks both roles, creates a confirmed account (no email), records the row and one audit row", async () => {
    const f = fakeDb();
    expect(await run(f.db, opts)).toEqual({ id: "u1", result: "added" });
    expect(f.calls).toEqual(["check:platform_admin", "check:staff_user", "listUsers", "createUser", "insert:platform_admin", "insert:platform_audit"]);
    expect(f.db.auth.admin.createUser).toHaveBeenCalledWith({ email: "ops@pulsebay.com", email_confirm: true });
    expect(f.writes[0][2]).toEqual({ id: "u1", email: "ops@pulsebay.com", full_name: "Ops Person", status: "active" });
    expect(f.writes[1][2]).toEqual({ admin_id: "u1", action: "admin.added", detail: { via: "script" } });
  });

  it("an email that is staff anywhere stops before anything is written, with a message that names no firm", async () => {
    const f = fakeDb({ staff: true });
    await expect(run(f.db, opts)).rejects.toThrow(/belongs to a firm's staff.*Nothing written/);
    expect(f.calls).toEqual(["check:platform_admin", "check:staff_user"]);
  });

  it("an existing super admin is refused (deactivated: points at --reactivate)", async () => {
    await expect(run(fakeDb({ admin: { id: "a", status: "active" } }).db, opts)).rejects.toThrow(/Already a super admin \(active\)\. Nothing written/);
    await expect(run(fakeDb({ admin: { id: "a", status: "deactivated" } }).db, opts)).rejects.toThrow(/Use --reactivate/);
  });

  it("reuses an auth account that already exists without a staff row, and never deletes it on failure", async () => {
    const f = fakeDb({ authUser: { id: "u9", email: "ops@pulsebay.com" }, insertError: { message: "EMAIL_IN_USE: this email belongs to a firm's staff" } });
    await expect(run(f.db, opts)).rejects.toThrow(/Super admin not recorded \(EMAIL_IN_USE\)\.$/);
    expect(f.calls).toEqual(["check:platform_admin", "check:staff_user", "listUsers", "insert:platform_admin"]);
  });

  it("a failed row removes the account this run created, so a re-run starts clean", async () => {
    const f = fakeDb({ insertError: { code: "23505" } });
    await expect(run(f.db, opts)).rejects.toThrow(/not recorded \(23505\)\. The account was removed; run again/);
    expect(f.calls.slice(-2)).toEqual(["insert:platform_admin", "deleteUser"]);
  });

  it("a failed account creation writes nothing", async () => {
    const f = fakeDb({ createError: { code: "email_exists" } });
    await expect(run(f.db, opts)).rejects.toThrow(/Account not created \(email_exists\)\. Nothing written/);
    expect(f.calls).not.toContain("insert:platform_admin");
  });

  it("a failed audit row is reported, not swallowed", async () => {
    await expect(run(fakeDb({ auditError: { code: "P0001" } }).db, opts)).rejects.toThrow(/platform audit row failed/);
  });

  it("no message carries the email address", async () => {
    const msgs: string[] = [];
    for (const f of [fakeDb({ staff: true }), fakeDb({ admin: { id: "a", status: "active" } }), fakeDb({ insertError: { code: "x" } })]) {
      await run(f.db, opts).catch((e: Error) => msgs.push(e.message));
    }
    expect(msgs.join(" ")).not.toMatch(/pulsebay\.com/i);
  });
});

describe("run: deactivate / reactivate", () => {
  const de = parseArgs(["--env", "dev", "--email", "ops@pulsebay.com", "--deactivate", "--yes"], ENV).opts;
  const re = parseArgs(["--env", "dev", "--email", "ops@pulsebay.com", "--reactivate", "--yes"], ENV).opts;

  it("deactivating sets the status, closes their open windows and writes one audit row; nothing is deleted", async () => {
    const f = fakeDb({ admin: { id: "a1", status: "active" } });
    expect(await run(f.db, de)).toEqual({ id: "a1", result: "deactivated" });
    expect(f.calls).toEqual(["check:platform_admin", "update:platform_admin", "update:platform_access", "insert:platform_audit"]);
    expect(f.writes[0][2]).toEqual({ status: "deactivated" });
    expect(f.writes[1][2]).toMatchObject({ closed_at: expect.any(String) });
    expect(f.writes[2][2]).toEqual({ admin_id: "a1", action: "admin.deactivated", detail: { via: "script" } });
  });

  it("reactivating sets the status back; already in that state changes nothing", async () => {
    const f = fakeDb({ admin: { id: "a1", status: "deactivated" } });
    expect(await run(f.db, re)).toEqual({ id: "a1", result: "active" });
    expect(f.calls).toEqual(["check:platform_admin", "update:platform_admin", "insert:platform_audit"]);
    const g = fakeDb({ admin: { id: "a1", status: "active" } });
    expect(await run(g.db, re)).toEqual({ id: "a1", result: "already active" });
    expect(g.calls).toEqual(["check:platform_admin"]);
  });

  it("an unknown email is refused", async () => {
    await expect(run(fakeDb().db, de)).rejects.toThrow(/No super admin has this email\. Nothing written/);
  });
});
