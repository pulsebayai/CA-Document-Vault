import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { logActivity } from "@/lib/activity";

/**
 * Runs after ANY successful sign-in (code, link or invite link):
 * rejects non-staff/deactivated users, activates invited staff, writes the audit trail.
 */
export async function finishSignIn(supabase: SupabaseClient, method: "code" | "link" | "invite"): Promise<"ok" | "removed"> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return "removed";
  const admin = createAdminClient();
  const { data: staff } = await admin.from("staff_user").select("id, office_id, status").eq("id", user.id).maybeSingle();
  if (!staff || staff.status === "deactivated") {
    await supabase.auth.signOut({ scope: "local" });
    return "removed";
  }
  if (staff.status === "invited") {
    await admin.from("staff_user").update({ status: "active", activated_at: new Date().toISOString() }).eq("id", staff.id);
    await logActivity({ officeId: staff.office_id, actorId: staff.id, action: "staff.activated", entityType: "staff_user", entityId: staff.id });
  }
  await logActivity({ officeId: staff.office_id, actorId: staff.id, action: "auth.signed_in", entityType: "staff_user", entityId: staff.id, data: { method } });
  return "ok";
}
