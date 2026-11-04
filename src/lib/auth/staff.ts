import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Role } from "./roles";
import { AWAY_FROM_STAFF_PAGES, isAccessState } from "./access";

export type CurrentStaff = {
  id: string;
  officeId: string;
  officeName: string;
  officeBranch: string | null;
  fullName: string;
  email: string;
  role: Role;
};

/**
 * Data Access Layer: the authoritative check. Returns the signed-in *active* staff member,
 * or redirects to /login. RLS only returns the row while status = 'active', so a deactivated
 * user is rejected on their very next request (spec AC-8). 19: the row is also hidden while the firm is suspended
 * (current_office_id() is null), so a suspension locks staff out on their next request too.
 */
export const requireStaff = cache(async (): Promise<CurrentStaff> => {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) redirect("/login");

  const { data: me } = await supabase
    .from("staff_user")
    .select("id, office_id, full_name, email, role, office:office_id (name, branch)")
    .eq("id", userId)
    .eq("status", "active")
    .maybeSingle();

  if (!me) {
    // 19: not an active staff member of a working firm. Only on this refusal path: ask the database what the user is —
    // a super admin goes to /platform, a suspended firm's staff to the paused notice, anyone else to the removed notice
    // (both of those clear the session cookie first).
    const { data: state } = await supabase.rpc("my_access_state");
    redirect(AWAY_FROM_STAFF_PAGES[isAccessState(state) && state !== "staff" ? state : "none"]);
  }
  const office = me.office as unknown as { name: string; branch: string | null };
  return {
    id: me.id,
    officeId: me.office_id,
    officeName: office.name,
    officeBranch: office.branch,
    fullName: me.full_name,
    email: me.email,
    role: me.role as Role,
  };
});

/** Admin-only pages 404 for everyone else (spec AC-10). */
export async function requireAdmin(): Promise<CurrentStaff> {
  const me = await requireStaff();
  if (me.role !== "admin") notFound();
  return me;
}
