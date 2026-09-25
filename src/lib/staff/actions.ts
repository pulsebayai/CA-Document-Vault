"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logActivity } from "@/lib/activity";
import { normaliseEmail, ROLES, type Role } from "@/lib/auth/roles";

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

const inviteSchema = z.object({
  fullName: z.string().trim().min(1, "Enter a name.").max(120),
  email: z.email("Enter a valid email address.").transform(normaliseEmail),
  role: z.enum(ROLES),
});

function friendly(message: string | undefined): string {
  if (message?.includes("LAST_ADMIN")) return "The office must keep at least one active Admin.";
  return "Something went wrong. Please try again.";
}

/** Spec AC-5. Only Admins; creates the auth user + staff record and emails an invite. */
export async function inviteStaff(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const me = await requireAdmin();
  const parsed = inviteSchema.safeParse({ fullName: form.get("fullName"), email: form.get("email"), role: form.get("role") });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  const { fullName, email, role } = parsed.data;

  const admin = createAdminClient();
  const { data: existing } = await admin.from("staff_user").select("id").eq("email", email).maybeSingle();
  if (existing) return { ok: false, error: "This person already has an account." };

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const origin = `${h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")}://${host}`;
  // Supabase only honours redirect URLs on its allow-list (Auth → URL Configuration).
  const { data: invited, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: `${origin}/auth/callback` });
  if (error || !invited.user) {
    console.error("staff.invite_failed", { code: error?.code, status: error?.status });
    return { ok: false, error: "Could not send the invite. Please try again." };
  }
  const { error: insertError } = await admin.from("staff_user").insert({
    id: invited.user.id, office_id: me.officeId, full_name: fullName, email, role, status: "invited", invited_by: me.id,
  });
  if (insertError) return { ok: false, error: friendly(insertError.message) };

  await logActivity({ officeId: me.officeId, actorId: me.id, action: "staff.invited", entityType: "staff_user", entityId: invited.user.id, data: { role } });
  revalidatePath("/settings/users");
  return { ok: true, message: `Invite sent to ${email}.` };
}

const idSchema = z.uuid();

/** Spec AC-7. Runs as the signed-in Admin, so RLS and the last-admin trigger both apply. */
export async function changeRole(staffId: string, role: Role): Promise<ActionResult> {
  const me = await requireAdmin();
  if (!idSchema.safeParse(staffId).success || !ROLES.includes(role)) return { ok: false, error: "Invalid request." };
  const supabase = await createClient();
  const { data, error } = await supabase.from("staff_user").update({ role }).eq("id", staffId).select("id");
  if (error || !data?.length) return { ok: false, error: friendly(error?.message) };
  await logActivity({ officeId: me.officeId, actorId: me.id, action: "staff.role_changed", entityType: "staff_user", entityId: staffId, data: { role } });
  revalidatePath("/settings/users");
  return { ok: true, message: "Role updated." };
}

/** Spec AC-8. Blocks the database immediately (RLS) and bans the auth user so sessions can't refresh. */
export async function deactivateStaff(staffId: string): Promise<ActionResult> {
  const me = await requireAdmin();
  if (!idSchema.safeParse(staffId).success) return { ok: false, error: "Invalid request." };
  const supabase = await createClient();
  const { data, error } = await supabase.from("staff_user")
    .update({ status: "deactivated", deactivated_at: new Date().toISOString() }).eq("id", staffId).select("id");
  if (error || !data?.length) return { ok: false, error: friendly(error?.message) };
  await createAdminClient().auth.admin.updateUserById(staffId, { ban_duration: "876000h" });
  await logActivity({ officeId: me.officeId, actorId: me.id, action: "staff.deactivated", entityType: "staff_user", entityId: staffId });
  revalidatePath("/settings/users");
  return { ok: true, message: "Access removed." };
}

export async function reactivateStaff(staffId: string): Promise<ActionResult> {
  const me = await requireAdmin();
  if (!idSchema.safeParse(staffId).success) return { ok: false, error: "Invalid request." };
  const supabase = await createClient();
  const { data, error } = await supabase.from("staff_user")
    .update({ status: "active", deactivated_at: null }).eq("id", staffId).select("id");
  if (error || !data?.length) return { ok: false, error: friendly(error?.message) };
  await createAdminClient().auth.admin.updateUserById(staffId, { ban_duration: "none" });
  await logActivity({ officeId: me.officeId, actorId: me.id, action: "staff.reactivated", entityType: "staff_user", entityId: staffId });
  revalidatePath("/settings/users");
  return { ok: true, message: "Access restored." };
}
