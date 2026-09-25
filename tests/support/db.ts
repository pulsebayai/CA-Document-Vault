import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { RUN_TAG, testEmail } from "./test-data";

type Role = "admin" | "manager" | "staff" | "limited";
type Status = "invited" | "active" | "deactivated";

const url = () => process.env.NEXT_PUBLIC_SUPABASE_URL!;
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

/** Service-role client — tests only. Bypasses RLS; used for setup, never for assertions about access. */
export function adminClient(): SupabaseClient {
  return createClient(url(), process.env.SUPABASE_SECRET_KEY!, noSession);
}

/** A fresh, isolated office for this test file, so test users never mix with real dev users. */
export async function createTestOffice(label: string): Promise<string> {
  const { data, error } = await adminClient()
    .from("office")
    .insert({ name: `e2e office ${RUN_TAG} ${label}`.slice(0, 120), branch: "test" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

export async function createStaff(officeId: string, label: string, role: Role, status: Status = "active") {
  const admin = adminClient();
  const email = testEmail(label);
  const { data: u, error: e1 } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (e1) throw e1;
  const { error: e2 } = await admin.from("staff_user").insert({
    id: u.user.id, office_id: officeId, full_name: `Test ${label}`, email, role, status,
    activated_at: status === "active" ? new Date().toISOString() : null,
  });
  if (e2) throw e2;
  return { id: u.user.id, email };
}

/** Signs in exactly like the app does (email OTP), but gets the code from the admin API instead of an inbox. */
export async function signedInClient(email: string): Promise<SupabaseClient> {
  const { data, error } = await adminClient().auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw error;
  const client = createClient(url(), process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, noSession);
  const { error: e2 } = await client.auth.verifyOtp({ email, token: data.properties.email_otp, type: "email" });
  if (e2) throw e2;
  return client;
}

/** Test users are banned at the end of a run (rows cannot be deleted by design). */
export async function retireStaff(ids: string[]) {
  const admin = adminClient();
  for (const id of ids) {
    await admin.from("staff_user").update({ status: "deactivated", deactivated_at: new Date().toISOString() }).eq("id", id).then(() => undefined, () => undefined);
    await admin.auth.admin.updateUserById(id, { ban_duration: "876000h" });
  }
}
