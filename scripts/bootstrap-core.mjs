// Feature 17 (spec AC-14–18) — set up a firm in one environment: its office (public.bootstrap_office: create, reuse a
// staff-less one, or in single mode claim the seeded row), catalogue + formats, and the first Admin by invite email.
// Pure logic, dependency-injected so tests/unit/bootstrap-script.test.ts runs it with a fake client.
// The CLI wrapper is scripts/bootstrap-firm.mjs.

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const USAGE = `Usage: node scripts/bootstrap-firm.mjs --env dev|staging|prod --name "<firm>" [--branch "<branch>"] --admin-email <email> --admin-name "<name>" [--office <id>] [--yes] [--yes-production] [--test]
  Reads NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, TENANCY_MODE (unset = multi), APP_PUBLIC_URL and APP_ENV.
  --env names the environment you mean; prod also needs --yes-production (APP_ENV=production counts as prod too).
  A new firm is created unless --office <id> names an existing staff-less office to set up (a re-run after a failed
  invite, or the seeded row on staging/prod); the dry run lists staff-less firms with this name and their IDs.
  Without --yes it only prints what it would do. --test works on a test office and a .test address (no email sent;
  never on prod).`;

const ENVS = ["dev", "staging", "prod"];

/** Same rule as src/lib/tenancy.ts: unset/blank → multi; anything but multi/single is an error. */
export function readMode(raw) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "" || v === "multi") return "multi";
  if (v === "single") return "single";
  throw new Error("TENANCY_MODE must be multi or single");
}

