// Feature 19 (spec Y1, AC-1) — add, deactivate or reactivate a super admin in one environment. Pure logic,
// dependency-injected so tests/unit/platform-admin-script.test.ts runs it with a fake client. The CLI wrapper is
// scripts/add-platform-admin.mjs. Same safety rules as 17's bootstrap script (scripts/bootstrap-core.mjs).
//
// A super admin is outside every firm: never a staff member anywhere (one email = staff in one firm OR a super admin;
// the database refuses a clash both ways, EMAIL_IN_USE). They sign in with the email code like staff (no second factor
// in R1), so the script creates a confirmed auth user and sends no email: the operator tells the person to sign in.
// Nothing is ever deleted (no hard delete): a super admin who leaves is deactivated, and their open windows close.

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ENVS = ["dev", "staging", "prod"];
const ACTIONS = ["add", "deactivate", "reactivate"];

export const USAGE = `Usage: node scripts/add-platform-admin.mjs --env dev|staging|prod --email <email> [--name "<full name>"] [--deactivate | --reactivate] [--yes] [--yes-production] [--test]
  Adds a super admin (Pulsebay only; --name required), or deactivates / reactivates one (nothing is deleted).
  Reads NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and APP_ENV.
  --env names the environment you mean; prod also needs --yes-production (APP_ENV=production counts as prod too).
  Without --yes it only prints what it would do. --test works on a .test address only (never on prod).
  No email is sent: the person signs in at the vault's login page with the email code.
  Use a mailbox only that person can open: whoever controls it can read any firm's data (no second factor in R1).`;

/** argv (without node and the script) + env → { opts } or { error }. Nothing is written. */
export function parseArgs(argv, env) {
  /** @type {{ env?: string, email?: string, name?: string, action: string, test: boolean, yes: boolean, yesProduction: boolean }} */
  const o = { action: "add", test: false, yes: false, yesProduction: false };
  let actions = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    try {
      if (a === "--env") o.env = value().trim().toLowerCase();
      else if (a === "--email") o.email = value().trim().toLowerCase();
      else if (a === "--name") o.name = value().trim();
      else if (a === "--deactivate") { o.action = "deactivate"; actions++; }
      else if (a === "--reactivate") { o.action = "reactivate"; actions++; }
      else if (a === "--test") o.test = true;
      else if (a === "--yes") o.yes = true;
      else if (a === "--yes-production") o.yesProduction = true;
      else return { error: `Unknown option ${a}` };
    } catch (e) { return { error: e.message }; }
  }
  if (actions > 1) return { error: "Choose one of --deactivate or --reactivate" };
  if (!ENVS.includes(o.env)) return { error: "--env dev|staging|prod is required (the environment you mean to change)" };
  if (!o.email || !EMAIL.test(o.email) || o.email.length > 254) return { error: "--email must be a valid email address" };
  if (o.action === "add" && (!o.name || o.name.length > 120)) return { error: "--name is required to add a super admin (1–120 characters)" };
  if (o.action !== "add" && o.name !== undefined) return { error: "--name is only for adding a super admin" };
  const dotTest = o.email.endsWith(".test");
  if (dotTest && !o.test) return { error: "A .test address is a test fixture: add --test" };
  if (o.test && !dotTest) return { error: "--test only takes a .test address" };
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!url || !env.SUPABASE_SECRET_KEY) return { error: "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required" };
  // Fail closed: prod by the operator's word OR by the shell's APP_ENV (either one is enough).
  const production = o.env === "prod" || String(env.APP_ENV ?? "").trim().toLowerCase() === "production";
  if (production && !o.yesProduction) return { error: "This is production (--env prod or APP_ENV=production): add --yes-production after checking the project ref" };
  if (production && o.test) return { error: "--test never runs against production" };
  if (!ACTIONS.includes(o.action)) return { error: "Unknown action" };
  return { opts: { ...o, production, projectRef: projectRef(url) } };
}

export function projectRef(url) {
  try { return new URL(url).hostname.split(".")[0]; } catch { return "?"; }
}

