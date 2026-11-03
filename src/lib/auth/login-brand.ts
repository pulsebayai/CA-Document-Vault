import "server-only";
import { tenancyMode } from "@/lib/tenancy";

// Feature 17 (spec AC-3, AC-4). What the public /login page shows above the form.
//   multi:  the platform name. Nothing is read from the database — the page runs before sign-in, so it can't know
//           the visitor's firm, and naming one firm there would show it to every other firm's staff.
//   single: the deployment's one real (non-test) office, read with the service role (the page has no session).

export const PLATFORM_NAME = "CA Document Vault";

export type LoginBrand = { name: string; branch: string | null };

export async function loginBrand(): Promise<LoginBrand> {
  if (tenancyMode() === "multi") return { name: PLATFORM_NAME, branch: null };
  // Imported only on this path, so multi-mode requests never construct the service-role client.
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data } = await createAdminClient().from("office").select("name, branch")
    .eq("is_test", false).order("created_at").limit(1).maybeSingle();
  return data ? { name: data.name, branch: data.branch ?? null } : { name: PLATFORM_NAME, branch: null };
}
