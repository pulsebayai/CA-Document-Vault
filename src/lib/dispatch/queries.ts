import "server-only";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import type { DispatchMethod } from "@/lib/documents/state";

// Feature 07 AC-8 … AC-10. All reads run as the user (RLS: packets follow the client's visibility).

export type ReadyOriginal = { id: string; docCode: string; typeName: string | null; periodLabel: string | null; receivedOn: string };

/**
 * A client's originals ready to dispatch (AC-8), from search_documents' `return = ready` filter, so the dialog
 * lists exactly what the SQL calls ready. Newest received first; at most 50 (a client rarely holds more).
 */
export async function readyOriginalsFor(clientId: string): Promise<ReadyOriginal[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("search_documents", {
    p: { filters: { client_id: clientId, return: "ready" }, include_archived: false, sort: "received", page: 1, page_size: 50 },
  });
  if (error) {
    console.error("dispatch.ready_failed", { code: error.code ?? "unknown", requestId: randomUUID() });
    throw new Error("Could not load the originals.");
  }
  return ((data?.rows ?? []) as Array<{ id: string; doc_code: string; type_name: string | null; period_label: string | null; received_on: string }>)
    .map((r) => ({ id: r.id, docCode: r.doc_code, typeName: r.type_name, periodLabel: r.period_label, receivedOn: r.received_on }));
}

export type PacketItem = { documentId: string; docCode: string; removedAt: string | null };
export type Packet = {
  id: string; dispatchedOn: string; method: DispatchMethod; courierName: string | null; trackingNo: string | null;
  recipientName: string; createdBy: string; createdAt: string;
  /** This document's own item: removed (undone) or live. */
  removedAt: string | null; removedBy: string | null; removedReason: string | null;
  items: PacketItem[];
};

/** Every packet this document has been in (AC-13), newest first. The live one has removedAt = null. */
export async function packetsForDocument(documentId: string): Promise<Packet[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("dispatch_item")
    .select(`removed_at, removed_reason, remover:removed_by (full_name),
      dispatch:dispatch_id (id, dispatched_on, method, courier_name, tracking_no, recipient_name, created_at, creator:created_by (full_name),
        items:dispatch_item (removed_at, document:document_id (id, doc_code)))`)
    .eq("document_id", documentId);
  if (error) throw new Error("Could not load the dispatch details.");
  type Raw = {
    removed_at: string | null; removed_reason: string | null; remover: { full_name: string } | null;
    dispatch: { id: string; dispatched_on: string; method: DispatchMethod; courier_name: string | null; tracking_no: string | null;
      recipient_name: string; created_at: string; creator: { full_name: string } | null;
      items: Array<{ removed_at: string | null; document: { id: string; doc_code: string } | null }> };
  };
  return ((data ?? []) as unknown as Raw[])
    .map((r) => ({
      id: r.dispatch.id, dispatchedOn: r.dispatch.dispatched_on, method: r.dispatch.method, courierName: r.dispatch.courier_name,
      trackingNo: r.dispatch.tracking_no, recipientName: r.dispatch.recipient_name, createdBy: r.dispatch.creator?.full_name ?? "—",
      createdAt: r.dispatch.created_at, removedAt: r.removed_at, removedBy: r.remover?.full_name ?? null, removedReason: r.removed_reason,
      items: r.dispatch.items.filter((i) => i.document).map((i) => ({ documentId: i.document!.id, docCode: i.document!.doc_code, removedAt: i.removed_at }))
        .sort((a, b) => a.docCode.localeCompare(b.docCode)),
    }))
    .sort((a, b) => (a.removedAt === null ? -1 : b.removedAt === null ? 1 : b.createdAt.localeCompare(a.createdAt)));
}

/** "1 of 3 removed" / "Cancelled" (AC-10). */
export function packetSummary(items: PacketItem[]): string | null {
  const removed = items.filter((i) => i.removedAt).length;
  if (!removed) return null;
  return removed === items.length ? "Cancelled" : `${removed} of ${items.length} removed`;
}
