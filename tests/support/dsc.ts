import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "./db";

// Feature 14 fixtures — DSC tracking (spec AC-1 … AC-14, T1–T5). Written before the migration (plan step 1).
//
// Contract under test (plan step 3 implements it; additive-only exception, T1):
//   table dsc (office_id, client_id, holder_name, dsc_class class3|dgft|other|null, issuer, token_note, expires_on,
//       password_ct [NOT in the column grant], password_set_at/by, created/updated by/at, archived_at/by/reason).
//       RLS select iff can_see_client; writes only inside the dsc_* functions (flag `app.dsc_write`); no delete.
//   table dsc_custody (append-only: dsc_id, direction out|in, person_name, on_date, note, actor_id, at).
//   table client_dsc_setting (client_id pk, office_id, remind_days 1–180; default 30 when absent).
//   dsc_save(p jsonb) → uuid   (invoker; create when p.id is absent. Staff/Manager/Admin. password_ct required on
//       create, optional on update = "Change password"; format k<keyId>.<iv>.<tag>.<ct>, base64url.)
//   dsc_reveal(p_id uuid) → text   (definer; Staff+ who can see the client; not archived; logs, then returns.)
//   dsc_custody_log(p jsonb) → uuid   (invoker; any role that can see the client; out/in alternate.)
//   dsc_archive(p_id uuid, p_reason text) · dsc_unarchive(p_id uuid)   (Admin/Manager.)
//   dsc_set_remind_days(p_client_id uuid, p_days int)   (Staff+.)
//   dsc_due(p_scope 'mine'|'everyone') → { count, rows: DueRow[] }   (invoker; office date; expiring within the
//       client's remind days or already expired; live DSCs of live clients; soonest first.)
//   test_seed_dsc(p_office_id uuid, p_per_client int, p_today date) → int   (service role; is_test offices only.)
//   Activity: dsc.created · dsc.updated {fields} · dsc.password_changed · dsc.password_revealed · dsc.given_out ·
//       dsc.received_back · dsc.archived · dsc.unarchived · dsc.remind_days_set (entity client). IDs and field names only.

/** A well-formed ciphertext the database accepts (it never decrypts; only src/lib/dsc/crypto.ts can). */
export const FAKE_CT = "ktest.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.c2VjcmV0LXRva2VuLXBpbg";
export const FAKE_CT_2 = "ktest.BBBBBBBBBBBBBBBB.BBBBBBBBBBBBBBBBBBBBBB.bmV3LXBpbg";

export type NewDsc = {
  id?: string; client_id?: string; holder_name?: string; expires_on?: string; password_ct?: string | null;
  dsc_class?: "class3" | "dgft" | "other" | null; issuer?: string | null; token_note?: string | null;
};

export type DueRow = {
  id: string; client_id: string; client_code: string; client_name: string; holder_name: string;
  dsc_class: string | null; expires_on: string; days_left: number; remind_days: number;
  out_to: string | null; out_since: string | null;
};

export const saveDsc = (as: SupabaseClient, p: NewDsc) => as.rpc("dsc_save", { p });

export async function mustSaveDsc(as: SupabaseClient, p: NewDsc): Promise<string> {
  const { data, error } = await saveDsc(as, p);
  if (error) throw new Error(`dsc_save: ${error.message}`);
  return data as string;
}

export const newDsc = (clientId: string, extra: NewDsc = {}): NewDsc => ({
  client_id: clientId, holder_name: "Test Holder", expires_on: "2027-03-12", password_ct: FAKE_CT,
  dsc_class: "class3", issuer: "eMudhra", ...extra,
});

export const revealDsc = (as: SupabaseClient, id: string) => as.rpc("dsc_reveal", { p_id: id });
export const logCustody = (as: SupabaseClient, p: { dsc_id: string; direction: "out" | "in"; person_name: string; on_date: string; note?: string | null }) =>
  as.rpc("dsc_custody_log", { p });
export const archiveDsc = (as: SupabaseClient, id: string, reason: string | null) => as.rpc("dsc_archive", { p_id: id, p_reason: reason });
export const unarchiveDsc = (as: SupabaseClient, id: string) => as.rpc("dsc_unarchive", { p_id: id });
export const setRemindDays = (as: SupabaseClient, clientId: string, days: number) =>
  as.rpc("dsc_set_remind_days", { p_client_id: clientId, p_days: days });

export async function dscDue(as: SupabaseClient, scope: "mine" | "everyone") {
  const { data, error } = await as.rpc("dsc_due", { p_scope: scope });
  if (error) throw new Error(`dsc_due: ${error.message}`);
  return data as { count: number; rows: DueRow[] };
}

/** The stored row, as the service role sees it (setup/expectations only — the app never selects password_ct). */
export async function dscRow(id: string) {
  const { data, error } = await adminClient().from("dsc").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Record<string, unknown>;
}

export async function custodyLog(dscId: string) {
  const { data, error } = await adminClient().from("dsc_custody").select("direction, person_name, on_date, note, actor_id, at")
    .eq("dsc_id", dscId).order("at", { ascending: true });
  if (error) throw error;
  return data as Array<{ direction: "out" | "in"; person_name: string; on_date: string; note: string | null; actor_id: string; at: string }>;
}

export async function dscActivity(officeId: string, entityId: string) {
  const { data, error } = await adminClient().from("activity").select("id, actor_id, action, entity_type, entity_id, data")
    .eq("office_id", officeId).eq("entity_id", entityId).order("id", { ascending: true });
  if (error) throw error;
  return data as Array<{ id: number; actor_id: string | null; action: string; entity_type: string; entity_id: string; data: Record<string, unknown> }>;
}

/** Sets the test office's clock (office.test_today) without running generation — the DSC rules read private.office_today. */
export async function setTestToday(officeId: string, day: string) {
  const { error } = await adminClient().from("office").update({ test_today: day }).eq("id", officeId);
  if (error) throw error;
}
