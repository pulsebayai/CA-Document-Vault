import { describe, expect, it, vi } from "vitest";
import { describePlan, parseArgs, readMode, runBootstrap, staffLessNamesakes } from "../../scripts/bootstrap-core.mjs";

// Feature 17 (spec AC-14–18): the operator's bootstrap script — argument checks and refusals, and the order of writes.

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnop.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_x",
  APP_PUBLIC_URL: "https://vault.example.in/",
};
const ARGS = ["--env", "staging", "--name", " Kushal Associates ", "--branch", "Pondicherry", "--admin-email", "Admin@Firm.in", "--admin-name", "Raja"];

describe("parseArgs", () => {
  it("reads the firm, the first Admin and the environment; unset mode is multi", () => {
    const r = parseArgs(ARGS, ENV);
    expect(r.opts).toMatchObject({
      name: "Kushal Associates", branch: "Pondicherry", adminEmail: "admin@firm.in", adminName: "Raja",
      env: "staging", mode: "multi", test: false, yes: false, production: false, projectRef: "abcdefghijklmnop",
      redirectTo: "https://vault.example.in/auth/callback",
    });
    expect(parseArgs(ARGS, { ...ENV, TENANCY_MODE: "SINGLE" }).opts?.mode).toBe("single");
  });

  it("refuses what it can't do safely", () => {
    const err = (argv: string[], env: Record<string, string | undefined> = ENV) => parseArgs(argv, env).error;
    expect(err(["--env", "dev", "--branch", "x", "--admin-email", "a@b.in", "--admin-name", "A"])).toMatch(/--name is required/);
    expect(err(ARGS.slice(2))).toMatch(/--env dev\|staging\|prod is required/);
    expect(err(["--env", "production", ...ARGS.slice(2)])).toMatch(/--env dev\|staging\|prod is required/);
    expect(err([...ARGS.slice(0, 6), "--admin-email", "not-an-email", "--admin-name", "A"])).toMatch(/valid email/);
    expect(err(ARGS, { ...ENV, TENANCY_MODE: "saas" })).toMatch(/TENANCY_MODE must be multi or single/);
    expect(err(ARGS, { ...ENV, SUPABASE_SECRET_KEY: undefined })).toMatch(/SUPABASE_SECRET_KEY are required/);
    expect(err(ARGS, { ...ENV, APP_PUBLIC_URL: "" })).toMatch(/APP_PUBLIC_URL \(https\) is required/);
    expect(err([...ARGS, "--force"])).toMatch(/Unknown option --force/);
    expect(err(["--env", "dev", "--name"])).toMatch(/--name needs a value/);
  });

  it("a .test address needs --test, and --test takes only a .test address", () => {
    const fixture = ["--env", "dev", "--name", "e2e office bootstrap", "--admin-email", "boot@example.test", "--admin-name", "Boot"];
    expect(parseArgs(fixture, ENV).error).toMatch(/add --test/);
    expect(parseArgs([...fixture, "--test"], { ...ENV, APP_PUBLIC_URL: "" }).opts).toMatchObject({ test: true, redirectTo: null });
    expect(parseArgs([...ARGS, "--test"], ENV).error).toMatch(/--test only takes a \.test address/);
  });

  it("production (--env prod, or APP_ENV=production even with another --env) needs --yes-production, and never --test", () => {
    const prodArgs = ["--env", "prod", ...ARGS.slice(2)];
    expect(parseArgs(prodArgs, ENV).error).toMatch(/add --yes-production/);
    expect(parseArgs(ARGS, { ...ENV, APP_ENV: "production" }).error).toMatch(/add --yes-production/); // fail closed
    expect(parseArgs([...prodArgs, "--yes-production"], ENV).opts?.production).toBe(true);
    const fixture = ["--env", "prod", "--name", "x", "--admin-email", "b@example.test", "--admin-name", "B", "--test", "--yes-production"];
    expect(parseArgs(fixture, ENV).error).toMatch(/--test never runs against production/);
  });

  it("--office takes an office ID only (review I-5: reuse is by ID, never by name)", () => {
    const id = "0b8c5f8e-1d2a-4c3b-9e4f-5a6b7c8d9e0f";
    expect(parseArgs([...ARGS, "--office", id.toUpperCase()], ENV).opts?.officeId).toBe(id);
    expect(parseArgs([...ARGS, "--office", "Kushal Associates"], ENV).error).toMatch(/--office must be an office ID/);
    expect(describePlan(parseArgs([...ARGS, "--office", id], ENV).opts).join("\n")).toMatch(new RegExp(`existing office ${id}`));
    expect(describePlan(parseArgs(ARGS, ENV).opts).join("\n")).toMatch(/— a new firm/);
  });

  it("readMode mirrors src/lib/tenancy.ts", () => {
    expect([readMode(undefined), readMode(" "), readMode("Multi"), readMode("single")]).toEqual(["multi", "multi", "multi", "single"]);
    expect(() => readMode("both")).toThrow();
  });

  it("the plan names the project, the mode and the firm, but not the email address", () => {
    const lines = describePlan(parseArgs(["--env", "prod", ...ARGS.slice(2), "--yes-production"], { ...ENV, TENANCY_MODE: "single" }).opts).join("\n");
    expect(lines).toMatch(/Environment: prod · project: abcdefghijklmnop \(PRODUCTION\) · mode: single/);
    expect(lines).toMatch(/Kushal Associates · Pondicherry/);
    expect(lines).toMatch(/one staff-less office, renamed/);
    expect(lines).not.toMatch(/admin@firm\.in/i);
  });
});

