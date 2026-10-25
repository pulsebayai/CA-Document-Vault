import "server-only";
import { createClient } from "@/lib/supabase/server";
import { GST_STATES } from "@/lib/validation/gst-states";

// Feature 10 step 9 — Client › Requested (spec AC-16, AC-18). Runs as the signed-in user (RLS: the client must be
// visible). Ad-hoc items newest first, then the client's requests (links). No token, IP or address is read here.

export type LinkState = "active" | "expired" | "revoked" | "replaced";
export type RequestedItem = {
  id: string; requestId: string; createdAt: string;
  group: string; type: string; docTypeId: string; period: string | null; periodId: string | null;
  registration: string | null; registrationId: string | null;
  note: string | null; neededBy: string | null; status: "open" | "received" | "cancelled"; overdue: boolean;
  receivedOn: string | null; cancelReason: string | null;
  requester: string; requesterId: string; linkState: LinkState; files: number;
};
export type RequestSummary = {
  id: string; createdAt: string; requester: string; requesterId: string; channel: "email" | "whatsapp" | null;
  scheduled: number; adHoc: number; openItems: number; linkState: LinkState; openUntil: string; files: number;
};
export type Requested = { items: RequestedItem[]; requests: RequestSummary[]; openCount: number };

type ReqRow = { id: string; created_by: string; created_at: string; expires_at: string; revoked_at: string | null;
  replaced_by: string | null; follow_up_id: string | null; files_count: number };
type ItemRow = { id: string; request_id: string; kind: "scheduled" | "ad_hoc"; status: RequestedItem["status"]; created_at: string;
  doc_type_id: string | null; period_id: string | null; registration_id: string | null; needed_by: string | null; note: string | null;
  received_on: string | null; cancel_reason: string | null;
  doc_type: { name: string; doc_group: { name: string } } | null; period: { label: string } | null;
  registration: { kind: "gstin" | "tan"; number: string; state_code: string | null } | null; expected: { status: string } | null };

const istDay = (ts: string) => new Date(ts).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const dayBefore = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** The link's state on the office day `today` (YYYY-MM-DD): the same rule as link_request (expired from expiry day). */
export function linkStateOf(r: { expires_at: string; revoked_at: string | null; replaced_by: string | null }, today: string): LinkState {
  if (r.replaced_by) return "replaced";
  if (r.revoked_at) return "revoked";
  return today >= istDay(r.expires_at) ? "expired" : "active";
}

const regLabel = (r: ItemRow["registration"]) => !r ? null
  : r.kind === "gstin" ? `${GST_STATES[r.state_code ?? r.number.slice(0, 2)] ?? "GST"} GSTIN` : `TAN ••${r.number.slice(-4)}`;

/** The count on the Requested tab: open ad-hoc items of this client (cheap; every tab shows it). */
export async function openRequestedCount(clientId: string): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase.from("upload_request_item")
    .select("id, upload_request!inner (client_id)", { count: "exact", head: true })
    .eq("kind", "ad_hoc").eq("status", "open").eq("upload_request.client_id", clientId);
  if (error) return 0;
  return count ?? 0;
}

export async function requestedAs(clientId: string, today: string): Promise<Requested> {
  const supabase = await createClient();
  const { data: reqs, error } = await supabase.from("upload_request")
    .select("id, created_by, created_at, expires_at, revoked_at, replaced_by, follow_up_id, files_count")
    .eq("client_id", clientId).order("created_at", { ascending: false }).limit(200);
  if (error) {
    console.error("upload_links.requested_failed", { code: error.code });
    throw new Error("Could not load requested documents.");
  }
  const requests = (reqs ?? []) as ReqRow[];
  if (requests.length === 0) return { items: [], requests: [], openCount: 0 };
  const ids = requests.map((r) => r.id);
  const [items, staff, fus, docs] = await Promise.all([
    supabase.from("upload_request_item")
      .select("id, request_id, kind, status, created_at, doc_type_id, period_id, registration_id, needed_by, note, received_on, cancel_reason, "
        + "doc_type:doc_type_id (name, doc_group:doc_group_id (name)), period:period_id (label), "
        + "registration:registration_id (kind, number, state_code), expected:expected_doc_id (status)")
      .in("request_id", ids),
    supabase.from("staff_user").select("id, full_name").in("id", [...new Set(requests.map((r) => r.created_by))]),
    supabase.from("follow_up").select("id, channel").in("id", requests.flatMap((r) => (r.follow_up_id ? [r.follow_up_id] : []))),
    supabase.from("document").select("upload_request_item_id, doc_type_id")
      .eq("client_id", clientId).not("upload_request_item_id", "is", null).is("archived_at", null),
  ]);
  const failed = [items, staff, fus, docs].find((r) => r.error);
  if (failed) {
    console.error("upload_links.requested_failed", { code: failed.error?.code });
    throw new Error("Could not load requested documents.");
  }
  const names = new Map(((staff.data ?? []) as Array<{ id: string; full_name: string }>).map((s) => [s.id, s.full_name]));
  const channel = new Map(((fus.data ?? []) as Array<{ id: string; channel: string }>).map((f) => [f.id, f.channel]));
  const reqById = new Map(requests.map((r) => [r.id, r]));
  const rows = (items.data ?? []) as unknown as ItemRow[];
  // "N files" counts only documents still filed under the item's type for this client (as the item's status does).
  const files = new Map<string, number>();
  for (const d of (docs.data ?? []) as Array<{ upload_request_item_id: string; doc_type_id: string }>) {
    const it = rows.find((i) => i.id === d.upload_request_item_id);
    const counts = it && (it.kind === "scheduled" || it.doc_type_id === d.doc_type_id);
    if (counts) files.set(d.upload_request_item_id, (files.get(d.upload_request_item_id) ?? 0) + 1);
  }

  const adHoc: RequestedItem[] = rows.filter((i) => i.kind === "ad_hoc").map((i) => {
    const r = reqById.get(i.request_id)!;
    return {
      id: i.id, requestId: i.request_id, createdAt: i.created_at,
      group: i.doc_type?.doc_group.name ?? "", type: i.doc_type?.name ?? "", docTypeId: i.doc_type_id!,
      period: i.period?.label ?? null, periodId: i.period_id, registration: regLabel(i.registration), registrationId: i.registration_id,
      note: i.note, neededBy: i.needed_by, status: i.status,
      overdue: i.status === "open" && !!i.needed_by && i.needed_by < today,
      receivedOn: i.received_on, cancelReason: i.cancel_reason,
      requester: names.get(r.created_by) ?? "", requesterId: r.created_by, linkState: linkStateOf(r, today), files: files.get(i.id) ?? 0,
    };
  }).sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || b.createdAt.localeCompare(a.createdAt));

  const summaries: RequestSummary[] = requests.map((r) => {
    const its = rows.filter((i) => i.request_id === r.id);
    const open = its.filter((i) => (i.kind === "ad_hoc" ? i.status === "open" : i.expected?.status === "pending")).length;
    const ch = r.follow_up_id ? channel.get(r.follow_up_id) : null;
    return {
      id: r.id, createdAt: r.created_at, requester: names.get(r.created_by) ?? "", requesterId: r.created_by,
      channel: ch === "email" || ch === "whatsapp" ? ch : null,
      scheduled: its.filter((i) => i.kind === "scheduled").length, adHoc: its.filter((i) => i.kind === "ad_hoc").length,
      openItems: open, linkState: linkStateOf(r, today), openUntil: dayBefore(istDay(r.expires_at)), files: r.files_count,
    };
  });
  return { items: adHoc, requests: summaries, openCount: adHoc.filter((i) => i.status === "open").length };
}
