import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "./db";
import { testOfficeName } from "./test-data";

// Feature 02 fixtures. Each DB test file owns one "e2e office …" (per lane) with office.is_test = true.
// reset_test_office (service role only, refuses non-test offices) wipes its clients/plans and
// re-seeds catalogue + FYs, so every run starts from the same state (plan decision D2).

/** Get-or-create a test office flagged is_test, then reset it to the seeded state. */
export async function createCatalogueOffice(label: string, opts: { isTest?: boolean; reset?: boolean } = {}): Promise<string> {
  const { isTest = true, reset = true } = opts;
  const admin = adminClient();
  const name = testOfficeName(label);
  const { data: found, error: e0 } = await admin.from("office").select("id, is_test").eq("name", name).maybeSingle();
  if (e0) throw e0;
  let id = found?.id as string | undefined;
  if (!id) {
    const { data, error } = await admin.from("office").insert({ name, branch: "test", is_test: isTest }).select("id").single();
    if (error) throw error;
    id = data.id as string;
  } else if (found!.is_test !== isTest) {
    const { error } = await admin.from("office").update({ is_test: isTest }).eq("id", id);
    if (error) throw error;
  }
  if (isTest && reset) await resetTestOffice(id);
  return id;
}

export async function resetTestOffice(officeId: string) {
  const { error } = await adminClient().rpc("reset_test_office", { p_office_id: officeId });
  if (error) throw error;
}

export async function groupId(officeId: string, name: string): Promise<string> {
  const { data, error } = await adminClient().from("doc_group").select("id").eq("office_id", officeId).eq("name", name).single();
  if (error) throw error;
  return data.id as string;
}

/** Master types of a group as the service role sees them (setup/expectations only). */
export async function masterTypes(officeId: string, group: string) {
  const gid = await groupId(officeId, group);
  const { data, error } = await adminClient().from("doc_type")
    .select("id, name, source, active, default_frequency, ask_after_months, ask_day, overdue_after_months, overdue_day, reminders")
    .eq("doc_group_id", gid);
  if (error) throw error;
  return data!;
}

type NewClient = {
  name: string; client_type: string; incharge_id: string; pan?: string | null;
  previous_reference?: string | null; email?: string | null; mobile?: string | null;
};

/** Insert a client as `as` (RLS applies). Returns the row or the error. */
export async function insertClient(as: SupabaseClient, officeId: string, c: NewClient) {
  return as.from("client").insert({ office_id: officeId, ...c }).select("id, code, pan, incharge_id").single();
}

export async function mustInsertClient(as: SupabaseClient, officeId: string, c: NewClient) {
  const { data, error } = await insertClient(as, officeId, c);
  if (error) throw error;
  return data!;
}

/** Postgres errors that mean "the database said no" (RLS, grants, checks, triggers, unique). */
export const DENIED = /row-level security|permission denied|violates|ROLE_REQUIRED|NO_DELETE|NOT_TEST_OFFICE|duplicate key/i;

// ── Feature 05: type governance (additions only) ──────────────────────────────
// Written before 05's migrations (plan step 1). Contract under test (plan step 2 implements it).
// An "item" = the pending proposed rows sharing (doc_group_id, lower(name)); a function given any row resolves the item.
// Its "survivor" is the earliest-created row.
//
//   proposal_queue() → { waiting: int, items: QueueItem[] }  oldest first                     (Admin/Manager)
//   preview_type_decision(p jsonb { action: 'approve'|'merge', type_id, target_id?, edits? })
//       → { documents, clients, plan_added, received, conflicts: [{ document_id, doc_code }] }  (Admin/Manager; no writes)
//   approve_proposed_type(p jsonb { type_id, edits?, comment? }) → { type_id }                 (the approved type)
//       edits = 02's add-type fields: name, aliases, doc_group_id, period_kind, default_frequency, ask_after_months,
//       ask_day, overdue_after_months, overdue_day, registration_kind, reminders.
//   merge_proposed_type(p_type uuid, p_target uuid, p_comment text) → { documents, clients, plan_added, received }
//   reject_proposed_type(p_type uuid, p_comment text) → void
//   mark_notifications_read() → int (rows marked)
//   catalogue_metric() → { approved, total, approved_pct, waiting, oldest_days }               (Admin/Manager)
//   doc_type: status += mapped | rejected; mapped_to_id, decided_by, decided_at, decision_comment (≤ 500).
//   notification (id, office_id, recipient_id, kind, entity_type, entity_id, data, created_at, read_at):
//       data = { decision: 'approved'|'merged'|'rejected', doc_type_id: <survivor>, target_id? } — IDs only.
//   activity: doc_type.approved / .merged / .rejected (entity = the survivor; data: doc_type_ids, target_id?,
//       documents, clients, plan_rows) + document.type_merged per moved document (client_id, from_type_id, to_type_id).
// Errors: ROLE_REQUIRED · ALREADY_DECIDED · DUPLICATE_TYPE · PERIOD_KIND · HAS_DOCUMENTS · REASON_REQUIRED ·
//         TARGET_INVALID · COMMENT_TOO_LONG.

