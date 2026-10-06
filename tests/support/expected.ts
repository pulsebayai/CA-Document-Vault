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
// Pages through every row (Raja OK 2026-10-02, 05 step 8): activity is never purged, so a test office's rows grow with
// each run, and a single read stops at PostgREST's 1,000-row cap — lane 1's exp-plan office reached 1,006 and the
// newest rows (this run's) were silently dropped. Same rows, same order; assertions unchanged.
export async function expectedActivity(officeId: string, entityId?: string) {
  type Row = { action: string; actor_id: string | null; entity_type: string; entity_id: string; data: Record<string, unknown>; created_at: string };
  const PAGE = 1000;
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = adminClient().from("activity").select("action, actor_id, entity_type, entity_id, data, created_at")
      .eq("office_id", officeId).like("action", "expected.%");
    if (entityId) q = q.eq("entity_id", entityId);
    const { data, error } = await q.order("id").range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < PAGE) return rows;
  }
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

// ── Feature 06 — follow-ups (reminders) and Today. Additions only (06 plan "Files that change"). ──────────
// Written before 06's migration (plan step 1). Contract under test (plan step 2 implements it):
//
//   table follow_up      id, office_id, client_id, channel ('email'|'whatsapp'|'phone'),
//                        status ('pending'|'sent'|'failed'|'suppressed'|'opened'|'logged'), sent_by, sent_at,
//                        sent_on (office "today": the IST date, or the test clock in an is_test office),
//                        recipient (email/mobile snapshot; null for phone), provider_message_id, error_code,
//                        note (phone, ≤ 300), finished_at.     SELECT iff can_see_client; no app writes.
//   table follow_up_item id, office_id, follow_up_id, expected_doc_id.  SELECT iff its follow-up is visible.
//
//   begin_email_reminder(p_client uuid, p_items uuid[], p_daily_max integer default 200) → { id, recipient }
//       inserts a 'pending' email follow-up after: NOT_FOUND (client not visible) · NO_ITEMS · ITEMS_INVALID
//       (an item not the client's, or not open: pending, row and group not paused, client not archived) ·
//       NO_EMAIL · ALREADY_EMAILED_TODAY (pending < 10 min, sent or suppressed today; failed and stale pending
//       don't count — a stale pending is closed as failed/TIMEOUT) · DAILY_LIMIT (office's sent + fresh pending
//       today ≥ p_daily_max; the server action passes EMAIL_DAILY_MAX).
//   finish_email_reminder(p_id uuid, p_status text, p_provider_id text, p_error_code text) → void
//       'pending' → 'sent' | 'failed' | 'suppressed', by the sender only; writes activity reminder.email.
//   record_follow_up(p_client uuid, p_items uuid[], p_channel text, p_on date default null, p_note text default null) → uuid
//       'whatsapp' → status opened, recipient = client mobile (NO_MOBILE), sent_on = today;
//       'phone' → status logged, sent_on = p_on (default today; FUTURE_DATE), note ≤ 300 (NOTE_TOO_LONG).
//       Activity reminder.whatsapp / reminder.call. Same item and visibility checks as begin_email_reminder.
//   today_items(p_scope text, p_show text default null, p_page integer default 0, p_limit integer default 30) → TodayData
//   chasing_metric(p_from date, p_to date) → ChasingMetric (Admin/Manager; ROLE_REQUIRED otherwise)

export type FollowUp = {
  id: string; office_id: string; client_id: string; channel: "email" | "whatsapp" | "phone";
  status: "pending" | "sent" | "failed" | "suppressed" | "opened" | "logged"; sent_by: string; sent_at: string;
  sent_on: string; recipient: string | null; provider_message_id: string | null; error_code: string | null;
  note: string | null; finished_at: string | null;
};

export type TodayRow = {
  expected_doc_id: string; kind: "overdue" | "due_today" | "due_week"; group: string; type: string;
  period: string; state_code: string | null; overdue_from: string; days_late: number | null;
  reminders: boolean; reminded: number; last_reminded_on: string | null; last_reminded_by: string | null;
  last_channel: string | null;
};
export type TodayCard = {
  client_id: string; name: string; incharge: string; assignees: Array<{ group: string; name: string }>;
  overdue: number; due_week: number; rows: TodayRow[];
};
export type TodayData = {
  today: string; counts: { overdue: number; due_week: number }; cards: TodayCard[]; has_more: boolean;
};

export type ChasingMetric = {
  received: number; reminders: number; per_item: number | null; needed_pct: number | null;
  by_channel: { email: number; whatsapp: number; phone: number };
};

