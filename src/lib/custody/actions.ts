"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";
import { custodyErrorMessage, custodySummary, isCustodyStale } from "./messages";

// Feature 13 — Mark in office / Ready to dispatch (spec AC-1 … AC-3, AC-9) and Undo (AC-4, S3). Each action calls the
// SQL function as the signed-in user, which re-checks visibility (RLS), filing, review, returnable and archive and
// writes the history and activity rows. Errors are logged as a code + request ID only.

export type CustodyStep = "in_office" | "ready";
export type CustodyActionResult =
  | { ok: true; message: string; done: string[]; skipped: Array<{ id: string; reason: string }> }
  | { ok: false; error: string; stale: boolean };

const ids = z.array(z.uuid()).min(1).max(200);
const step = z.enum(["in_office", "ready"]);

function refresh(documentIds: string[], clientId?: string) {
  for (const id of documentIds.slice(0, 20)) revalidatePath(`/documents/${id}`);
  if (clientId && z.uuid().safeParse(clientId).success) revalidatePath(`/clients/${clientId}`);
  if (documentIds.length > 1) { revalidatePath("/documents"); revalidatePath("/clients/[id]", "page"); }
  revalidatePath("/today");
}

/** One document (page, row) or a bulk chunk of up to 200 (spec AC-9). */
export async function markCustody(input: { ids: string[]; step: CustodyStep; clientId?: string }): Promise<CustodyActionResult> {
  await requireStaff();
  const p = ids.safeParse(input?.ids);
  const s = step.safeParse(input?.step);
  if (!p.success || !s.success) return { ok: false, error: "Invalid request.", stale: false };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("set_custody", { p_ids: p.data, p_step: s.data });
  if (error) {
    console.error("custody.mark_failed", { code: error.code ?? "unknown", requestId: randomUUID() });
    return { ok: false, error: custodyErrorMessage(error.message), stale: false };
  }
  const r = data as { done: string[]; skipped: Array<{ id: string; reason: string }> };
  refresh(p.data, input.clientId);
  return { ok: true, message: custodySummary(s.data, r.done.length, r.skipped), done: r.done, skipped: r.skipped };
}

/** Ready → In office → not placed. No reason (S3); refused while in a live packet. */
export async function undoCustody(input: { id: string; clientId?: string }): Promise<{ ok: true; message: string } | { ok: false; error: string; stale: boolean }> {
  await requireStaff();
  if (!z.uuid().safeParse(input?.id).success) return { ok: false, error: "Document not found.", stale: false };
  const supabase = await createClient();
  const { error } = await supabase.rpc("undo_custody", { p_id: input.id });
  if (error) {
    console.error("custody.undo_failed", { code: error.code ?? "unknown", requestId: randomUUID() });
    if (isCustodyStale(error.message)) refresh([input.id], input.clientId);
    return { ok: false, error: custodyErrorMessage(error.message), stale: isCustodyStale(error.message) };
  }
  refresh([input.id], input.clientId);
  return { ok: true, message: "Undone." };
}
