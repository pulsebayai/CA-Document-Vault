"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { canManageCatalogue } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";
import { validateDecisionComment, validateTypeEdits, type TypeEditsInput } from "@/lib/validation/catalogue";
import { decidedBy, governanceErrorMessage, isStaleDecision } from "./messages";

// Feature 05 step 3 — the decision queue's actions (spec AC-2 … AC-12). Each checks the role itself (server actions
// are reachable by direct POST), then calls one SECURITY INVOKER SQL function as the signed-in user: the database
// re-checks the role, resolves the item, locks it, and writes the activity rows and notifications. Errors are
// logged as a code + request ID only; names and comments are never logged.

export type Conflict = { documentId: string; docCode: string };
export type DecisionCounts = { documents: number; clients: number; planAdded: number; received: number };
export type GovernanceResult =
  | { ok: true; message: string; typeId?: string; counts?: DecisionCounts }
  | { ok: false; error: string; stale: boolean; fieldErrors?: Record<string, string>; conflicts?: Conflict[] };
export type PreviewResult =
  | { ok: true; counts: DecisionCounts; conflicts: Conflict[] }
  | { ok: false; error: string; stale: boolean };
export type MergeTarget = { id: string; name: string; groupName: string };

const uuid = z.uuid();
const DENIED = "Only an Admin or Manager can decide proposed types.";
const PATHS = ["/settings/catalogue", "/settings/collection"];

const bad = (error: string, extra: Partial<Extract<GovernanceResult, { ok: false }>> = {}): Extract<GovernanceResult, { ok: false }> =>
  ({ ok: false, error, stale: false, ...extra });

async function decider() {
  const me = await requireStaff();
  return canManageCatalogue(me.role) ? me : null;
}

type DbCounts = { documents: number; clients: number; plan_added: number; received: number };
const counts = (c: DbCounts): DecisionCounts => ({ documents: c.documents, clients: c.clients, planAdded: c.plan_added, received: c.received });

/** A refusal: plain message; "Already decided by <name>" when someone else decided first (AC-11). */
async function failure(op: string, error: { code?: string; message: string }, supabase: Awaited<ReturnType<typeof createClient>>) {
  console.error(`governance.${op}_failed`, { code: error.code ?? "unknown", requestId: randomUUID() });
  const stale = isStaleDecision(error.message);
  if (stale) refresh();
  let message = governanceErrorMessage(error.message);
  const by = decidedBy(error.message);
  if (by) {
    const { data } = await supabase.from("staff_user").select("full_name").eq("id", by).maybeSingle();
    if (data?.full_name) message = `Already decided by ${data.full_name}. The list has been refreshed.`;
  }
  return bad(message, { stale });
}

function refresh() {
  for (const p of PATHS) revalidatePath(p);
}

