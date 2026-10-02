import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "./db";

// Feature 08 fixtures — bulk review, Activity feed and visibility (spec AC-3, AC-5 … AC-11). Written before the
// migration (plan step 2). reset_test_office does NOT purge `activity` (append-only, by design), so tests scope
// their reads to IDs created in this run (a client, document or synthetic row of their own).
//
// Contract under test (plan step 3 implements it):
//   review_documents(p_ids uuid[]) → jsonb [{ id, result: 'reviewed'|'skipped', reason }]   (SECURITY INVOKER)
//       ≤ 200 distinct IDs (TOO_MANY otherwise, nothing changes); one entry per distinct ID, in input order.
//       Each eligible document gets exactly 07's review_document(id, 'reviewed'): status, history, activity.
//       reason ∈ already_reviewed · needs_correction · in_inbox · archived · not_found (invisible = not_found).
//   activity_feed(p jsonb) → jsonb { rows: FeedRow[], next: { at, id } | null }               (SECURITY INVOKER)
//       p: { staff_id?, client_id?, document_id?, actions?: text[], from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' (IST,
//            inclusive), before?: { at, id }, limit? (default 50, max 100) }
//       Newest first by (created_at, id). `auth.signed_in` rows only when `actions` contains it.
//       client_id matches the row's resolved client (private.activity_client). document_id matches the document's
//       own rows plus dispatch rows naming it (data.document_ids / data.document_id).
//   activity_select (replaced): Admin/Manager/Staff read the whole office; Limited read a row only when they are
//       its actor or can see its client (resolved from data.client_id, else from the entity).

export type BulkReviewResult = {
  id: string;
  result: "reviewed" | "skipped";
  reason: null | "already_reviewed" | "needs_correction" | "in_inbox" | "archived" | "not_found";
};

export type FeedRow = {
  id: number; at: string; action: string; entity_type: string; entity_id: string | null; data: Record<string, unknown>;
  actor_id: string | null; actor_name: string | null;
  client_id: string | null; client_name: string | null;
  document_id: string | null; doc_code: string | null; doc_type_name: string | null; doc_group_name: string | null;
};
export type FeedPage = { rows: FeedRow[]; next: { at: string; id: number } | null };

export async function reviewDocuments(as: SupabaseClient, ids: string[]) {
  const { data, error } = await as.rpc("review_documents", { p_ids: ids });
  return { data: data as BulkReviewResult[] | null, error: error?.message ?? null };
}

export async function feed(as: SupabaseClient, p: Record<string, unknown> = {}) {
  const { data, error } = await as.rpc("activity_feed", { p });
  return { data: data as FeedPage | null, error: error?.message ?? null };
}

export async function mustFeed(as: SupabaseClient, p: Record<string, unknown> = {}): Promise<FeedPage> {
  const { data, error } = await feed(as, p);
  if (error || !data) throw new Error(`activity_feed: ${error}`);
  return data;
}

export type NewActivity = {
  actor_id: string | null; action: string; entity_type: string; entity_id?: string | null;
  data?: Record<string, unknown>; created_at?: string;
};

/** Inserts synthetic activity rows as the service role (setup only). Returns their IDs in order. */
export async function insertActivity(officeId: string, rows: NewActivity[]): Promise<number[]> {
  const { data, error } = await adminClient().from("activity")
    .insert(rows.map((r) => ({ office_id: officeId, entity_id: null, data: {}, ...r })))
    .select("id");
  if (error) throw error;
  return (data ?? []).map((r) => Number(r.id));
}

/** Activity IDs `as` can read among `ids` (reads the table directly, as the app's RLS sees it). */
export async function visibleActivity(as: SupabaseClient, ids: number[]): Promise<number[]> {
  const { data, error } = await as.from("activity").select("id").in("id", ids);
  if (error) throw error;
  return (data ?? []).map((r) => Number(r.id)).sort((a, b) => a - b);
}