function fakeDb({ taken = false, inviteError = null as null | { code: string }, staffError = null as null | { code: string }, activityError = null as null | { code: string } } = {}) {
  const calls: string[] = [];
  const rpc = vi.fn(async (...args: [string, unknown]) => { void args; calls.push("bootstrap_office"); return { data: { office_id: "o1", result: "reused" }, error: null }; });
  const inserts: Array<[string, unknown]> = [];
  const db = {
    rpc,
    from: (table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => { calls.push(`check:${table}`); return { data: taken ? { id: "x" } : null, error: null }; } }) }),
      insert: async (row: unknown) => {
        calls.push(`insert:${table}`); inserts.push([table, row]);
        return { error: table === "staff_user" ? staffError : table === "activity" ? activityError : null };
      },
    }),
    auth: { admin: {
      inviteUserByEmail: vi.fn(async () => { calls.push("invite"); return inviteError ? { data: { user: null }, error: inviteError } : { data: { user: { id: "u1" } }, error: null }; }),
      createUser: vi.fn(async () => { calls.push("createUser"); return { data: { user: { id: "u1" } }, error: null }; }),
      deleteUser: vi.fn(async () => { calls.push("deleteUser"); return { error: null }; }),
    } },
  };
  return { db, calls, inserts, rpc };
}

describe("runBootstrap", () => {
  const opts = parseArgs([...ARGS, "--yes"], ENV).opts;

  it("checks the email, then the office, the invite (with the firm for the template), the staff row and one activity row", async () => {
    const f = fakeDb();
    expect(await runBootstrap(f.db, opts)).toEqual({ officeId: "o1", result: "reused" });
    expect(f.calls).toEqual(["check:staff_user", "bootstrap_office", "invite", "insert:staff_user", "insert:activity"]);
    expect(f.rpc).toHaveBeenCalledWith("bootstrap_office", { p: { name: "Kushal Associates", branch: "Pondicherry", mode: "multi", test: false } });
    expect(f.db.auth.admin.inviteUserByEmail).toHaveBeenCalledWith("admin@firm.in", { redirectTo: "https://vault.example.in/auth/callback", data: { firm: "Kushal Associates" } });
    expect(f.inserts[0][1]).toMatchObject({ id: "u1", office_id: "o1", role: "admin", status: "invited", email: "admin@firm.in" });
    expect(f.inserts[1][1]).toEqual({ office_id: "o1", actor_id: null, action: "staff.invited", entity_type: "staff_user", entity_id: "u1", data: { role: "admin", via: "bootstrap" } });
  });

  it("an email already used anywhere stops before anything is written", async () => {
    const f = fakeDb({ taken: true });
    await expect(runBootstrap(f.db, opts)).rejects.toThrow(/one email = one firm.*Nothing written/);
    expect(f.calls).toEqual(["check:staff_user"]);
  });

  it("a failed invite leaves the firm set up and says to run again", async () => {
    const f = fakeDb({ inviteError: { code: "over_email_send_rate_limit" } });
    await expect(runBootstrap(f.db, opts)).rejects.toThrow(/Invite not sent \(over_email_send_rate_limit\)\. The firm is set up; run again/);
    expect(f.calls).toEqual(["check:staff_user", "bootstrap_office", "invite"]);
  });

  it("a failed staff row withdraws the invite, so a re-run can invite again", async () => {
    const f = fakeDb({ staffError: { code: "23505" } });
    await expect(runBootstrap(f.db, opts)).rejects.toThrow(/Admin not recorded \(23505\); the invite was withdrawn/);
    expect(f.calls).toEqual(["check:staff_user", "bootstrap_office", "invite", "insert:staff_user", "deleteUser"]);
  });

  it("a failed activity row is reported, not swallowed (AC-14)", async () => {
    const f = fakeDb({ activityError: { code: "P0001" } });
    await expect(runBootstrap(f.db, opts)).rejects.toThrow(/staff\.invited activity row failed \(P0001\)/);
  });

  it("passes the office ID when given", async () => {
    const f = fakeDb();
    const id = "0b8c5f8e-1d2a-4c3b-9e4f-5a6b7c8d9e0f";
    await runBootstrap(f.db, parseArgs([...ARGS, "--office", id, "--yes"], ENV).opts);
    expect(f.rpc).toHaveBeenCalledWith("bootstrap_office", { p: { name: "Kushal Associates", branch: "Pondicherry", mode: "multi", test: false, office_id: id } });
  });

  it("the dry run lists only staff-less namesakes", async () => {
    const db = { from: () => ({ select: () => ({ eq: () => ({ eq: async () => ({ data: [
      { id: "a", branch: "Chennai", staff_user: [] }, { id: "b", branch: null, staff_user: [{ id: "s" }] },
    ] }) }) }) }) };
    expect(await staffLessNamesakes(db, parseArgs(ARGS, ENV).opts)).toEqual([{ id: "a", branch: "Chennai" }]);
  });

  it("--test creates the account without an email and marks it active", async () => {
    const f = fakeDb();
    const t = parseArgs(["--env", "dev", "--name", "e2e office bootstrap", "--admin-email", "boot@example.test", "--admin-name", "Boot", "--test", "--yes"], ENV).opts;
    await runBootstrap(f.db, t);
    expect(f.calls).toEqual(["check:staff_user", "bootstrap_office", "createUser", "insert:staff_user", "insert:activity"]);
    expect(f.rpc).toHaveBeenCalledWith("bootstrap_office", { p: { name: "e2e office bootstrap", mode: "multi", test: true } });
    expect(f.inserts[0][1]).toMatchObject({ status: "active" });
  });
});
