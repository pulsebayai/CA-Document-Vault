import { filtersToQuery, parseDocumentSearchParams, type DocumentFilters } from "@/lib/validation/document-search";

// Feature 15 (spec AC-2, U4) — /documents' table scoped to one client, on the client page's All documents tab.
// The filters live in the client page's URL (`?tab=all&…`, IDs, enums, dates and the page only, as 03b), never with a
// `client` parameter: the client is the page's own, and a hand-edited one is ignored. The FY defaults to the current
// FY; `fy=all` keeps "All years" across a reload.

/** The URL value for "All years" (03b's parser drops it as a non-UUID, so it is read here). */
export const ALL_YEARS = "all";

type Params = Record<string, string | string[] | undefined>;

/** The tab's filters from the client page's URL; `fy` is ALL_YEARS when the URL says so. */
export function parseScopeParams(params: Params): DocumentFilters {
  const f = parseDocumentSearchParams(params);
  const fy = Array.isArray(params.fy) ? params.fy[0] : params.fy;
  return fy === ALL_YEARS ? { ...f, fy: ALL_YEARS } : f;
}

/** The filters the table searches with: this client always; the current FY unless the URL chose one or All years. */
export function scopeFilters(clientId: string, filters: DocumentFilters, currentFyId: string | null): DocumentFilters {
  const fy = filters.fy === ALL_YEARS ? null : (filters.fy ?? currentFyId);
  return { ...filters, client: clientId, fy };
}

/** The client page's URL for these filters (`/clients/<id>?tab=all&…`). */
export function scopedHref(clientId: string, filters: DocumentFilters, opts: { allYears?: boolean } = {}): string {
  const q = filtersToQuery({ ...filters, client: null, fy: opts.allYears ? ALL_YEARS : filters.fy });
  return `/clients/${clientId}?tab=all${q ? `&${q}` : ""}`;
}
