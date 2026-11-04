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

/**
 * Invites the first Admin of a firm the caller just created (or one still waiting for staff). A `.test` address gets
 * the account without an email (CI, as 17's invite does). A failed record removes the account this call created, so a
 * retry starts clean (the firm stays: a staff-less firm can be invited again).
 */
export async function inviteFirstAdmin(p: { officeId: string; firmName: string; fullName: string; email: string }): Promise<InviteResult> {
  const me = await confirmedSuperAdmin();
  if (!me) return { ok: false, error: "Not allowed." };
  if (me.test !== p.email.endsWith(".test")) {
    return { ok: false, error: me.test ? "A test super admin invites .test addresses only." : "Use a real address for a real firm." };
  }
  const admin = createAdminClient();
  const [{ data: staff }, { data: platform }] = await Promise.all([
    admin.from("staff_user").select("id").eq("email", p.email).maybeSingle(),
    admin.from("platform_admin").select("id").eq("email", p.email).maybeSingle(),
  ]);
  if (staff || platform) return { ok: false, error: IN_USE };

  const { data: invited, error } = p.email.endsWith(".test")
    ? await admin.auth.admin.createUser({ email: p.email, email_confirm: true })
    : await admin.auth.admin.inviteUserByEmail(p.email, { redirectTo: `${await origin()}/auth/callback`, data: { firm: p.firmName } }); // 17: {{ .Data.firm }} in the template only
  if (error || !invited.user) {
    console.error("platform.invite_failed", { code: error?.code, status: error?.status });
    return { ok: false, error: error?.code === "email_exists" ? IN_USE : "Could not send the invite. The firm is set up; try again." };
  }
  const supabase = await createClient();
  const { error: recordError } = await supabase.rpc("platform_record_first_admin", {
    p_office: p.officeId, p_user: invited.user.id, p_name: p.fullName, p_email: p.email,
  });
  if (recordError) {
    await admin.auth.admin.deleteUser(invited.user.id).then(() => undefined, () => undefined);
    console.error("platform.first_admin_failed", { code: recordError.code, reason: recordError.message.split(":")[0] });
    return { ok: false, error: /ALREADY_SET_UP/.test(recordError.message) ? "This firm already has staff." : /EMAIL_IN_USE/.test(recordError.message) ? IN_USE : "The Admin could not be recorded. Try again." };
  }
  return { ok: true };
}

/** Sends the invite email again to a first Admin who hasn't signed in yet (status invited). */
export async function resendFirstAdminInvite(p: { officeId: string; firmName: string }): Promise<InviteResult> {
  const me = await confirmedSuperAdmin();
  if (!me) return { ok: false, error: "Not allowed." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_invite_target", { p_office: p.officeId });
  if (error) return { ok: false, error: "Not allowed." };
  const target = data as { staff_id: string; email: string } | null;
  if (!target) return { ok: false, error: "Nobody is waiting for an invite." };
  const admin = createAdminClient();
  if (!target.email.endsWith(".test")) { // test fixtures never get email
    const { error: e2 } = await admin.auth.admin.inviteUserByEmail(target.email, { redirectTo: `${await origin()}/auth/callback`, data: { firm: p.firmName } });
    if (e2) {
      console.error("platform.reinvite_failed", { code: e2.code, status: e2.status });
      return { ok: false, error: "Could not resend the invite. Try again later." };
    }
  }
  // on the platform record like every other super admin action (IDs only)
  const { error: e3 } = await admin.from("platform_audit").insert({ admin_id: me.id, action: "staff.reinvited", office_id: p.officeId, detail: { staff_id: target.staff_id } });
  if (e3) console.error("platform.reinvite_audit_failed", { code: e3.code });
  return { ok: true };
}
