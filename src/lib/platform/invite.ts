import "server-only";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// 19 (spec Y3, D2): the one service-role step of the Platform area — inviting a firm's first Admin needs Supabase's
// admin API. Before the admin key is used, platform_whoami() confirms (as the signed-in user, in the database) that the
// caller is an active super admin; the staff row itself is then written by platform_record_first_admin(), as the user,
// which checks the caller, the firm (no staff yet; test super admins → test firms only) and the auth user's email,
// and logs. ESLint allow-list: this file only (architecture.md › Platform).

export type InviteResult = { ok: true } | { ok: false; error: string };

const IN_USE = "This email can't be invited. Use a different address."; // 17's neutral wording: names no firm

async function confirmedSuperAdmin(): Promise<{ id: string; test: boolean } | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_whoami");
  if (error || !data) return null;
  const me = data as { id: string; test: boolean };
  return { id: me.id, test: Boolean(me.test) };
}

async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  return `${h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")}://${host}`;
}

/** The firm as the database describes it to this super admin (name for the email, and whether it has staff yet). */
async function firmOf(officeId: string): Promise<{ name: string; staff: number } | null> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("platform_firms");
  const f = ((data ?? []) as Array<{ id: string; name: string; staff_active: number; staff_invited: number }>).find((x) => x.id === officeId);
  return f ? { name: f.name, staff: f.staff_active + f.staff_invited } : null;
}

/**
 * Invites the first Admin of a firm with no staff yet. A `.test` address gets the account without an email (CI, as
 * 17's invite does). The firm's name comes from the database, never the browser (review L-3), and a firm that already
 * has staff is refused before any email goes out. A failed record removes the account only if this call created it
 * (review M-3: an invite to an existing unconfirmed account returns that account), so a retry starts clean.
 */
export async function inviteFirstAdmin(p: { officeId: string; fullName: string; email: string }): Promise<InviteResult> {
  const me = await confirmedSuperAdmin();
  if (!me) return { ok: false, error: "Not allowed." };
  if (me.test !== p.email.endsWith(".test")) {
    return { ok: false, error: me.test ? "A test super admin invites .test addresses only." : "Use a real address for a real firm." };
  }
  const firm = await firmOf(p.officeId);
  if (!firm) return { ok: false, error: "Not allowed." };
  if (firm.staff > 0) return { ok: false, error: "This firm already has staff." };
  const admin = createAdminClient();
  const [{ data: staff }, { data: platform }] = await Promise.all([
    admin.from("staff_user").select("id").eq("email", p.email).maybeSingle(),
    admin.from("platform_admin").select("id").eq("email", p.email).maybeSingle(),
  ]);
  if (staff || platform) return { ok: false, error: IN_USE };

  const startedAt = Date.now() - 5_000; // clock skew allowance
  const { data: invited, error } = p.email.endsWith(".test")
    ? await admin.auth.admin.createUser({ email: p.email, email_confirm: true })
    : await admin.auth.admin.inviteUserByEmail(p.email, { redirectTo: `${await origin()}/auth/callback`, data: { firm: firm.name } }); // 17: {{ .Data.firm }} in the template only
  if (error || !invited.user) {
    console.error("platform.invite_failed", { code: error?.code, status: error?.status });
    return { ok: false, error: error?.code === "email_exists" ? IN_USE : "Could not send the invite. The firm is set up; try again." };
  }
  const createdHere = !invited.user.last_sign_in_at && new Date(invited.user.created_at).getTime() >= startedAt;
  const supabase = await createClient();
  const { error: recordError } = await supabase.rpc("platform_record_first_admin", {
    p_office: p.officeId, p_user: invited.user.id, p_name: p.fullName, p_email: p.email,
  });
  if (recordError) {
    if (createdHere) await admin.auth.admin.deleteUser(invited.user.id).then(() => undefined, () => undefined);
    console.error("platform.first_admin_failed", { code: recordError.code, reason: recordError.message.split(":")[0] });
    return { ok: false, error: /ALREADY_SET_UP/.test(recordError.message) ? "This firm already has staff." : /EMAIL_IN_USE/.test(recordError.message) ? IN_USE : "The Admin could not be recorded. Try again." };
  }
  return { ok: true };
}

/**
 * Sends the invite email again to a first Admin who hasn't signed in yet. The database logs the resend and hands over
 * the address in one call (platform_begin_reinvite, as the user) before anything is sent (review I-4).
 */
export async function resendFirstAdminInvite(p: { officeId: string }): Promise<InviteResult> {
  const me = await confirmedSuperAdmin();
  if (!me) return { ok: false, error: "Not allowed." };
  const firm = await firmOf(p.officeId);
  if (!firm) return { ok: false, error: "Not allowed." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_begin_reinvite", { p_office: p.officeId });
  if (error) return { ok: false, error: /NOTHING_WAITING/.test(error.message) ? "Nobody is waiting for an invite." : "Not allowed." };
  const target = data as { email: string };
  if (target.email.endsWith(".test")) return { ok: true }; // test fixtures never get email
  const { error: e2 } = await createAdminClient().auth.admin.inviteUserByEmail(target.email, { redirectTo: `${await origin()}/auth/callback`, data: { firm: firm.name } });
  if (e2) {
    console.error("platform.reinvite_failed", { code: e2.code, status: e2.status });
    return { ok: false, error: "Could not resend the invite. Try again later." };
  }
  return { ok: true };
}
