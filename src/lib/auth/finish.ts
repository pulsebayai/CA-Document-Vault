import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { logActivity } from "@/lib/activity";
import type { AccessState } from "./access";

/**
 * Runs after ANY successful sign-in (code, link or invite link) and decides what the user is (19, spec AC-3, AC-7):
 * - staff of a firm that isn't suspended → activates an invited member, writes the audit trail → "staff";
 * - staff of a suspended firm → signed out → "suspended" (an invite isn't activated while the firm is paused);
 * - an active super admin (outside every firm) → one platform audit row (or signed out if it can't be written) → "platform";
 * - anyone else (deactivated staff or super admin, unknown) → signed out → "none".
 */
export async function finishSignIn(supabase: SupabaseClient, method: "code" | "link" | "invite"): Promise<AccessState> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return "none";
  const admin = createAdminClient();
  const { data: staff } = await admin.from("staff_user")
    .select("id, office_id, status, office:office_id (suspended_at)").eq("id", user.id).maybeSingle();
  if (staff) {
    if (staff.status === "deactivated") return signedOut(supabase, "none");
    if ((staff.office as unknown as { suspended_at: string | null } | null)?.suspended_at) return signedOut(supabase, "suspended");
    if (staff.status === "invited") {
      await admin.from("staff_user").update({ status: "active", activated_at: new Date().toISOString() }).eq("id", staff.id);
      await logActivity({ officeId: staff.office_id, actorId: staff.id, action: "staff.activated", entityType: "staff_user", entityId: staff.id });
    }
    await logActivity({ officeId: staff.office_id, actorId: staff.id, action: "auth.signed_in", entityType: "staff_user", entityId: staff.id, data: { method } });
    return "staff";
  }
  const { data: platform } = await admin.from("platform_admin").select("id, status").eq("id", user.id).maybeSingle();
  if (platform?.status === "active") {
    const { error } = await admin.from("platform_audit").insert({ admin_id: platform.id, action: "auth.signed_in", detail: { method } });
    if (error) { // fail closed: platform access starts only once it is on the record (Y3, "log before return")
      console.error("platform.sign_in_audit_failed", { code: error.code });
      return signedOut(supabase, "none");
    }
    return "platform";
  }
  return signedOut(supabase, "none");
}

async function signedOut(supabase: SupabaseClient, state: AccessState): Promise<AccessState> {
  await supabase.auth.signOut({ scope: "local" });
  return state;
}