/** AC-8 / AC-7 / AC-3: what Approve or Merge would do. Period conflicts come back as a list, not an error. */
export async function previewDecision(input: {
  action: "approve" | "merge"; typeId: string; targetId?: string; edits?: TypeEditsInput;
}): Promise<PreviewResult> {
  const me = await decider();
  if (!me) return { ok: false, error: DENIED, stale: false };
  if (!["approve", "merge"].includes(input?.action) || !uuid.safeParse(input.typeId).success) return { ok: false, error: "Invalid request.", stale: false };
  if (input.action === "merge" && !uuid.safeParse(input.targetId).success) return { ok: false, error: "Choose a type to merge into.", stale: false };
  let edits: Record<string, unknown> | undefined;
  if (input.edits) {
    const v = validateTypeEdits(input.edits);
    if (!v.data) return { ok: false, error: "Please fix the highlighted fields.", stale: false };
    edits = v.data;
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("preview_type_decision", {
    p: { action: input.action, type_id: input.typeId, target_id: input.targetId ?? null, ...(edits ? { edits } : {}) },
  });
  if (error) {
    const f = await failure("preview", error, supabase);
    return { ok: false, error: f.error, stale: f.stale };
  }
  const d = data as DbCounts & { conflicts: Array<{ document_id: string; doc_code: string }> };
  return { ok: true, counts: counts(d), conflicts: d.conflicts.map((c) => ({ documentId: c.document_id, docCode: c.doc_code })) };
}

async function conflictsFor(supabase: Awaited<ReturnType<typeof createClient>>, p: Record<string, unknown>): Promise<Conflict[]> {
  const { data } = await supabase.rpc("preview_type_decision", { p });
  return ((data as { conflicts?: Array<{ document_id: string; doc_code: string }> } | null)?.conflicts ?? [])
    .map((c) => ({ documentId: c.document_id, docCode: c.doc_code }));
}

/** AC-2: approve as proposed (the item's other rows are merged into the earliest one). */
export async function approveProposedType(input: { typeId: string; comment?: string }): Promise<GovernanceResult> {
  const me = await decider();
  if (!me) return bad(DENIED);
  if (!uuid.safeParse(input?.typeId).success) return bad("Not found — it may have been decided or removed.");
  const c = validateDecisionComment(input.comment, false);
  if (c.error) return bad(c.error, { fieldErrors: { comment: c.error } });
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("approve_proposed_type", { p: { type_id: input.typeId, comment: c.data } });
  if (error) return failure("approve", error, supabase);
  refresh();
  const d = data as DbCounts & { type_id: string };
  return { ok: true, message: "Approved. It is now offered for every client.", typeId: d.type_id, counts: counts(d) };
}

/** AC-3 / AC-4: approve with 02's add-type fields; a period that doesn't fit lists the documents (AC-3). */
export async function editAndApproveType(input: { typeId: string; edits: TypeEditsInput; comment?: string }): Promise<GovernanceResult> {
  const me = await decider();
  if (!me) return bad(DENIED);
  if (!uuid.safeParse(input?.typeId).success) return bad("Not found — it may have been decided or removed.");
  const v = validateTypeEdits(input.edits ?? {});
  if (!v.data) return bad("Please fix the highlighted fields.", { fieldErrors: Object.fromEntries(v.errors.map((e) => [e.field, e.message])) });
  const c = validateDecisionComment(input.comment, false);
  if (c.error) return bad(c.error, { fieldErrors: { comment: c.error } });
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("approve_proposed_type", { p: { type_id: input.typeId, edits: v.data, comment: c.data } });
  if (error) {
    if (/PERIOD_KIND/.test(error.message)) {
      const conflicts = await conflictsFor(supabase, { action: "approve", type_id: input.typeId, edits: v.data });
      console.error("governance.edit_approve_failed", { code: error.code ?? "unknown", requestId: randomUUID() });
      return bad(periodMessage(conflicts.length, v.data.period_kind), { conflicts });
    }
    return failure("edit_approve", error, supabase);
  }
  refresh();
  const d = data as DbCounts & { type_id: string };
  return { ok: true, message: `Approved as “${v.data.name}”.`, typeId: d.type_id, counts: counts(d) };
}

/** AC-5 … AC-7: merge into an approved type. A period conflict refuses before anything changes and lists the documents. */
export async function mergeProposedType(input: { typeId: string; targetId: string; comment?: string }): Promise<GovernanceResult> {
  const me = await decider();
  if (!me) return bad(DENIED);
  if (!uuid.safeParse(input?.typeId).success) return bad("Not found — it may have been decided or removed.");
  if (!uuid.safeParse(input.targetId).success) return bad("Choose a type to merge into.", { fieldErrors: { targetId: "Choose a type to merge into." } });
  const c = validateDecisionComment(input.comment, false);
  if (c.error) return bad(c.error, { fieldErrors: { comment: c.error } });
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("merge_proposed_type", { p_type: input.typeId, p_target: input.targetId, p_comment: c.data });
  if (error) {
    if (/PERIOD_KIND/.test(error.message)) {
      const conflicts = await conflictsFor(supabase, { action: "merge", type_id: input.typeId, target_id: input.targetId });
      console.error("governance.merge_failed", { code: error.code ?? "unknown", requestId: randomUUID() });
      return bad(`${conflicts.length} ${conflicts.length === 1 ? "document doesn't" : "documents don't"} fit the chosen type's period. Nothing was moved.`, { conflicts });
    }
    return failure("merge", error, supabase);
  }
  refresh();
  const d = counts(data as DbCounts);
  return { ok: true, message: `Merged: ${d.documents} ${d.documents === 1 ? "document" : "documents"} moved.`, counts: d };
}

/** AC-9: reject an item with no documents; a reason of 1–500 characters is required. */
export async function rejectProposedType(input: { typeId: string; reason: string }): Promise<GovernanceResult> {
  const me = await decider();
  if (!me) return bad(DENIED);
  if (!uuid.safeParse(input?.typeId).success) return bad("Not found — it may have been decided or removed.");
  const r = validateDecisionComment(input.reason, true);
  if (r.error) return bad(r.error, { fieldErrors: { reason: r.error } });
  const supabase = await createClient();
  const { error } = await supabase.rpc("reject_proposed_type", { p_type: input.typeId, p_comment: r.data });
  if (error) return failure("reject", error, supabase);
  refresh();
  return { ok: true, message: "Rejected. The proposer has been notified." };
}

/** Merge dialog picker: approved, active, client-source types, closest to `query` first (03's trigram suggestions). */
export async function searchMergeTargets(input: { typeId: string; query: string }): Promise<MergeTarget[]> {
  const me = await decider();
  if (!me || !uuid.safeParse(input?.typeId).success) return [];
  const query = String(input.query ?? "").trim().slice(0, 120);
  const supabase = await createClient();
  const { data: item } = await supabase.from("doc_type").select("name, proposed_for_client_id").eq("id", input.typeId).maybeSingle();
  if (!item?.proposed_for_client_id) return [];
  const { data, error } = await supabase.rpc("suggest_doc_types", { p_client_id: item.proposed_for_client_id, p_query: query || item.name });
  if (error) {
    console.error("governance.targets_failed", { code: error.code ?? "unknown", requestId: randomUUID() });
    return [];
  }
  const rows = (data as Array<{ doc_type_id: string; name: string; group_name: string; status: string }>).filter((s) => s.status === "approved");
  if (!rows.length) return [];
  const { data: client } = await supabase.from("doc_type").select("id").in("id", rows.map((r) => r.doc_type_id)).eq("source", "client").eq("active", true);
  const ok = new Set((client ?? []).map((t) => t.id as string));
  return rows.filter((r) => ok.has(r.doc_type_id)).map((r) => ({ id: r.doc_type_id, name: r.name, groupName: r.group_name }));
}

const KIND_WORD: Record<string, string> = { month: "monthly", quarter: "quarterly", year: "yearly", none: "undated" };
function periodMessage(n: number, kind: string): string {
  return `${n} ${n === 1 ? "document is" : "documents are"} filed for a period a ${KIND_WORD[kind] ?? kind} type can't hold. Nothing was changed.`;
}
