import "server-only";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import type { ActivityFilters, FeedCursor } from "./filters";
import { feedArgs } from "./filters";
import type { LastActivityRow } from "./last-activity";

// Feature 08 — reads for the Activity screen and the document page's Activity card. Everything runs as the
// signed-in user: activity_feed is SECURITY INVOKER and activity_select decides which rows (AC-11).

export type FeedRow = {
  id: number; at: string; action: string; entity_type: string; entity_id: string | null; data: Record<string, unknown>;
  actor_id: string | null; actor_name: string | null;
  client_id: string | null; client_name: string | null;
  document_id: string | null; doc_code: string | null; doc_type_name: string | null; doc_group_name: string | null;
};
export type FeedPage = { rows: FeedRow[]; next: FeedCursor | null };
export type FeedResult = { ok: true; page: FeedPage } | { ok: false; error: string };

export async function loadFeed(f: ActivityFilters, before?: FeedCursor | null, limit?: number): Promise<FeedResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("activity_feed", { p: { ...feedArgs(f, before), ...(limit ? { limit } : {}) } });
  if (error || !data) {
    console.error("activity.feed_failed", { code: error?.code ?? "unknown", requestId: randomUUID() });
    return { ok: false, error: "Activity could not be loaded. Please try again." };
  }
  return { ok: true, page: data as FeedPage };
}

export type FeedOptions = {
  staff: Array<{ id: string; name: string }>;
  client: { id: string; name: string; code: string } | null;
  document: { id: string; code: string } | null;
};

/** Filter choices and the names behind the chips (under RLS: a client the user can't see shows no name). */
export async function feedOptions(f: ActivityFilters): Promise<FeedOptions> {
  const supabase = await createClient();
  const [staff, client, doc] = await Promise.all([
    supabase.from("staff_user").select("id, full_name").neq("status", "invited").order("full_name"),
    f.client ? supabase.from("client").select("id, name, code").eq("id", f.client).maybeSingle() : Promise.resolve({ data: null }),
    f.document ? supabase.from("document").select("id, doc_code").eq("id", f.document).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  return {
    staff: (staff.data ?? []).map((s) => ({ id: s.id as string, name: s.full_name as string })),
    client: client.data ? { id: client.data.id as string, name: client.data.name as string, code: client.data.code as string } : null,
    document: doc.data ? { id: doc.data.id as string, code: doc.data.doc_code as string } : null,
  };
}

// ── Feature 15: the All documents tab ────────────────────────────────────────────────────────────────────────────
/** One Last activity row per document the viewer can see an event for (document_last_activity, invoker, ≤ 50 IDs). */
export type LastActivity = LastActivityRow & { document_id: string };

export async function lastActivityAs(ids: string[]): Promise<LastActivity[]> {
  if (ids.length === 0) return [];
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("document_last_activity", { p_ids: ids });
  if (error || !data) {
    console.error("activity.last_failed", { code: error?.code ?? "unknown", requestId: randomUUID() });
    throw new Error("LAST_ACTIVITY_FAILED");
  }
  return data as LastActivity[];
}

/** An expanded row's events: the document's newest `limit` events (activity_feed's document filter, AC-7). */
export async function documentEventsAs(documentId: string, limit: number): Promise<FeedResult> {
  return loadFeed({ staff: null, client: null, document: documentId, action: null, from: null, to: null }, null, limit);
}
