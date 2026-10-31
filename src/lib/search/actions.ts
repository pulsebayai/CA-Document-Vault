"use server";

import { requireStaff } from "@/lib/auth/staff";
import {
  MIN_SUGGEST_CHARS, PAGE_SIZE, SUGGEST_LIMIT, filtersToQuery, normaliseSearchText, parseDocId, parseDocumentSearchParams, toSearchInput, type DocumentFilters,
} from "@/lib/validation/document-search";
import {
  SearchError, documentFacetsAs, findClientsAs, findDocIdAs, searchDocumentsAs, suggestClientsAs,
  type ClientHit, type DocumentHit, type FacetValue, type PickerClient,
} from "./queries";

// Spec 03b AC-2…AC-4, AC-11. Server actions are POSTs, so the search text is only ever in a request body.
// Nothing here logs the text or writes activity (search is read-only).

type Failure = { ok: false; error: string };
const failure = (e: unknown, what: string): Failure => ({
  ok: false,
  error: `Could not load ${what}. Please try again.${e instanceof SearchError ? ` (Ref ${e.requestId.slice(0, 8)})` : ""}`,
});

/**
 * Filters arrive from the browser, so they are re-validated exactly as the URL is: written out with the fixed
 * keys, then parsed (malformed values dropped).
 */
function revalidate(filters: unknown): DocumentFilters {
  const raw = (filters && typeof filters === "object" ? filters : {}) as DocumentFilters;
  return parseDocumentSearchParams(Object.fromEntries(new URLSearchParams(filtersToQuery(raw))));
}

export type SuggestResult =
  | { ok: true; clients: ClientHit[]; documents: DocumentHit[]; exact: { id: string; docCode: string } | null }
  | Failure;

/** Header dropdown (AC-2): up to 5 clients and 5 documents, plus the exact DOC-ID hit if there is one. */
export async function suggest(text: string): Promise<SuggestResult> {
  await requireStaff();
  const t = normaliseSearchText(typeof text === "string" ? text : "");
  if (t.length < MIN_SUGGEST_CHARS) return { ok: true, clients: [], documents: [], exact: null };
  const docId = parseDocId(t);
  try {
    const [clients, docs, exact] = await Promise.all([
      suggestClientsAs(t, SUGGEST_LIMIT),
      searchDocumentsAs({ text: t, filters: {}, include_archived: false, sort: "received", page: 1, page_size: SUGGEST_LIMIT }),
      docId ? findDocIdAs(docId) : Promise.resolve(null),
    ]);
    return { ok: true, clients, documents: docs.rows, exact };
  } catch (e) {
    return failure(e, "suggestions");
  }
}

export type SearchDocumentsResult = ({ ok: true; total: number; rows: DocumentHit[] }) | Failure;

/** /documents results (AC-5, AC-6, AC-8). */
export async function searchDocuments(input: { text?: string; filters?: unknown }): Promise<SearchDocumentsResult> {
  await requireStaff();
  try {
    // 12: AC-25 (20 per page; facets don't page) and AC-18 (the rows' current files).
    return { ok: true, ...(await searchDocumentsAs({ ...toSearchInput(revalidate(input?.filters), input?.text), page_size: PAGE_SIZE }, { withFiles: true })) };
  } catch (e) {
    return failure(e, "documents");
  }
}

export type FacetsResult = { ok: true; facets: FacetValue[] } | Failure;

/** Facet counts for the filter popovers (AC-7). */
export async function documentFacets(input: { text?: string; filters?: unknown }): Promise<FacetsResult> {
  await requireStaff();
  try {
    return { ok: true, facets: await documentFacetsAs(toSearchInput(revalidate(input?.filters), input?.text)) };
  } catch (e) {
    return failure(e, "filter counts");
  }
}

export type OpenDocIdResult = { ok: true; id: string } | Failure;

/** Enter on a complete DOC-ID (AC-3): the document's id if the user can open it. */
export async function openDocId(text: string): Promise<OpenDocIdResult> {
  await requireStaff();
  const code = parseDocId(typeof text === "string" ? text : "");
  if (!code) return { ok: false, error: "That isn't a complete DOC-ID." };
  try {
    const hit = await findDocIdAs(code);
    return hit ? { ok: true, id: hit.id } : { ok: false, error: `No document ${code} that you can open` };
  } catch (e) {
    return failure(e, "that document");
  }
}

export type FindClientsResult = { ok: true; clients: PickerClient[] } | Failure;

/** Client filter picker on /documents (AC-6): up to 8 visible clients, with 02's matching; archived ones too
 *  (marked) when "Include archived" is on. */
export async function findClients(text: string, includeArchived = false): Promise<FindClientsResult> {
  await requireStaff();
  const t = normaliseSearchText(typeof text === "string" ? text : "");
  if (!t) return { ok: true, clients: [] };
  try {
    return { ok: true, clients: await findClientsAs(t, 8, includeArchived === true) };
  } catch (e) {
    return failure(e, "clients");
  }
}
