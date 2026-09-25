import "server-only";
import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/**
 * Service-role client. BYPASSES RLS. The only module allowed to read SUPABASE_SECRET_KEY
 * (enforced by ESLint). Use only for: sending invites, sign-in lockout, activating/banning
 * auth users, and writing audit rows on behalf of the system.
 */
export function createAdminClient() {
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret) throw new Error("SUPABASE_SECRET_KEY is not set");
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
