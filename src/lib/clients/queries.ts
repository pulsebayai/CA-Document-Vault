import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { ClientListItem } from "@/app/(app)/clients/clients-view";
import { PAGE_SIZE, type ClientSearch } from "@/lib/validation/client-search";
import type { ClientType } from "@/lib/validation/identifiers";

export type ClientSearchResult = { rows: ClientListItem[]; matched: number; total: number };
export type StaffOption = { id: string; name: string };

type Row = {
  id: string; code: string; name: string; client_type: ClientType; pan: string | null; incharge_name: string;
  groups: string[]; paused_groups: string[]; archived: boolean; overdue: number; due_today: number; total: number;
};

/**
 * Clients list (spec AC-7, AC-12). Runs as the signed-in user: search_clients is SECURITY INVOKER,
 * so a Limited user only ever gets their own clients. Errors are logged by code only (no search text: PII).
 */
export async function searchClientsAs(s: ClientSearch, opts: { hasOverdue?: boolean } = {}): Promise<ClientSearchResult> {
  const supabase = await createClient();
  const [found, active] = await Promise.all([
    supabase.rpc("search_clients", {
      p_query: s.query || null, p_client_type: s.clientType, p_incharge_id: s.inchargeId,
      p_include_archived: s.includeArchived, p_limit: PAGE_SIZE, p_offset: (s.page - 1) * PAGE_SIZE,
      p_has_overdue: opts.hasOverdue === true, // 04 AC-15 "Has overdue" chip (POST body only)
      p_mine: s.mine === true, // 12 (AC-27): "My clients" (a filter, never access)
    }),
    supabase.from("client").select("id", { count: "exact", head: true }).is("archived_at", null),
  ]);
  if (found.error || active.error) {
    console.error("clients.search_failed", { code: (found.error ?? active.error)?.code });
    throw new Error("Could not load clients.");
  }
  const rows = (found.data ?? []) as Row[];
  return {
    rows: rows.map((r) => ({
      id: r.id, code: r.code, name: r.name, clientType: r.client_type, pan: r.pan, inchargeName: r.incharge_name,
      groups: r.groups ?? [], pausedGroups: r.paused_groups ?? [], archived: r.archived,
      overdue: Number(r.overdue ?? 0), dueToday: Number(r.due_today ?? 0),
    })),
    matched: rows.length ? Number(rows[0].total) : 0,
    total: active.count ?? 0,
  };
}

/** Incharge filter options: active staff of the office. */
export async function listStaffOptions(): Promise<StaffOption[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("staff_user").select("id, full_name").eq("status", "active").order("full_name");
  return (data ?? []).map((s) => ({ id: s.id as string, name: s.full_name as string }));
}

export type ClientDetail = {
  id: string; code: string; name: string; clientType: ClientType; pan: string | null; previousReference: string | null;
  email: string | null; mobile: string | null; inchargeId: string; inchargeName: string;
  archived: boolean; archiveReason: string | null;
  registrations: { kind: "gstin" | "tan"; number: string; stateCode: string | null }[];
  groups: { name: string; state: "active" | "paused" }[];
};

/**
 * One client, as the signed-in user may see it (RLS: a Limited user gets null for clients that aren't theirs,
 * so the page shows Not Found — AC-12). Only active registrations are returned.
 */
export async function getClient(id: string): Promise<ClientDetail | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("client")
    .select(`id, code, name, client_type, pan, previous_reference, email, mobile, incharge_id, archived_at, archive_reason,
      incharge:staff_user!client_incharge_id_fkey(full_name),
      client_registration(kind, number, state_code, active),
      client_group(state, doc_group(name, sort))`)
    .eq("id", id).maybeSingle();
  if (error) {
    console.error("clients.get_failed", { code: error.code });
    throw new Error("Could not load the client.");
  }
  if (!data) return null;
  type Embedded = {
    incharge: { full_name: string } | null;
    client_registration: { kind: "gstin" | "tan"; number: string; state_code: string | null; active: boolean }[];
    client_group: { state: "active" | "paused" | "removed"; doc_group: { name: string; sort: number } | null }[];
  };
  const e = data as unknown as Embedded;
  return {
    id: data.id, code: data.code, name: data.name, clientType: data.client_type as ClientType, pan: data.pan,
    previousReference: data.previous_reference, email: data.email, mobile: data.mobile, inchargeId: data.incharge_id,
    inchargeName: e.incharge?.full_name ?? "", archived: data.archived_at !== null, archiveReason: data.archive_reason,
    registrations: e.client_registration.filter((r) => r.active)
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.number.localeCompare(b.number))
      .map((r) => ({ kind: r.kind, number: r.number, stateCode: r.state_code })),
    groups: e.client_group.filter((g) => g.state !== "removed" && g.doc_group)
      .sort((a, b) => a.doc_group!.sort - b.doc_group!.sort)
      .map((g) => ({ name: g.doc_group!.name, state: g.state as "active" | "paused" })),
  };
}

export type GroupOption = { id: string; name: string; enabledForNewClients: boolean };

/** Active groups for the Add client form; "Enabled for new clients" decides which start ticked (AC-8). */
export async function listGroupOptions(): Promise<GroupOption[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("doc_group").select("id, name, enabled_for_new_clients").eq("active", true).order("sort").order("name");
  return (data ?? []).map((g) => ({ id: g.id as string, name: g.name as string, enabledForNewClients: g.enabled_for_new_clients as boolean }));
}