export type QueueItem = {
  type_id: string; type_ids: string[]; name: string; doc_group_id: string; group_name: string;
  proposed_by: string[]; proposed_at: string; client_count: number; clients: Array<{ id: string; name: string }>;
  document_count: number;
};
export type Queue = { waiting: number; items: QueueItem[] };
export type DecisionCounts = { documents: number; clients: number; plan_added: number; received: number };
export type Preview = DecisionCounts & { conflicts: Array<{ document_id: string; doc_code: string }> };
export type TypeEdits = Partial<{
  name: string; aliases: string[]; doc_group_id: string; period_kind: string; default_frequency: string;
  ask_after_months: number | null; ask_day: number | null; overdue_after_months: number | null; overdue_day: number | null;
  registration_kind: string | null; reminders: boolean;
}>;
type Res<T> = { data: T | null; error: { message: string } | null };

export async function proposeType(as: SupabaseClient, clientId: string, groupIdValue: string, name: string): Promise<string> {
  const { data, error } = await as.rpc("create_proposed_type", { p_client_id: clientId, p_doc_group_id: groupIdValue, p_name: name });
  if (error) throw new Error(error.message);
  return (data as { doc_type_id: string }).doc_type_id;
}

export const proposalQueue = (as: SupabaseClient) => as.rpc("proposal_queue") as unknown as Promise<Res<Queue>>;
export const previewDecision = (as: SupabaseClient, p: { action: "approve" | "merge"; type_id: string; target_id?: string; edits?: TypeEdits }) =>
  as.rpc("preview_type_decision", { p }) as unknown as Promise<Res<Preview>>;
export const approveType = (as: SupabaseClient, p: { type_id: string; edits?: TypeEdits; comment?: string | null }) =>
  as.rpc("approve_proposed_type", { p }) as unknown as Promise<Res<{ type_id: string }>>;
export const mergeType = (as: SupabaseClient, type: string, target: string, comment: string | null = null) =>
  as.rpc("merge_proposed_type", { p_type: type, p_target: target, p_comment: comment }) as unknown as Promise<Res<DecisionCounts>>;
export const rejectType = (as: SupabaseClient, type: string, comment: string | null) =>
  as.rpc("reject_proposed_type", { p_type: type, p_comment: comment }) as unknown as Promise<Res<null>>;

export async function mustOk<T>(p: Promise<Res<T>>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data as T;
}

/** A doc_type row as the service role sees it (setup/expectations only). */
export async function typeRow(id: string) {
  const { data, error } = await adminClient().from("doc_type").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Record<string, unknown> & {
    id: string; name: string; doc_group_id: string; status: string; active: boolean; aliases: string[];
    proposed_by: string | null; proposed_for_client_id: string | null; mapped_to_id: string | null;
    decided_by: string | null; decided_at: string | null; decision_comment: string | null; period_kind: string;
    default_frequency: string; reminders: boolean;
  };
}

/** Notifications as the service role sees them, for one recipient. */
export async function notificationsOf(recipientId: string) {
  const { data, error } = await adminClient().from("notification").select("*").eq("recipient_id", recipientId).order("created_at");
  if (error) throw error;
  return data as Array<{ id: string; office_id: string; recipient_id: string; kind: string; entity_type: string; entity_id: string;
    data: { decision: string; doc_type_id: string; target_id?: string }; created_at: string; read_at: string | null }>;
}
