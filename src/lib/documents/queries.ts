import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { Frequency, PeriodKind } from "@/lib/validation/catalogue";

// Spec 03 — data for Add document / Assign (AC-3, AC-15). Read as the signed-in user: RLS decides.

export type TypeOption = {
  id: string; name: string; groupId: string; groupName: string; periodKind: PeriodKind;
  /** The client's own frequency when the type is in the plan, else the master default. */
  frequency: Frequency;
  registrationKind: "gstin" | "tan" | null;
  proposed: boolean;
};
export type RegistrationOption = { id: string; kind: "gstin" | "tan"; number: string };
export type PeriodOption = { id: string; kind: Exclude<PeriodKind, "none">; code: string; label: string; fyCode: string };
export type ClientTypes = { planTypes: TypeOption[]; otherTypes: TypeOption[]; registrations: RegistrationOption[] };
export type ClientOption = { id: string; name: string; code: string };

type TypeRow = {
  id: string; name: string; doc_group_id: string; period_kind: PeriodKind; default_frequency: Frequency;
  registration_kind: "gstin" | "tan" | null; status: "approved" | "proposed"; proposed_for_client_id: string | null;
  doc_group: { name: string; sort: number; active: boolean } | null;
};

const byGroupThenName = (a: TypeOption & { sort: number }, b: TypeOption & { sort: number }) =>
  a.sort - b.sort || a.groupName.localeCompare(b.groupName) || a.name.localeCompare(b.name);

/**
 * AC-3: "the client's active plan types first, then Other types (every approved active type)".
 * Without a client: every approved active type (Inbox / header add).
 */
export async function typesForClient(clientId: string | null): Promise<ClientTypes> {
  const supabase = await createClient();
  const [types, plan, regs] = await Promise.all([
    supabase.from("doc_type")
      .select("id, name, doc_group_id, period_kind, default_frequency, registration_kind, status, proposed_for_client_id, doc_group:doc_group_id (name, sort, active)")
      .eq("active", true),
    clientId
      ? supabase.from("client_doc_type").select("doc_type_id, frequency").eq("client_id", clientId).eq("state", "active")
      : Promise.resolve({ data: [] as { doc_type_id: string; frequency: Frequency }[], error: null }),
    clientId
      ? supabase.from("client_registration").select("id, kind, number").eq("client_id", clientId).eq("active", true).order("number")
      : Promise.resolve({ data: [] as RegistrationOption[], error: null }),
  ]);
  const failed = [types, plan, regs].find((r) => r.error);
  if (failed) {
    console.error("documents.types_failed", { code: failed.error?.code });
    throw new Error("Could not load document types.");
  }
  const inPlan = new Map((plan.data ?? []).map((p) => [p.doc_type_id, p.frequency]));
  const all = ((types.data ?? []) as unknown as TypeRow[])
    .filter((t) => t.doc_group?.active)
    .filter((t) => t.status === "approved" || (clientId && t.proposed_for_client_id === clientId))
    .map((t) => ({
      id: t.id, name: t.name, groupId: t.doc_group_id, groupName: t.doc_group!.name, sort: t.doc_group!.sort,
      periodKind: t.period_kind, frequency: inPlan.get(t.id) ?? t.default_frequency,
      registrationKind: t.registration_kind, proposed: t.status === "proposed",
    }))
    .sort(byGroupThenName);
  const strip = (t: TypeOption & { sort: number }): TypeOption => ({
    id: t.id, name: t.name, groupId: t.groupId, groupName: t.groupName, periodKind: t.periodKind,
    frequency: t.frequency, registrationKind: t.registrationKind, proposed: t.proposed,
  });
  return {
    planTypes: all.filter((t) => inPlan.has(t.id)).map(strip),
    otherTypes: all.filter((t) => !inPlan.has(t.id) && !t.proposed).map(strip),
    registrations: (regs.data ?? []) as RegistrationOption[],
  };
}

export async function listPeriods(): Promise<PeriodOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("period")
    .select("id, kind, code, label, start_date, financial_year:financial_year_id (code)")
    .order("start_date", { ascending: false });
  if (error) throw new Error("Could not load periods.");
  return (data ?? []).map((p) => ({
    id: p.id, kind: p.kind, code: p.code, label: p.label,
    fyCode: (p.financial_year as unknown as { code: string }).code,
  }));
}

export async function listGroups(): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("doc_group").select("id, name").eq("active", true).order("sort").order("name");
  if (error) throw new Error("Could not load groups.");
  return data ?? [];
}

/** The pre-filled client (from ?client=), if the user can see it and it isn't archived. */
export async function clientOption(id: string): Promise<ClientOption | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("client").select("id, name, code, archived_at").eq("id", id).maybeSingle();
  return data && !data.archived_at ? { id: data.id, name: data.name, code: data.code } : null;
}
