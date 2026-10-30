import "server-only";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import type { DocumentChannel as Channel, ReceivedAs } from "@/lib/validation/document";
import type { SearchInput } from "@/lib/validation/document-search";
import { currentFiles, type CurrentFile } from "@/lib/documents/queries";

// Spec 03b. Everything runs as the signed-in user: search_documents / search_document_facets / search_clients are
// SECURITY INVOKER, so RLS decides what is visible. 03b deliberately calls search_clients directly (not through
// src/lib/clients/queries.ts, which 04 changes) and passes only its original parameters.
// Errors are logged as a code plus a request ID — never the search text or any filter value (AC-11).

export type DocumentHit = {
  id: string;
  docCode: string;
  clientId: string | null;
  clientName: string | null;
  clientCode: string | null;
  typeName: string | null;
  groupName: string | null;
  periodCode: string | null;
  periodLabel: string | null;
  receivedAs: ReceivedAs;
  channel: Channel;
  receivedOn: string;
  receivedByName: string | null;
  status: string;
  fileName: string | null;
  archived: boolean;
  // 07: what documentState() needs (src/lib/documents/state.ts). Optional so 03b-era fixtures stay valid.
  docTypeId?: string | null;
  reviewedAt?: string | null;
  reviewedByName?: string | null;
  correctionReason?: string | null;
  dispatchedOn?: string | null;
  dispatchMethod?: string | null;
  /** 11 (spec AC-16): present only when the document was filed outside the preference that applied. */
  notPreferred?: string[] | null;
  /** 12: present (true) only on a returnable hard copy; correctionKind only when set. */
  returnable?: boolean;
  correctionKind?: string;
  /** 12 (AC-18): present only on /documents rows that have a file (header suggestions don't load it). */
  file?: CurrentFile;
};

export type FacetName = "group" | "received_as" | "channel" | "received_by" | "status" | "return" | "format";
export type FacetValue = { facet: FacetName; value: string; label: string; n: number };
export type ClientHit = { id: string; name: string; code: string };
export type PickerClient = ClientHit & { archived: boolean };

type Row = {
  id: string; doc_code: string; client_id: string | null; client_name: string | null; client_code: string | null;
  type_name: string | null; group_name: string | null; period_code: string | null; period_label: string | null;
  received_as: ReceivedAs; channel: Channel; received_on: string; received_by_name: string | null; status: string;
  file_name: string | null; archived_at: string | null;
  doc_type_id?: string | null; reviewed_at?: string | null; reviewed_by_name?: string | null; correction_reason?: string | null;
  dispatched_on?: string | null; dispatch_method?: string | null;
  format_ok?: boolean | null; format_preferred?: string[] | null; // 11
  returnable?: boolean; correction_kind?: string | null; // 12
};

export class SearchError extends Error {
  constructor(readonly requestId: string) {
    super("SEARCH_FAILED");
  }
}

/** Logs `search.<op>_failed` with the Postgres/PostgREST code and a fresh request ID, then throws it. */
function fail(op: string, code: string | undefined): never {
  const requestId = randomUUID();
  console.error(`search.${op}_failed`, { code: code ?? "unknown", requestId });
  throw new SearchError(requestId);
}

const toHit = (r: Row): DocumentHit => ({
  id: r.id, docCode: r.doc_code, clientId: r.client_id, clientName: r.client_name, clientCode: r.client_code,
  typeName: r.type_name, groupName: r.group_name, periodCode: r.period_code, periodLabel: r.period_label,
  receivedAs: r.received_as, channel: r.channel, receivedOn: r.received_on, receivedByName: r.received_by_name,
  status: r.status, fileName: r.file_name, archived: r.archived_at !== null,
  docTypeId: r.doc_type_id ?? null, reviewedAt: r.reviewed_at ?? null, reviewedByName: r.reviewed_by_name ?? null,
  correctionReason: r.correction_reason ?? null, dispatchedOn: r.dispatched_on ?? null, dispatchMethod: r.dispatch_method ?? null,
  ...(r.format_ok === false ? { notPreferred: r.format_preferred ?? null } : {}), // 11: key absent otherwise (shape unchanged)
  ...(r.returnable ? { returnable: true } : {}), // 12: keys absent otherwise (shape unchanged)
  ...(r.correction_kind ? { correctionKind: r.correction_kind } : {}),
});

