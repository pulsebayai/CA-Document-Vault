"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";
import { logActivity } from "@/lib/activity";
import { changedFields, officeSchema } from "./schema";

export type OfficeResult =
  | { ok: true; message: string }
  | { ok: false; error: string; fieldErrors: Partial<Record<"name" | "branch", string>> };

/**
 * Feature 17 (spec AC-9–11). Runs as the signed-in Admin, so the database decides: the policy allows only an Admin's
 * own office, and the column grant only name and branch. One activity row with the changed field names.
 */
export async function saveOffice(_prev: OfficeResult | null, form: FormData): Promise<OfficeResult> {
  const me = await requireAdmin();
  const parsed = officeSchema.safeParse({ name: String(form.get("name") ?? ""), branch: String(form.get("branch") ?? "") });
  if (!parsed.success) {
    const fieldErrors: Partial<Record<"name" | "branch", string>> = {};
    for (const i of parsed.error.issues) {
      const k = i.path[0] as "name" | "branch";
      fieldErrors[k] ??= i.message;
    }
    return { ok: false, error: "Check the highlighted fields.", fieldErrors };
  }
  const next = parsed.data;
  const before = { name: me.officeName, branch: me.officeBranch };
  const fields = changedFields(before, next);
  if (fields.length === 0) return { ok: true, message: "No changes." };

  const supabase = await createClient();
  const { data, error } = await supabase.from("office").update(next).eq("id", me.officeId).select("id");
  if (error || !data?.length) {
    console.error("office.save_failed", { code: error?.code });
    return { ok: false, error: "Couldn't save. Please try again.", fieldErrors: {} };
  }
  await logActivity({ officeId: me.officeId, actorId: me.id, action: "office.updated", entityType: "office", entityId: me.officeId, data: { fields } });
  revalidatePath("/", "layout"); // the header shows the firm's name on every page
  return { ok: true, message: "Saved." };
}
