import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

type ActivityInput = {
  officeId: string;
  actorId: string | null;
  action: string; // e.g. "staff.invited", "auth.signed_in"
  entityType: string;
  entityId?: string | null;
  data?: Record<string, unknown>; // never put PAN/GSTIN/phone here
};

/** Append-only audit trail (spec AC-11). Written server-side so it cannot be skipped by the browser. */
export async function logActivity(a: ActivityInput): Promise<void> {
  const { error } = await createAdminClient().from("activity").insert({
    office_id: a.officeId,
    actor_id: a.actorId,
    action: a.action,
    entity_type: a.entityType,
    entity_id: a.entityId ?? null,
    data: a.data ?? {},
  });
  if (error) console.error("activity.insert_failed", { action: a.action, code: error.code });
}
