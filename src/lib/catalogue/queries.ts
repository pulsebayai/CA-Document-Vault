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
      .select("id, doc_group_id, name, aliases, period_kind, default_frequency, source, used_for, ask_after_months, ask_day, overdue_after_months, overdue_day, reminders, active")
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
    active: t.active, usedBy: usedBy.get(t.id) ?? 0,
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
