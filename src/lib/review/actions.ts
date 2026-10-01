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
    return { ok: false, error: reviewErrorMessage(error.message), stale: isStale(error.message) };
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

export async function markNeedsCorrection(input: { id: string; clientId?: string; reason: string }): Promise<ReviewActionResult> {
  await requireStaff();
  if (!uuid.safeParse(input?.id).success) return bad("Document not found.");
  const r = validateReason(input.reason);
  if (!r.data) return bad(r.error!);
  return run("needs_correction", { p_id: input.id, p_outcome: "needs_correction", p_reason: r.data }, "review_document", input, "Marked as needing correction.");
}

export async function undoReview(input: { id: string; clientId?: string; reason: string }): Promise<ReviewActionResult> {
  const me = await requireStaff();
  if (me.role !== "admin" && me.role !== "manager") return bad(reviewErrorMessage("ROLE_REQUIRED"));
  if (!uuid.safeParse(input?.id).success) return bad("Document not found.");
  const r = validateReason(input.reason);
  if (!r.data) return bad(r.error!);
  return run("undo", { p_id: input.id, p_reason: r.data }, "undo_review", input, "Review undone — back to To review.");
}
