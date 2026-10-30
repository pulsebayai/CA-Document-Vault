"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";
import { validateReason } from "@/lib/validation/document";
import { isStale, reviewErrorMessage } from "./messages";

// Feature 07 step 4 — Mark reviewed (AC-1, AC-3), Needs correction (AC-2), Undo review (AC-5).
// Each action calls the SQL function as the signed-in user: it re-checks visibility (RLS), filing, archive,
// status and role, writes the history row and one activity row. Errors are logged as a code + request ID only;
// the reason text is never logged.

export type ReviewActionResult = { ok: true; message: string } | { ok: false; error: string; stale: boolean };

const uuid = z.uuid();

async function run(op: string, args: Record<string, unknown>, fn: string, ids: { id: string; clientId?: string }, ok: string): Promise<ReviewActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc(fn, args);
  if (error) {
    console.error(`review.${op}_failed`, { code: error.code ?? "unknown", requestId: randomUUID() });
    if (isStale(error.message)) refresh(ids);
    let message = reviewErrorMessage(error.message);
    if (/ALREADY_REVIEWED/.test(error.message)) {
      // Spec: "Already reviewed by <name>" — read under RLS (the user can see this document).
      const { data } = await supabase.from("document").select("reviewer:reviewed_by (full_name)").eq("id", ids.id).maybeSingle();
      const name = (data?.reviewer as unknown as { full_name: string } | null)?.full_name;
      if (name) message = `Already reviewed by ${name}. The page has been refreshed.`;
    }
    return { ok: false, error: message, stale: isStale(error.message) };
  }
  refresh(ids);
  return { ok: true, message: ok };
}

function refresh({ id, clientId }: { id: string; clientId?: string }) {
  revalidatePath(`/documents/${id}`);
  if (clientId && uuid.safeParse(clientId).success) revalidatePath(`/clients/${clientId}`);
}

const bad = (error: string): ReviewActionResult => ({ ok: false, error, stale: false });

export async function markReviewed(input: { id: string; clientId?: string }): Promise<ReviewActionResult> {
  await requireStaff();
  if (!uuid.safeParse(input?.id).success) return bad("Document not found.");
  return run("reviewed", { p_id: input.id, p_outcome: "reviewed", p_reason: null }, "review_document", input, "Marked reviewed.");
}

export async function markNeedsCorrection(input: { id: string; clientId?: string; reason: string; kind?: "file" | "details" }): Promise<ReviewActionResult> {
  await requireStaff();
  if (!uuid.safeParse(input?.id).success) return bad("Document not found.");
  const r = validateReason(input.reason);
  if (!r.data) return bad(r.error!);
  // 12 (spec AC-21): wrong file | wrong details. Sent only when given, so 07's callers keep their exact arguments.
  if (input.kind !== undefined && input.kind !== "file" && input.kind !== "details") return bad("Choose wrong file or wrong details.");
  const args = { p_id: input.id, p_outcome: "needs_correction", p_reason: r.data, ...(input.kind ? { p_kind: input.kind } : {}) };
  return run("needs_correction", args, "review_document", input, "Marked as needing correction.");
}

export async function undoReview(input: { id: string; clientId?: string; reason: string }): Promise<ReviewActionResult> {
  const me = await requireStaff();
  if (me.role === "limited") return bad(reviewErrorMessage("ROLE_REQUIRED: only Admin, Manager or Staff")); // 12 (AC-24)
  if (!uuid.safeParse(input?.id).success) return bad("Document not found.");
  const r = validateReason(input.reason);
  if (!r.data) return bad(r.error!);
  return run("undo", { p_id: input.id, p_reason: r.data }, "undo_review", input, "Review undone — back to To review.");
}