/** argv (without node and the script) + env → { opts } or { error }. Nothing is written. */
export function parseArgs(argv, env) {
  /** @type {{ env?: string, name?: string, branch?: string, adminEmail?: string, adminName?: string, officeId?: string, test: boolean, yes: boolean, yesProduction: boolean }} */
  const o = { test: false, yes: false, yesProduction: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    try {
      if (a === "--env") o.env = value().trim().toLowerCase();
      else if (a === "--name") o.name = value().trim();
      else if (a === "--branch") o.branch = value().trim();
      else if (a === "--admin-email") o.adminEmail = value().trim().toLowerCase();
      else if (a === "--admin-name") o.adminName = value().trim();
      else if (a === "--office") o.officeId = value().trim().toLowerCase();
      else if (a === "--test") o.test = true;
      else if (a === "--yes") o.yes = true;
      else if (a === "--yes-production") o.yesProduction = true;
      else return { error: `Unknown option ${a}` };
    } catch (e) { return { error: e.message }; }
  }
  if (!ENVS.includes(o.env)) return { error: "--env dev|staging|prod is required (the environment you mean to change)" };
  if (!o.name || o.name.length > 120) return { error: "--name is required (1–120 characters)" };
  if (o.branch !== undefined && (o.branch === "" || o.branch.length > 120)) return { error: "--branch must be 1–120 characters" };
  if (!o.adminEmail || !EMAIL.test(o.adminEmail)) return { error: "--admin-email must be a valid email address" };
  if (o.officeId !== undefined && !UUID.test(o.officeId)) return { error: "--office must be an office ID (uuid)" };
  if (!o.adminName || o.adminName.length > 120) return { error: "--admin-name is required (1–120 characters)" };
  const dotTest = o.adminEmail.endsWith(".test");
  if (dotTest && !o.test) return { error: "A .test address is a test fixture: add --test" };
  if (o.test && !dotTest) return { error: "--test only takes a .test address (no real person is invited by a test run)" };
  let mode;
  try { mode = readMode(env.TENANCY_MODE); } catch (e) { return { error: e.message }; }
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!url || !env.SUPABASE_SECRET_KEY) return { error: "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required" };
  // Fail closed: prod by the operator's word OR by the shell's APP_ENV (either one is enough).
  const production = o.env === "prod" || String(env.APP_ENV ?? "").trim().toLowerCase() === "production";
  if (production && !o.yesProduction) return { error: "This is production (--env prod or APP_ENV=production): add --yes-production after checking the project ref" };
  if (production && o.test) return { error: "--test never runs against production" };
  const base = String(env.APP_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (!o.test && !/^https:\/\//.test(base)) return { error: "APP_PUBLIC_URL (https) is required: the invite links to <APP_PUBLIC_URL>/auth/callback" };
  return { opts: { ...o, mode, production, projectRef: projectRef(url), redirectTo: o.test ? null : `${base}/auth/callback` } };
}

export function projectRef(url) {
  try { return new URL(url).hostname.split(".")[0]; } catch { return "?"; }
}

/** What will happen, for the operator to check before --yes. No email address: the operator typed it. */
export function describePlan(o) {
  return [
    `Environment: ${o.env} · project: ${o.projectRef}${o.production ? " (PRODUCTION)" : ""} · mode: ${o.mode}${o.test ? " · TEST office" : ""}`,
    `Firm: ${o.name}${o.branch ? ` · ${o.branch}` : ""} — ${o.officeId ? `set up in existing office ${o.officeId} (must have no staff; its name and branch are replaced)` : `a new firm${o.mode === "single" && !o.test ? " (or the deployment's one staff-less office, renamed)" : ""}`}`,
    `First Admin: ${o.adminName} — ${o.test ? "account created, no email (.test)" : "invited by email"}`,
  ];
}

/** Staff-less offices with exactly this name (dry run only), so the operator can pass --office instead of creating. */
export async function staffLessNamesakes(db, o) {
  const { data } = await db.from("office").select("id, branch, staff_user(id)").eq("name", o.name).eq("is_test", o.test);
  return (data ?? []).filter((r) => (r.staff_user ?? []).length === 0).map((r) => ({ id: r.id, branch: r.branch }));
}

/**
 * Runs the bootstrap. Returns { officeId, result } or throws an Error whose message is safe to print.
 * Order: the email check (writes nothing), the office (re-runnable), then the person. A failed staff row removes the
 * just-invited auth user, so running again can invite again.
 */
export async function runBootstrap(db, o) {
  const { data: taken, error: e0 } = await db.from("staff_user").select("id").eq("email", o.adminEmail).maybeSingle();
  if (e0) throw new Error(`Could not check the email (${e0.code ?? "error"}). Nothing written.`);
  if (taken) throw new Error("This email can't be invited (one email = one firm). Use a different address. Nothing written.");

  const { data: boot, error: e1 } = await db.rpc("bootstrap_office", {
    p: { name: o.name, ...(o.branch ? { branch: o.branch } : {}), mode: o.mode, test: o.test, ...(o.officeId ? { office_id: o.officeId } : {}) },
  });
  if (e1) throw new Error(`Firm not set up: ${String(e1.message).split(":")[0]}`);
  const officeId = boot.office_id;

  // data.firm feeds the invite email template only; never use user_metadata for anything else (the user can edit it).
  const invited = o.test
    ? await db.auth.admin.createUser({ email: o.adminEmail, email_confirm: true })
    : await db.auth.admin.inviteUserByEmail(o.adminEmail, { redirectTo: o.redirectTo, data: { firm: o.name } });
  if (invited.error || !invited.data?.user) throw new Error(`Invite not sent (${invited.error?.code ?? invited.error?.status ?? "error"}). The firm is set up; run again to retry.`);
  const userId = invited.data.user.id;

  const { error: e2 } = await db.from("staff_user").insert({
    id: userId, office_id: officeId, full_name: o.adminName, email: o.adminEmail, role: "admin", status: o.test ? "active" : "invited",
    ...(o.test ? { activated_at: new Date().toISOString() } : {}),
  });
  if (e2) {
    await db.auth.admin.deleteUser(userId).then(() => undefined, () => undefined);
    throw new Error(`Admin not recorded (${e2.code ?? "error"}); the invite was withdrawn. The firm is set up; run again to retry.`);
  }
  const { error: e3 } = await db.from("activity").insert({
    office_id: officeId, actor_id: null, action: "staff.invited", entity_type: "staff_user", entity_id: userId,
    data: { role: "admin", via: "bootstrap" },
  });
  if (e3) throw new Error(`Admin invited, but the staff.invited activity row failed (${e3.code ?? "error"}). Record it before go-live.`);
  return { officeId, result: boot.result };
}
