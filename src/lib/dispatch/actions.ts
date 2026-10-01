"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";
import { istDate } from "@/lib/documents/period";
import { validateDispatch, validateReason, type DispatchInput } from "@/lib/validation/document";
import { isStale, reviewErrorMessage } from "@/lib/review/messages";
import { readyOriginalsFor, type ReadyOriginal } from "./queries";

// Feature 07 step 4 — the dispatch dialog (AC-8, AC-9) and Undo dispatch (AC-10). create_dispatch re-checks every
// original under RLS and saves the packet all-or-nothing. The recipient, courier and tracking number are personal
// or free text: they are never logged (errors log a code + request ID only).

export type ReadyResult = { ok: true; originals: ReadyOriginal[] } | { ok: false; error: string };
export type DispatchResult =
  | { ok: true; message: string }
  | { ok: false; error: string; fieldErrors: Record<string, string>; stale: boolean; originals?: ReadyOriginal[] };

const uuid = z.uuid();

/** The dialog's list: this client's ready originals (AC-8). */
export async function readyOriginals(clientId: string): Promise<ReadyResult> {
  await requireStaff();
  if (!uuid.safeParse(clientId).success) return { ok: false, error: "Client not found." };
  try {
    return { ok: true, originals: await readyOriginalsFor(clientId) };
  } catch {
    return { ok: false, error: "Couldn't load the originals. Please try again." };
  }
}

export async function createDispatch(input: DispatchInput & { latestReceivedOn?: string | null }): Promise<DispatchResult> {
  await requireStaff();
  const v = validateDispatch(input ?? {}, { today: istDate(), latestReceivedOn: input?.latestReceivedOn ?? null });
  if (!v.data) {
    return { ok: false, error: "Check the highlighted fields.", stale: false, fieldErrors: Object.fromEntries(v.errors.map((e) => [e.field, e.message])) };
  }
  const d = v.data;
  const supabase = await createClient();
  const { error } = await supabase.rpc("create_dispatch", { p: {
    client_id: d.clientId, document_ids: d.documentIds, dispatched_on: d.dispatchedOn, method: d.method,
    courier_name: d.courierName, tracking_no: d.trackingNo, recipient_name: d.recipientName,
  } });
  if (error) {
    console.error("dispatch.create_failed", { code: error.code ?? "unknown", requestId: randomUUID() });
    const stale = isStale(error.message);
    // AC-9: an ineligible original refuses the whole packet; the dialog re-lists the valid ones.
    const originals = stale ? await readyOriginalsFor(d.clientId).catch(() => undefined) : undefined;
    if (stale) refresh(d.clientId, d.documentIds);
    return { ok: false, error: reviewErrorMessage(error.message), fieldErrors: {}, stale, originals };
  }
  refresh(d.clientId, d.documentIds);
  return { ok: true, message: `Marked ${d.documentIds.length} dispatched.` };
}

export async function undoDispatchItem(input: { documentId: string; clientId?: string; reason: string }): Promise<{ ok: true; message: string } | { ok: false; error: string; stale: boolean }> {
  const me = await requireStaff();
  if (me.role !== "admin" && me.role !== "manager") return { ok: false, error: reviewErrorMessage("ROLE_REQUIRED"), stale: false };
  if (!uuid.safeParse(input?.documentId).success) return { ok: false, error: "Document not found.", stale: false };
  const r = validateReason(input.reason);
  if (!r.data) return { ok: false, error: r.error!, stale: false };
  const supabase = await createClient();
  const { error } = await supabase.rpc("undo_dispatch_item", { p_document_id: input.documentId, p_reason: r.data });
  if (error) {
    console.error("dispatch.undo_failed", { code: error.code ?? "unknown", requestId: randomUUID() });
    if (isStale(error.message)) refresh(input.clientId, [input.documentId]);
    return { ok: false, error: reviewErrorMessage(error.message), stale: isStale(error.message) };
  }
  refresh(input.clientId, [input.documentId]);
  return { ok: true, message: "Removed from the packet — back to Ready to dispatch." };
}

function refresh(clientId: string | undefined, documentIds: string[]) {
  if (clientId && uuid.safeParse(clientId).success) revalidatePath(`/clients/${clientId}`);
  for (const id of documentIds) revalidatePath(`/documents/${id}`);
}
