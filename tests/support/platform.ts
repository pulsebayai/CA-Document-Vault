import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, signedInClient } from "./db";
import { testEmail } from "./test-data";

// Feature 19 — super admin fixtures. A test super admin has a `.test` email, so the database lets it touch test
// offices only (and a real super admin real offices only): fixtures can never reach a real firm on staging/prod.

/** Get-or-create a super admin (service role, as the operator script does) and reset it to `status`. */
export async function createPlatformAdmin(label: string, status: "active" | "deactivated" = "active") {
  const admin = adminClient();
  const email = testEmail(label);
  const { data: existing } = await admin.from("platform_admin").select("id").eq("email", email).maybeSingle();
  let id = existing?.id as string | undefined;
  if (!id) {
    const { data: found } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    id = found?.users.find((u) => u.email === email)?.id;
    if (!id) {
      const { data: u, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
      if (error) throw error;
      id = u.user.id;
    }
    const { error: e2 } = await admin.from("platform_admin").insert({ id, email, full_name: `Test ${label}`, status: "active" });
    if (e2) throw e2;
  }
  await admin.auth.admin.updateUserById(id, { ban_duration: "none" });
  const { error: e3 } = await admin.from("platform_admin").update({ status }).eq("id", id);
  if (e3) throw e3;
  return { id, email };
}

export async function signedInPlatformAdmin(label: string): Promise<{ id: string; email: string; as: SupabaseClient }> {
  const u = await createPlatformAdmin(label);
  return { ...u, as: await signedInClient(u.email) };
}

/** Every platform function and a harmless argument set for it (calls only need to reach the caller check). */
export const PLATFORM_FUNCTIONS: Record<string, (office: string, other: string) => Record<string, unknown>> = {
  platform_whoami: () => ({}),
  platform_firms: () => ({}),
  platform_create_firm: () => ({ p: { name: "e2e office platform probe", branch: null } }),
  platform_record_first_admin: (o) => ({ p_office: o, p_user: "00000000-0000-0000-0000-000000000000", p_name: "X", p_email: "x@example.test" }),
  platform_invite_target: (o) => ({ p_office: o }),
  platform_suspend_firm: (o) => ({ p_office: o, p_reason: "probe — must be refused" }),
  platform_reactivate_firm: (o) => ({ p_office: o }),
  platform_open_access: (o) => ({ p_office: o, p_reason: "probe — must be refused" }),
  platform_close_access: () => ({ p_access: "00000000-0000-0000-0000-000000000000" }),
  platform_clients: (o) => ({ p_office: o, p_query: null, p_page: 1 }),
  platform_client: (o, c) => ({ p_office: o, p_client: c }),
  platform_documents: (o) => ({ p_office: o, p_client: null, p_page: 1 }),
  platform_document: (o, d) => ({ p_office: o, p_document: d }),
  platform_expected: (o, c) => ({ p_office: o, p_client: c, p_page: 1 }),
  platform_activity: (o) => ({ p_office: o, p_page: 1 }),
  platform_audit_list: () => ({ p: {} }),
};
