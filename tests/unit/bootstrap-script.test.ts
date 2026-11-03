import { describe, expect, it, vi } from "vitest";
import { describePlan, parseArgs, readMode, runBootstrap } from "../../scripts/bootstrap-core.mjs";

// Feature 17 (spec AC-14–18): the operator's bootstrap script — argument checks and refusals, and the order of writes.

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnop.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_x",
  APP_PUBLIC_URL: "https://vault.example.in/",
};
const ARGS = ["--name", " Kushal Associates ", "--branch", "Pondicherry", "--admin-email", "Admin@Firm.in", "--admin-name", "Raja"];

describe("parseArgs", () => {
  it("reads the firm, the first Admin and the environment; unset mode is multi", () => {
    const r = parseArgs(ARGS, ENV);
    expect(r.opts).toMatchObject({
      name: "Kushal Associates", branch: "Pondicherry", adminEmail: "admin@firm.in", adminName: "Raja",
      mode: "multi", test: false, yes: false, production: false, projectRef: "abcdefghijklmnop",
      redirectTo: "https://vault.example.in/auth/callback",
    });
    expect(parseArgs(ARGS, { ...ENV, TENANCY_MODE: "SINGLE" }).opts?.mode).toBe("single");
  });

  it("refuses what it can't do safely", () => {
    const err = (argv: string[], env: Record<string, string | undefined> = ENV) => parseArgs(argv, env).error;
    expect(err(["--branch", "x", "--admin-email", "a@b.in", "--admin-name", "A"])).toMatch(/--name is required/);
    expect(err([...ARGS.slice(0, 4), "--admin-email", "not-an-email", "--admin-name", "A"])).toMatch(/valid email/);
    expect(err(ARGS, { ...ENV, TENANCY_MODE: "saas" })).toMatch(/TENANCY_MODE must be multi or single/);
    expect(err(ARGS, { ...ENV, SUPABASE_SECRET_KEY: undefined })).toMatch(/SUPABASE_SECRET_KEY are required/);
    expect(err(ARGS, { ...ENV, APP_PUBLIC_URL: "" })).toMatch(/APP_PUBLIC_URL \(https\) is required/);
    expect(err([...ARGS, "--force"])).toMatch(/Unknown option --force/);
    expect(err(["--name"])).toMatch(/--name needs a value/);
  });

  it("a .test address needs --test, and --test takes only a .test address", () => {
    const fixture = ["--name", "e2e office bootstrap", "--admin-email", "boot@example.test", "--admin-name", "Boot"];
    expect(parseArgs(fixture, ENV).error).toMatch(/add --test/);
    expect(parseArgs([...fixture, "--test"], { ...ENV, APP_PUBLIC_URL: "" }).opts).toMatchObject({ test: true, redirectTo: null });
    expect(parseArgs([...ARGS, "--test"], ENV).error).toMatch(/--test only takes a \.test address/);
  });

  it("production needs --yes-production, and never --test", () => {
    const prod = { ...ENV, APP_ENV: "production" };
    expect(parseArgs(ARGS, prod).error).toMatch(/add --yes-production/);
    expect(parseArgs([...ARGS, "--yes-production"], prod).opts?.production).toBe(true);
    const fixture = ["--name", "x", "--admin-email", "b@example.test", "--admin-name", "B", "--test", "--yes-production"];
    expect(parseArgs(fixture, prod).error).toMatch(/--test never runs against production/);
  });

  it("readMode mirrors src/lib/tenancy.ts", () => {
    expect([readMode(undefined), readMode(" "), readMode("Multi"), readMode("single")]).toEqual(["multi", "multi", "multi", "single"]);
    expect(() => readMode("both")).toThrow();
  });

  it("the plan names the project, the mode and the firm, but not the email address", () => {
    const lines = describePlan(parseArgs([...ARGS, "--yes-production"], { ...ENV, APP_ENV: "production", TENANCY_MODE: "single" }).opts).join("\n");
    expect(lines).toMatch(/abcdefghijklmnop \(PRODUCTION\) · mode: single/);
    expect(lines).toMatch(/Kushal Associates · Pondicherry/);
    expect(lines).toMatch(/staff-less office renamed/);
    expect(lines).not.toMatch(/admin@firm\.in/i);
  });
});

