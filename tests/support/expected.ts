import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "./db";

// Feature 04 fixtures — expected documents (spec AC-1 … AC-18). Written before the migration (plan step 1).
//
// Contract under test (plan step 2 implements it):
//   run_expected_generation(p_as_of date) → { created, linked }
//       Admin, is_test office only. Sets the office's test clock (office.test_today = p_as_of) and runs the
//       daily job for the caller's office as of that date (FY auto-create, generation, back-link, one
//       `expected.generated` activity row with actor null). Every 04 rule in that office — plan-change
//       triggers, auto-waives, start-period defaults — uses the test clock until reset_test_office clears it.
//       Real offices always use today in India (deviation D1: the clock persists per test office, because
//       plan changes arrive in separate requests and must see the same "today" as the generation run).
//   waive_expected(p_id uuid, p_reason text) · undo_waive_expected(p_id uuid) · reopen_expected(p_id uuid) → void
//   collection_metric(p_from date, p_to date) → { due, on_time, late, missing, on_time_pct, overdue_now,
//       last_generated_at, groups: [{ doc_group_id, name, due, on_time, late, missing }] }  (Admin/Manager)
//   expected_job_info() → { jobname, schedule, active } | null   (service role only; reads cron.job)
//   table expected_doc (spec "Data model changes"); column document.expected_doc_id.

export type Expected = {
  id: string; office_id: string; client_id: string; client_doc_type_id: string; doc_type_id: string;
  period_id: string; registration_id: string | null; ask_on: string; overdue_from: string;
  status: "pending" | "received" | "waived"; received_on: string | null; completed_by_document_id: string | null;
  waived_reason: string | null; waived_code: string | null; waived_by: string | null; waived_at: string | null;
  reopened_at: string | null; period: { code: string }; doc_type: { name: string };
};

/** Runs the daily job for the admin's test office as of `asOf` (and sets the office's test clock). */
export async function generateAsOf(admin: SupabaseClient, asOf: string) {
  const { data, error } = await admin.rpc("run_expected_generation", { p_as_of: asOf });
  if (error) throw new Error(error.message);
  return data as { created: number; linked: number };
}

/** Every expected document of a client, as the service role sees them (setup/expectations only). */
export async function expectedFor(clientId: string): Promise<Expected[]> {
  const { data, error } = await adminClient().from("expected_doc")
    .select("*, period:period_id(code), doc_type:doc_type_id(name)").eq("client_id", clientId);
  if (error) throw error;
  return (data ?? []) as unknown as Expected[];
}

/** One client's items of one type (by name), sorted by period code. */
export async function expectedOf(clientId: string, typeName: string) {
  return (await expectedFor(clientId)).filter((e) => e.doc_type.name === typeName)
    .sort((a, b) => a.period.code.localeCompare(b.period.code) || String(a.registration_id).localeCompare(String(b.registration_id)));
}

/** The single item for client × type × period code (× registration). Throws if absent or ambiguous. */
export async function expectedItem(clientId: string, typeName: string, periodCode: string, registrationId: string | null = null) {
  const rows = (await expectedOf(clientId, typeName)).filter((e) => e.period.code === periodCode && e.registration_id === registrationId);
  if (rows.length !== 1) throw new Error(`expected 1 item for ${typeName} ${periodCode}, found ${rows.length}`);
  return rows[0];
}

/** The plan row (client_doc_type) of a client's type, by type name. */
export async function planRow(clientId: string, typeName: string) {
  const { data, error } = await adminClient().from("client_doc_type")
    .select("id, state, client_group_id, start_period_id, doc_type:doc_type_id!inner(name)")
    .eq("client_id", clientId).eq("doc_type.name", typeName).single();
  if (error) throw error;
  return data as unknown as { id: string; state: string; client_group_id: string; start_period_id: string | null };
}

export async function periodCode(periodId: string | null) {
  if (!periodId) return null;
  const { data, error } = await adminClient().from("period").select("code").eq("id", periodId).single();
  if (error) throw error;
  return data.code as string;
}

/** Activity rows written by 04 for an office (optionally one entity), oldest first. */
export async function expectedActivity(officeId: string, entityId?: string) {
  let q = adminClient().from("activity").select("action, actor_id, entity_type, entity_id, data, created_at")
    .eq("office_id", officeId).like("action", "expected.%");
  if (entityId) q = q.eq("entity_id", entityId);
  const { data, error } = await q.order("id");
  if (error) throw error;
  return data as Array<{ action: string; actor_id: string | null; entity_type: string; entity_id: string; data: Record<string, unknown>; created_at: string }>;
}

/** Names of the plan types 04 schedules in the seeded catalogue (as used by the tests). */
export const T = {
  sales: "Sales invoices / sales register", // monthly, GSTIN, +1/1 · +1/5
  purchase: "Purchase invoices / purchase register", // monthly, GSTIN, +1/1 · +1/10
  notes: "Credit / debit notes issued and received", // monthly, GSTIN
  eway: "E-way bills", // as needed
  notice: "GST notice / order received", // as needed
  salaryTds: "Salary paid to employees (for TDS)", // monthly, TAN, +1/1 · +1/3
  form16: "Form 16 from employer", // yearly, +2/16 · +3/10
  form16a: "Form 16A from deductors", // quarterly, +2/1 · +2/20
  bank: "Bank statement", // monthly, +1/1 · +1/7
  gstReturns: "GST returns filed & acknowledgements", // firm record
} as const;
