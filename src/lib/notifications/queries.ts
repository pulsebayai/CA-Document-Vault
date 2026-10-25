import "server-only";
import { createClient } from "@/lib/supabase/server";
import { notificationText, type NotificationDecision } from "@/lib/catalogue/messages";

// Feature 05 AC-13: the bell. RLS returns the signed-in staff member's own notifications only. A notification holds
// IDs and the decision; the text is built here from the type rows (names, decision comment), never stored.

export type NotificationItem = { id: string; text: string; createdAt: string; unread: boolean };
export type NotificationList = { unread: number; items: NotificationItem[] };

type Row = { id: string; kind: string; created_at: string; read_at: string | null; data: { decision: NotificationDecision; doc_type_id: string; target_id?: string; request_id?: string } };
type TypeRow = { id: string; name: string; decision_comment: string | null; doc_group: { name: string } | null };

/** Unread count for the header badge (cheap: head-only count). */
export async function unreadNotificationCount(): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase.from("notification").select("id", { count: "exact", head: true }).is("read_at", null);
  if (error) {
    console.error("notifications.count_failed", { code: error.code ?? "unknown" });
    return 0;
  }
  return count ?? 0;
}

/** The newest 20, with their text. */
export async function loadNotifications(): Promise<NotificationList> {
  const supabase = await createClient();
  const [list, unread] = await Promise.all([
    supabase.from("notification").select("id, kind, created_at, read_at, data").order("created_at", { ascending: false }).limit(20),
    unreadNotificationCount(),
  ]);
  if (list.error) {
    console.error("notifications.load_failed", { code: list.error.code ?? "unknown" });
    throw new Error("Could not load notifications.");
  }
  const rows = (list.data ?? []) as Row[];
  // 10 (D6): "files arrived" notifications name the client of the request (the recipient sent it, so can see it).
  const requestIds = [...new Set(rows.filter((r) => r.kind === "link_upload" && r.data.request_id).map((r) => r.data.request_id!))];
  const clients = new Map<string, string>();
  if (requestIds.length) {
    const { data } = await supabase.from("upload_request").select("id, client:client_id (name)").in("id", requestIds);
    for (const q of (data ?? []) as unknown as Array<{ id: string; client: { name: string } | null }>) if (q.client) clients.set(q.id, q.client.name);
  }
  const ids = [...new Set(rows.filter((r) => r.kind !== "link_upload").flatMap((r) => [r.data.doc_type_id, r.data.target_id].filter(Boolean) as string[]))];
  const types = new Map<string, TypeRow>();
  if (ids.length) {
    const { data } = await supabase.from("doc_type").select("id, name, decision_comment, doc_group:doc_group_id (name)").in("id", ids);
    for (const t of (data ?? []) as unknown as TypeRow[]) types.set(t.id, t);
  }
  return {
    unread,
    items: rows.map((r) => {
      if (r.kind === "link_upload") {
        const who = clients.get(r.data.request_id ?? "");
        return { id: r.id, createdAt: r.created_at, unread: r.read_at === null,
          text: who ? `Files arrived from ${who} through your upload link — they're on Today to review.` : "Files arrived through one of your upload links." };
      }
      const t = types.get(r.data.doc_type_id);
      const target = r.data.target_id ? types.get(r.data.target_id) : undefined;
      return {
        id: r.id, createdAt: r.created_at, unread: r.read_at === null,
        text: notificationText({
          decision: r.data.decision, name: t?.name ?? "A proposed type", groupName: (target ?? t)?.doc_group?.name ?? null,
          targetName: target?.name ?? null, comment: r.data.decision === "rejected" ? t?.decision_comment ?? null : null,
        }),
      };
    }),
  };
}
