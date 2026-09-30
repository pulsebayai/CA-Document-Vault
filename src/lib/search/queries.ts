import "server-only";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import type { Channel, ReceivedAs } from "@/lib/validation/document";
import type { SearchInput } from "@/lib/validation/document-search";

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
};

export type FacetName = "group" | "received_as" | "channel" | "received_by" | "status";
export type FacetValue = { facet: FacetName; value: string; label: string; n: number };
export type ClientHit = { id: string; name: string; code: string };

type Row = {
  id: string; doc_code: string; client_id: string | null; client_name: string | null; client_code: string | null;
  type_name: string | null; group_name: string | null; period_code: string | null; period_label: string | null;
  received_as: ReceivedAs; channel: Channel; received_on: string; received_by_name: string | null; status: string;
  file_name: string | null; archived_at: string | null;
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
});

export async function searchDocumentsAs(input: SearchInput): Promise<{ total: number; rows: DocumentHit[] }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("search_documents", { p: input });
  if (error) fail("documents", error.code);
  const res = (data ?? { total: 0, rows: [] }) as { total: number; rows: Row[] };
  return { total: Number(res.total) || 0, rows: (res.rows ?? []).map(toHit) };
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

/** The document with this exact DOC-ID, if the user can open it (a single select under RLS). */
export async function findDocIdAs(docCode: string): Promise<{ id: string; docCode: string } | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("document").select("id, doc_code").eq("doc_code", docCode).maybeSingle();
  if (error) fail("docid", error.code);
  return data ? { id: data.id as string, docCode: data.doc_code as string } : null;
}
