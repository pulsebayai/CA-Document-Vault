import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type CurrentPlatformAdmin = { id: string; fullName: string; email: string; test: boolean };

/**
 * 19 (spec AC-3): the Platform area's check. Signed out → /login; signed in but not an active super admin (every
 * staff role, a deactivated super admin) → Not Found, so the area doesn't reveal itself to staff. The answer comes
 * from the database (platform_whoami runs require_platform_admin), the same check every platform function makes.
 */
export const requirePlatformAdmin = cache(async (): Promise<CurrentPlatformAdmin> => {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) redirect("/login");
  const { data, error } = await supabase.rpc("platform_whoami");
  if (error || !data) notFound();
  const me = data as { id: string; full_name: string; email: string; test: boolean };
  return { id: me.id, fullName: me.full_name, email: me.email, test: me.test };
});
