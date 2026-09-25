import "server-only";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";

export const MAX_FAILURES = 5;
export const LOCK_MINUTES = 15;

export function emailHash(email: string): string {
  return createHash("sha256").update(email).digest("hex");
}

export async function isLocked(email: string): Promise<boolean> {
  const { data } = await createAdminClient()
    .from("login_attempt").select("locked_until").eq("email_hash", emailHash(email)).maybeSingle();
  return Boolean(data?.locked_until && new Date(data.locked_until) > new Date());
}

/** Spec AC-3: 5 wrong codes → locked for 15 minutes. */
export async function recordFailure(email: string): Promise<{ locked: boolean }> {
  const admin = createAdminClient();
  const hash = emailHash(email);
  const { data } = await admin.from("login_attempt").select("failed_count, locked_until").eq("email_hash", hash).maybeSingle();
  const expired = data?.locked_until && new Date(data.locked_until) <= new Date();
  const failed = (expired ? 0 : data?.failed_count ?? 0) + 1;
  const locked = failed >= MAX_FAILURES;
  await admin.from("login_attempt").upsert({
    email_hash: hash,
    failed_count: locked ? 0 : failed,
    locked_until: locked ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null,
    updated_at: new Date().toISOString(),
  });
  return { locked };
}

export async function clearFailures(email: string): Promise<void> {
  await createAdminClient().from("login_attempt").delete().eq("email_hash", emailHash(email));
}