/** What will happen, for the operator to check before --yes. The operator typed the email, so it is not repeated. */
export function describePlan(o) {
  const what = {
    add: `Add super admin: ${o.name} — ${o.test ? "test (.test address: acts on test firms only)" : "signs in with the email code; no email is sent"}`,
    deactivate: "Deactivate this super admin: platform access ends at once and their open support windows close",
    reactivate: "Reactivate this super admin",
  }[o.action];
  return [
    `Environment: ${o.env} · project: ${o.projectRef}${o.production ? " (PRODUCTION)" : ""}${o.test ? " · TEST" : ""}`,
    what,
  ];
}

const code = (e) => String(e?.message ?? "").split(":")[0] || e?.code || "error";

/** Finds the auth user with this email (admin API, paged), or null. */
export async function findAuthUser(db, email) {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`Could not read users (${error.code ?? error.status ?? "error"}). Nothing written.`);
    const hit = data.users.find((u) => String(u.email ?? "").toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  throw new Error("Too many users to search. Nothing written.");
}

/**
 * Runs the action. Returns { id, result } or throws an Error whose message is safe to print (no email address).
 * Add: email checks first (write nothing), then the auth user (reused if one exists without a staff row), then the
 * row; a failed row removes an auth user this run created, so a re-run starts clean.
 */
export async function run(db, o) {
  const { data: existing, error: e0 } = await db.from("platform_admin").select("id, status").eq("email", o.email).maybeSingle();
  if (e0) throw new Error(`Could not check the email (${e0.code ?? "error"}). Nothing written.`);

  if (o.action !== "add") {
    if (!existing) throw new Error("No super admin has this email. Nothing written.");
    const status = o.action === "deactivate" ? "deactivated" : "active";
    if (existing.status === status) return { id: existing.id, result: `already ${status}` };
    const { error } = await db.from("platform_admin").update({ status }).eq("id", existing.id);
    if (error) throw new Error(`Not changed (${code(error)}).`);
    if (o.action === "deactivate") {
      const { error: e2 } = await db.from("platform_access").update({ closed_at: new Date().toISOString() })
        .eq("admin_id", existing.id).is("closed_at", null);
      if (e2) throw new Error(`Deactivated, but open support windows were not closed (${code(e2)}). They end within 60 minutes; run again.`);
    }
    await audit(db, existing.id, o.action === "deactivate" ? "admin.deactivated" : "admin.reactivated");
    return { id: existing.id, result: status };
  }

  if (existing) throw new Error(`Already a super admin (${existing.status}).${existing.status === "deactivated" ? " Use --reactivate." : ""} Nothing written.`);
  const { data: staff, error: e1 } = await db.from("staff_user").select("id").eq("email", o.email).maybeSingle();
  if (e1) throw new Error(`Could not check the email (${e1.code ?? "error"}). Nothing written.`);
  if (staff) throw new Error("This email can't be used: it belongs to a firm's staff (one email = one role). Nothing written.");

  let user = await findAuthUser(db, o.email);
  let created = false;
  if (!user) {
    const r = await db.auth.admin.createUser({ email: o.email, email_confirm: true });
    if (r.error || !r.data?.user) throw new Error(`Account not created (${r.error?.code ?? r.error?.status ?? "error"}). Nothing written.`);
    user = r.data.user;
    created = true;
  }
  const { error: e2 } = await db.from("platform_admin").insert({ id: user.id, email: o.email, full_name: o.name, status: "active" });
  if (e2) {
    if (created) await db.auth.admin.deleteUser(user.id).then(() => undefined, () => undefined);
    throw new Error(`Super admin not recorded (${code(e2)}).${created ? " The account was removed; run again." : ""}`);
  }
  await audit(db, user.id, "admin.added");
  return { id: user.id, result: "added" };
}

/** Platform audit row for an operator change. admin_id = the super admin it is about (the operator has no row). */
async function audit(db, adminId, action) {
  const { error } = await db.from("platform_audit").insert({ admin_id: adminId, action, detail: { via: "script" } });
  if (error) throw new Error(`Done, but the platform audit row failed (${code(error)}). Record it before go-live.`);
}