export async function searchDocumentsAs(input: SearchInput, opts: { withFiles?: boolean } = {}): Promise<{ total: number; rows: DocumentHit[] }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("search_documents", { p: input });
  if (error) fail("documents", error.code);
  const res = (data ?? { total: 0, rows: [] }) as { total: number; rows: Row[] };
  const rows = (res.rows ?? []).map(toHit);
  // 12 (AC-18): one RLS lookup for the page's current files (only the /documents page; not header suggestions).
  if (opts.withFiles && rows.some((r) => r.fileName)) {
    const files = await currentFiles(rows.filter((r) => r.fileName).map((r) => r.id));
    for (const r of rows) { const f = files.get(r.id); if (f) r.file = f; }
  }
  return { total: Number(res.total) || 0, rows };
}

export async function documentFacetsAs(input: SearchInput): Promise<FacetValue[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("search_document_facets", { p: input });
  if (error) fail("facets", error.code);
  return ((data ?? []) as Array<{ facet: FacetName; value: string; label: string | null; n: number }>)
    .map((f) => ({ facet: f.facet, value: f.value, label: f.label ?? f.value, n: Number(f.n) }));
}

/** Up to `limit` visible clients, with 02's matching (name, code, PAN, GSTIN, previous reference). */
export async function suggestClientsAs(text: string, limit = 5): Promise<ClientHit[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("search_clients", { p_query: text, p_limit: limit, p_offset: 0 });
  if (error) fail("clients", error.code);
  return ((data ?? []) as Array<{ id: string; name: string; code: string }>).map((c) => ({ id: c.id, name: c.name, code: c.code }));
}

/** Client filter picker on /documents: like suggestClientsAs, plus archived clients (marked) when the user has
 *  ticked "Include archived" — otherwise an archived client could never be picked as a filter. */
export async function findClientsAs(text: string, limit: number, includeArchived: boolean): Promise<PickerClient[]> {
  const supabase = await createClient();
  const args = { p_query: text, p_limit: limit, p_offset: 0, ...(includeArchived ? { p_include_archived: true } : {}) };
  const { data, error } = await supabase.rpc("search_clients", args);
  if (error) fail("clients", error.code);
  return ((data ?? []) as Array<{ id: string; name: string; code: string; archived: boolean }>)
    .map((c) => ({ id: c.id, name: c.name, code: c.code, archived: Boolean(c.archived) }));
}

/** The document with this exact DOC-ID, if the user can open it (a single select under RLS). */
export async function findDocIdAs(docCode: string): Promise<{ id: string; docCode: string } | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("document").select("id, doc_code").eq("doc_code", docCode).maybeSingle();
  if (error) fail("docid", error.code);
  return data ? { id: data.id as string, docCode: data.doc_code as string } : null;
}

// ── /documents filter options (step 6) ────────────────────────────────────────
// Master data the filter popovers list. All reads run as the user (RLS). Kept in 03b's own module so 03b never
// edits src/lib/documents/queries.ts (04 is working near it).

export type FilterOptions = {
  groups: { id: string; name: string }[];
  types: { id: string; name: string; groupId: string }[];
  fys: { id: string; code: string }[];
  periods: { id: string; fyId: string; kind: "month" | "quarter" | "year"; code: string; label: string }[];
  client: ClientHit | null;
  registrations: { id: string; kind: "gstin" | "tan"; number: string }[];
};

export async function filterOptionsAs(clientId: string | null): Promise<FilterOptions> {
  const supabase = await createClient();
  const [groups, types, fys, periods, client, regs] = await Promise.all([
    supabase.from("doc_group").select("id, name").eq("active", true).order("sort").order("name"),
    supabase.from("doc_type").select("id, name, doc_group_id").eq("active", true).order("name"),
    supabase.from("financial_year").select("id, code").order("code", { ascending: false }),
    supabase.from("period").select("id, financial_year_id, kind, code, label, start_date").order("start_date", { ascending: false }),
    clientId ? supabase.from("client").select("id, name, code").eq("id", clientId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    clientId
      ? supabase.from("client_registration").select("id, kind, number").eq("client_id", clientId).order("number")
      : Promise.resolve({ data: [], error: null }),
  ]);
  const failed = [groups, types, fys, periods, client, regs].find((r) => r.error);
  if (failed?.error) fail("options", failed.error.code);
  return {
    groups: (groups.data ?? []) as FilterOptions["groups"],
    types: (types.data ?? []).map((t) => ({ id: t.id as string, name: t.name as string, groupId: t.doc_group_id as string })),
    fys: (fys.data ?? []) as FilterOptions["fys"],
    periods: (periods.data ?? []).map((p) => ({
      id: p.id as string, fyId: p.financial_year_id as string, kind: p.kind as FilterOptions["periods"][number]["kind"],
      code: p.code as string, label: p.label as string,
    })),
    client: client.data ? { id: client.data.id as string, name: client.data.name as string, code: client.data.code as string } : null,
    registrations: (regs.data ?? []) as FilterOptions["registrations"],
  };
}
