import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { DocSource, Frequency, PeriodKind } from "@/lib/validation/catalogue";

export type CatalogueType = {
  id: string;
  docGroupId: string;
  name: string;
  aliases: string[];
  periodKind: PeriodKind;
  defaultFrequency: Frequency;
  source: DocSource;
  usedFor: string | null;
  askAfterMonths: number | null;
  askDay: number | null;
  overdueAfterMonths: number | null;
  overdueDay: number | null;
  reminders: boolean;
  active: boolean;
  usedBy: number;
  preferredFormats?: string[] | null; // 11 (optional: existing callers and tests build types without it)
};

export type CatalogueGroup = {
  id: string;
  name: string;
  sort: number;
  active: boolean;
  enabledForNewClients: boolean;
  types: CatalogueType[]; // client documents only
};

export type FinancialYearRow = { id: string; code: string; startDate: string; endDate: string };

export type Catalogue = {
  groups: CatalogueGroup[];
  firmRecords: (CatalogueType & { groupName: string })[];
  years: FinancialYearRow[];
};

type TypeRow = {
  id: string; doc_group_id: string; name: string; aliases: string[]; period_kind: PeriodKind; default_frequency: Frequency;
  source: DocSource; used_for: string | null; ask_after_months: number | null; ask_day: number | null;
  overdue_after_months: number | null; overdue_day: number | null; reminders: boolean; active: boolean;
  preferred_formats: string[] | null;
};

/**
 * Settings › Document catalogue (spec AC-1). Reads as the signed-in user, so RLS decides what is visible;
 * "Used by" comes from the security-invoker view doc_type_usage. Only approved types — proposed types arrive with 05.
 */
export async function loadCatalogue(): Promise<Catalogue> {
  const supabase = await createClient();
  const [groups, types, usage, years] = await Promise.all([
    supabase.from("doc_group").select("id, name, sort, active, enabled_for_new_clients").order("sort").order("name"),
    supabase.from("doc_type")
      .select("id, doc_group_id, name, aliases, period_kind, default_frequency, source, used_for, ask_after_months, ask_day, overdue_after_months, overdue_day, reminders, active, preferred_formats")
      .eq("status", "approved").order("active", { ascending: false }).order("created_at").order("name"),
    supabase.from("doc_type_usage").select("doc_type_id, clients"),
    supabase.from("financial_year").select("id, code, start_date, end_date").order("start_date"),
  ]);
  const failed = [groups, types, usage, years].find((r) => r.error);
  if (failed?.error) {
    console.error("catalogue.load_failed", { code: failed.error.code });
    throw new Error("Could not load the catalogue.");
  }

  const usedBy = new Map((usage.data ?? []).map((u) => [u.doc_type_id as string, u.clients as number]));
  const toType = (t: TypeRow): CatalogueType => ({
    id: t.id, docGroupId: t.doc_group_id, name: t.name, aliases: t.aliases ?? [], periodKind: t.period_kind,
    defaultFrequency: t.default_frequency, source: t.source, usedFor: t.used_for, askAfterMonths: t.ask_after_months,
    askDay: t.ask_day, overdueAfterMonths: t.overdue_after_months, overdueDay: t.overdue_day, reminders: t.reminders,
    active: t.active, usedBy: usedBy.get(t.id) ?? 0, preferredFormats: t.preferred_formats ?? null,
  });
  const all = (types.data as TypeRow[]).map(toType);
  const groupRows = (groups.data ?? []).map((g) => ({
    id: g.id as string, name: g.name as string, sort: g.sort as number, active: g.active as boolean,
    enabledForNewClients: g.enabled_for_new_clients as boolean,
    types: all.filter((t) => t.docGroupId === g.id && t.source === "client"),
  }));
  // Active groups first (in their sort order), inactive ones at the end.
  groupRows.sort((a, b) => Number(b.active) - Number(a.active));
  const groupName = new Map(groupRows.map((g) => [g.id, g.name]));

  return {
    groups: groupRows,
    firmRecords: all.filter((t) => t.source === "firm").map((t) => ({ ...t, groupName: groupName.get(t.docGroupId) ?? "" })),
    years: (years.data ?? []).map((y) => ({ id: y.id as string, code: y.code as string, startDate: y.start_date as string, endDate: y.end_date as string })),
  };
}

// ── Feature 05 AC-1: the decision queue — one item per group + name (proposal_queue, Admin/Manager only) ──
export type ProposalItem = {
  typeId: string; // the survivor (earliest row); any row of the item resolves it
  typeIds: string[];
  name: string;
  groupId: string;
  groupName: string;
  proposedBy: string[]; // staff names
  proposedAt: string;
  clientCount: number;
  clients: Array<{ id: string; name: string }>;
  documentCount: number;
};
export type ProposalQueue = { waiting: number; items: ProposalItem[] };

type QueueRow = {
  type_id: string; type_ids: string[]; name: string; doc_group_id: string; group_name: string; proposed_by: string[];
  proposed_at: string; client_count: number; clients: Array<{ id: string; name: string }>; document_count: number;
};

export async function loadProposalQueue(): Promise<ProposalQueue> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("proposal_queue");
  if (error) {
    console.error("catalogue.queue_failed", { code: error.code ?? "unknown" });
    throw new Error("Could not load proposed types.");
  }
  const q = data as { waiting: number; items: QueueRow[] };
  const staffIds = [...new Set(q.items.flatMap((i) => i.proposed_by))];
  const names = new Map<string, string>();
  if (staffIds.length) {
    const { data: staff } = await supabase.from("staff_user").select("id, full_name").in("id", staffIds);
    for (const s of staff ?? []) names.set(s.id as string, s.full_name as string);
  }
  return {
    waiting: q.waiting,
    items: q.items.map((i) => ({
      typeId: i.type_id, typeIds: i.type_ids, name: i.name, groupId: i.doc_group_id, groupName: i.group_name,
      proposedBy: i.proposed_by.map((id) => names.get(id) ?? "—"), proposedAt: i.proposed_at,
      clientCount: i.client_count, clients: i.clients, documentCount: i.document_count,
    })),
  };
}

// ── Feature 05 AC-16: metric 3 (catalogue convergence) + queue age, for Settings › Collection ──
export type CatalogueMetric = { approved: number; total: number; approvedPct: number | null; waiting: number; oldestDays: number | null };

export async function catalogueMetricAs(): Promise<CatalogueMetric> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("catalogue_metric");
  if (error) {
    console.error("catalogue.metric_failed", { code: error.code ?? "unknown" });
    throw new Error("Could not load the catalogue figure.");
  }
  const m = data as { approved: number; total: number; approved_pct: number | null; waiting: number; oldest_days: number | null };
  return { approved: m.approved, total: m.total, approvedPct: m.approved_pct, waiting: m.waiting, oldestDays: m.oldest_days };
}
