import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { ClientListItem } from "@/app/(app)/clients/clients-view";
import { PAGE_SIZE, type ClientSearch } from "@/lib/validation/client-search";
import type { ClientType } from "@/lib/validation/identifiers";

export type ClientSearchResult = { rows: ClientListItem[]; matched: number; total: number };
export type StaffOption = { id: string; name: string };

type Row = {
  id: string; code: string; name: string; client_type: ClientType; pan: string | null; incharge_name: string;
  groups: string[]; paused_groups: string[]; archived: boolean; total: number;
};

/**
 * Clients list (spec AC-7, AC-12). Runs as the signed-in user: search_clients is SECURITY INVOKER,
 * so a Limited user only ever gets their own clients. Errors are logged by code only (no search text: PII).
 */
export async function searchClientsAs(s: ClientSearch): Promise<ClientSearchResult> {
  const supabase = await createClient();
  const [found, active] = await Promise.all([
    supabase.rpc("search_clients", {
      p_query: s.query || null, p_client_type: s.clientType, p_incharge_id: s.inchargeId,
      p_include_archived: s.includeArchived, p_limit: PAGE_SIZE, p_offset: (s.page - 1) * PAGE_SIZE,
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