function fakeDb({ taken = false, inviteError = null as null | { code: string } } = {}) {
  const calls: string[] = [];
  const rpc = vi.fn(async (...args: [string, unknown]) => { void args; calls.push("bootstrap_office"); return { data: { office_id: "o1", result: "reused" }, error: null }; });
  const inserts: Array<[string, unknown]> = [];
  const db = {
    rpc,
    from: (table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: taken ? { id: "x" } : null, error: null }) }) }),
      insert: async (row: unknown) => { calls.push(`insert:${table}`); inserts.push([table, row]); return { error: null }; },
    }),
    auth: { admin: {
      inviteUserByEmail: vi.fn(async () => { calls.push("invite"); return inviteError ? { data: { user: null }, error: inviteError } : { data: { user: { id: "u1" } }, error: null }; }),
      createUser: vi.fn(async () => { calls.push("createUser"); return { data: { user: { id: "u1" } }, error: null }; }),
    } },
  };
  return { db, calls, inserts, rpc };
}

describe("runBootstrap", () => {
  const opts = parseArgs([...ARGS, "--yes"], ENV).opts;

  it("office first, then the invite (with the firm for the template), the staff row and one activity row", async () => {
    const f = fakeDb();
    expect(await runBootstrap(f.db, opts)).toEqual({ officeId: "o1", result: "reused" });
    expect(f.calls).toEqual(["bootstrap_office", "invite", "insert:staff_user", "insert:activity"]);
    expect(f.rpc).toHaveBeenCalledWith("bootstrap_office", { p: { name: "Kushal Associates", branch: "Pondicherry", mode: "multi", test: false } });
    expect(f.db.auth.admin.inviteUserByEmail).toHaveBeenCalledWith("admin@firm.in", { redirectTo: "https://vault.example.in/auth/callback", data: { firm: "Kushal Associates" } });
    expect(f.inserts[0][1]).toMatchObject({ id: "u1", office_id: "o1", role: "admin", status: "invited", email: "admin@firm.in" });
    expect(f.inserts[1][1]).toEqual({ office_id: "o1", actor_id: null, action: "staff.invited", entity_type: "staff_user", entity_id: "u1", data: { role: "admin", via: "bootstrap" } });
  });

  it("an email already used anywhere stops before any invite", async () => {
    const f = fakeDb({ taken: true });
    await expect(runBootstrap(f.db, opts)).rejects.toThrow(/one email = one firm/);
    expect(f.calls).toEqual(["bootstrap_office"]);
  });

  it("a failed invite leaves the firm set up and says to run again", async () => {
    const f = fakeDb({ inviteError: { code: "over_email_send_rate_limit" } });
    await expect(runBootstrap(f.db, opts)).rejects.toThrow(/Invite not sent \(over_email_send_rate_limit\)\. The firm is set up; run again/);
    expect(f.calls).toEqual(["bootstrap_office", "invite"]);
  });

  it("--test creates the account without an email and marks it active", async () => {
    const f = fakeDb();
    const t = parseArgs(["--name", "e2e office bootstrap", "--admin-email", "boot@example.test", "--admin-name", "Boot", "--test", "--yes"], ENV).opts;
    await runBootstrap(f.db, t);
    expect(f.calls).toEqual(["bootstrap_office", "createUser", "insert:staff_user", "insert:activity"]);
    expect(f.rpc).toHaveBeenCalledWith("bootstrap_office", { p: { name: "e2e office bootstrap", mode: "multi", test: true } });
    expect(f.inserts[0][1]).toMatchObject({ status: "active" });
  });
});
