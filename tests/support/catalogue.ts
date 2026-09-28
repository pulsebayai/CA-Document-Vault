import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "./db";

// Feature 02 fixtures. Each DB test file owns one "e2e office …" with office.is_test = true.
// reset_test_office (service role only, refuses non-test offices) wipes its clients/plans and
// re-seeds catalogue + FYs, so every run starts from the same state (plan decision D2).

/** Get-or-create a test office flagged is_test, then reset it to the seeded state. */
export async function createCatalogueOffice(label: string, opts: { isTest?: boolean; reset?: boolean } = {}): Promise<string> {
  const { isTest = true, reset = true } = opts;
  const admin = adminClient();
  const name = `e2e office ${label}`;
  const { data: found, error: e0 } = await admin.from("office").select("id, is_test").eq("name", name).maybeSingle();
  if (e0) throw e0;
  let id = found?.id as string | undefined;
  if (!id) {
    const { data, error } = await admin.from("office").insert({ name, branch: "test", is_test: isTest }).select("id").single();
    if (error) throw error;
    id = data.id as string;
  } else if (found!.is_test !== isTest) {
    const { error } = await admin.from("office").update({ is_test: isTest }).eq("id", id);
    if (error) throw error;
  }
  if (isTest && reset) await resetTestOffice(id);
  return id;
}

export async function resetTestOffice(officeId: string) {
  const { error } = await adminClient().rpc("reset_test_office", { p_office_id: officeId });
  if (error) throw error;
}

export async function groupId(officeId: string, name: string): Promise<string> {
  const { data, error } = await adminClient().from("doc_group").select("id").eq("office_id", officeId).eq("name", name).single();
  if (error) throw error;
  return data.id as string;
}

/** Master types of a group as the service role sees them (setup/expectations only). */
export async function masterTypes(officeId: string, group: string) {
  const gid = await groupId(officeId, group);
  const { data, error } = await adminClient().from("doc_type")
    .select("id, name, source, active, default_frequency, ask_after_months, ask_day, overdue_after_months, overdue_day, reminders")
    .eq("doc_group_id", gid);
  if (error) throw error;
  return data!;
}

type NewClient = {
  name: string; client_type: string; incharge_id: string; pan?: string | null;
  previous_reference?: string | null; email?: string | null; mobile?: string | null;
};

/** Insert a client as `as` (RLS applies). Returns the row or the error. */
export async function insertClient(as: SupabaseClient, officeId: string, c: NewClient) {
  return as.from("client").insert({ office_id: officeId, ...c }).select("id, code, pan, incharge_id").single();
}

export async function mustInsertClient(as: SupabaseClient, officeId: string, c: NewClient) {
  const { data, error } = await insertClient(as, officeId, c);
  if (error) throw error;
  return data!;
}

/** Postgres errors that mean "the database said no" (RLS, grants, checks, triggers, unique). */
export const DENIED = /row-level security|permission denied|violates|ROLE_REQUIRED|NO_DELETE|NOT_TEST_OFFICE|duplicate key/i;
