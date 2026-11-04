import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// 19 (spec Y3, Y5, Y7): the Platform area's reads. Every call runs as the signed-in user; the platform functions check
// that they are an active super admin, scope to the firm given, and (the six read views) need an open window and
// write the audit + firm activity rows before returning. Nothing here uses the service role.

export type Firm = {
  id: string; name: string; branch: string | null; created_at: string; status: "active" | "suspended"; suspended_at: string | null;
  staff_active: number; staff_invited: number; clients: number; documents: number; storage_mb: number;
  last_activity_at: string | null; my_access: { id: string; expires_at: string } | null;
};
export type Page<T> = { total?: number; rows: T[] };
export type ClientRow = {
  id: string; code: string; name: string; client_type: string; pan: string | null; email: string | null; mobile: string | null;
  archived: boolean; incharge_name: string | null;
};
export type ClientDetail = ClientRow & {
  previous_reference: string | null; documents: number; expected_pending: number;
  registrations: Array<{ kind: string; number: string; active: boolean }>; groups: Array<{ name: string; state: string }>;
};
export type DocumentRow = {
  id: string; doc_code: string; client_name: string | null; type_name: string | null; period_code: string | null;
  received_as: string; received_on: string | null; status: string; custody: string | null; archived: boolean;
  file_name: string | null; size_bytes: number | null;
};
export type DocumentDetail = {
  id: string; doc_code: string; remark: string | null; received_as: string; returnable: boolean; channel: string;
  received_on: string | null; status: string; custody: string | null; archived: boolean; handed_over_name: string | null;
  client_name: string | null; type_name: string | null; period_code: string | null;
  versions: Array<{ version_no: number; file_name: string; mime_type: string; size_bytes: number; uploaded_at: string; uploaded_by: string | null }>;
  reviews: Array<{ outcome: string; reason: string | null; at: string; by: string | null }>;
};
export type ExpectedRow = {
  id: string; type_name: string; period_code: string; status: string; ask_on: string; overdue_from: string; received_on: string | null;
};
export type ActivityRow = {
  id: number; action: string; entity_type: string; entity_id: string | null; data: Record<string, unknown>; created_at: string;
  actor_name: string | null;
};
export type AuditRow = {
  id: number; at: string; action: string; office_id: string | null; office_name: string | null; admin_name: string;
  access_id: string | null; detail: Record<string, unknown>; reason: string | null;
};

/** A read view's answer: the data, or "no open window" (the page explains and links to the firm page). */
export type ViewResult<T> = { ok: true; data: T } | { ok: false; reason: "no_access" };

async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    // not a super admin (Next renders nested layouts and pages in parallel, so this can answer before the Platform
    // layout's own check), another firm's ID, or one that doesn't exist: all Not Found, never an error page
    if (/^(NOT_FOUND|NOT_PLATFORM_ADMIN)/.test(error.message)) notFound();
    throw new Error(`${fn} failed`); // the segment's error state; no details reach the browser
  }
  return data as T;
}

async function view<T>(fn: string, args: Record<string, unknown>): Promise<ViewResult<T>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    if (/^NO_ACCESS/.test(error.message)) return { ok: false, reason: "no_access" };
    if (/^(NOT_FOUND|NOT_PLATFORM_ADMIN)/.test(error.message)) notFound();
    throw new Error(`${fn} failed`);
  }
  return { ok: true, data: data as T };
}

/** Cached per request: the firm layout and page both need it (review N-5). */
export const listFirms = cache(() => call<Firm[]>("platform_firms"));

/** One firm from the list (no view is logged: the firm page shows counts only). Not Found for another kind of firm. */
export async function getFirm(id: string): Promise<Firm> {
  const firm = (await listFirms()).find((f) => f.id === id);
  if (!firm) notFound();
  return firm;
}

export const inviteTarget = (office: string) =>
  call<{ staff_id: string; full_name: string } | null>("platform_invite_target", { p_office: office }); // no email (unlogged read)

export const viewClients = (office: string, query: string | null, page: number) =>
  view<Page<ClientRow>>("platform_clients", { p_office: office, p_query: query, p_page: page });
export const viewClient = (office: string, client: string) =>
  view<ClientDetail>("platform_client", { p_office: office, p_client: client });
export const viewDocuments = (office: string, client: string | null, page: number) =>
  view<Page<DocumentRow>>("platform_documents", { p_office: office, p_client: client, p_page: page });
export const viewDocument = (office: string, document: string) =>
  view<DocumentDetail>("platform_document", { p_office: office, p_document: document });
export const viewExpected = (office: string, client: string, page: number) =>
  view<Page<ExpectedRow>>("platform_expected", { p_office: office, p_client: client, p_page: page });
export const viewActivity = (office: string, page: number) =>
  view<Page<ActivityRow>>("platform_activity", { p_office: office, p_page: page });

export const auditList = (p: { office_id?: string; action?: string; page: number }) => call<Page<AuditRow>>("platform_audit_list", { p });