/** Calls an RPC and returns { data, error } with the error as a message (for toThrow / match checks). */
export async function rpc<T>(as: SupabaseClient, fn: string, args: Record<string, unknown>) {
  const { data, error } = await as.rpc(fn, args);
  return { data: data as T, error: error?.message ?? null };
}

export async function mustRpc<T>(as: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc<T>(as, fn, args);
  if (error) throw new Error(`${fn}: ${error}`);
  return data;
}

/** begin + finish in one go (the server action's two phases, without a mailer). */
export async function emailReminder(as: SupabaseClient, client: string, items: string[],
  finish: "sent" | "failed" | "suppressed" = "suppressed", dailyMax?: number) {
  const begun = await mustRpc<{ id: string; recipient: string }>(as, "begin_email_reminder",
    { p_client: client, p_items: items, ...(dailyMax === undefined ? {} : { p_daily_max: dailyMax }) });
  await mustRpc(as, "finish_email_reminder", {
    p_id: begun.id, p_status: finish, p_provider_id: finish === "sent" ? `test-${begun.id}` : null,
    p_error_code: finish === "failed" ? "PROVIDER_ERROR" : null,
  });
  return begun;
}

/** The office's follow-ups as the service role sees them (setup/expectations only). */
export async function followUpsOf(officeId: string, clientId?: string): Promise<FollowUp[]> {
  let q = adminClient().from("follow_up").select("*").eq("office_id", officeId);
  if (clientId) q = q.eq("client_id", clientId);
  const { data, error } = await q.order("sent_at");
  if (error) throw error;
  return (data ?? []) as FollowUp[];
}

/** Activity rows written by 06 for an office, oldest first. */
export async function reminderActivity(officeId: string) {
  const { data, error } = await adminClient().from("activity").select("action, actor_id, entity_type, entity_id, data")
    .eq("office_id", officeId).like("action", "reminder.%").order("id");
  if (error) throw error;
  return data as Array<{ action: string; actor_id: string | null; entity_type: string; entity_id: string; data: Record<string, unknown> }>;
}

/**
 * A client whose plan is Banking › Bank statement only (monthly; asked +1/1, overdue +1/7 unless `overdue` is
 * given), so item counts are exact. Enabled as `as` at the office's current test clock.
 */
export async function bankOnlyClient(as: SupabaseClient, officeId: string, c: {
  name: string; incharge_id: string; email?: string | null; mobile?: string | null;
  overdue?: { months: number; day: number };
}) {
  const { data: client, error } = await as.from("client").insert({
    office_id: officeId, name: c.name, client_type: "individual", incharge_id: c.incharge_id,
    email: c.email ?? null, mobile: c.mobile ?? null,
  }).select("id").single();
  if (error) throw error;
  const { data: g, error: eg } = await adminClient().from("doc_group").select("id").eq("office_id", officeId).eq("name", "Banking").single();
  if (eg) throw eg;
  const { error: e1 } = await as.rpc("enable_client_group", { p_client_id: client.id, p_doc_group_id: g.id });
  if (e1) throw new Error(e1.message);
  for (const n of ["Loan statement / interest certificate", "Bank balance confirmation", "FD / interest certificates"]) {
    const row = await planRow(client.id, n);
    const { error: e2 } = await as.from("client_doc_type").update({ state: "removed" }).eq("id", row.id);
    if (e2) throw e2;
  }
  if (c.overdue) {
    const row = await planRow(client.id, T.bank);
    const { error: e3 } = await as.from("client_doc_type")
      .update({ overdue_after_months: c.overdue.months, overdue_day: c.overdue.day }).eq("id", row.id);
    if (e3) throw e3;
  }
  return client.id as string;
}

// ── Feature 06 step 9 (after 07): Today's document rows. Additions only. ───────────────────────────────────────
// today_items() then also returns, per card, document rows and two more counts:
//   counts { overdue, due_week, to_review, ready } · clients (total cards in scope and filter) · p_show adds
//   'to_review' | 'ready'. A row is "to_review" when filed, live and status 'received' (07 isToReview), "ready" when a
//   filed, live original is reviewed or needs correction and has no live dispatch item (07 isReadyToDispatch).
//   Mine = plan row's staff (active row) → group's staff (active group) → incharge, as for expected items.
export type TodayDocRow = {
  document_id: string; kind: "to_review" | "ready"; doc_code: string; group: string; type: string; period: string | null;
  received_as: string; received_on: string; reviewed_on: string | null; reviewed_by: string | null; needs_correction: boolean;
};
export type TodayDocCounts = { overdue: number; due_week: number; to_review: number; ready: number };
