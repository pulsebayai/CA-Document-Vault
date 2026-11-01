import { describe, expect, it } from "vitest";
import { DEFAULT_FILTERS, type DocumentFilters } from "@/lib/validation/document-search";
import { ALL_YEARS, scopeFilters, scopedHref } from "@/lib/search/scope";

// Feature 15 (spec AC-2, U4) — the All documents tab keeps /documents' filters in the client page's URL:
//   scopedHref(clientId, filters) → "/clients/<id>?tab=all&…" (never a `client` param: the client is the page's own;
//   never search text — filters are IDs, enums, dates and the page only, as 03b).
//   scopeFilters(clientId, urlFilters, currentFyId) → the filters the table searches with: client fixed to the page's
//   client (a hand-edited `client` in the URL is ignored), FY = the current FY unless the URL chose one, `fy=all` = every year.

const C = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const FY = "33333333-3333-4333-8333-333333333333";
const FY2 = "44444444-4444-4444-8444-444444444444";
const f = (over: Partial<DocumentFilters> = {}): DocumentFilters => ({ ...DEFAULT_FILTERS, ...over });

describe("scopeFilters (AC-2)", () => {
  it("defaults to the current FY and fixes the client", () => {
    expect(scopeFilters(C, f(), FY)).toMatchObject({ client: C, fy: FY });
  });

  it("keeps an FY the URL chose; 'all' means every year (no FY filter)", () => {
    expect(scopeFilters(C, f({ fy: FY2 }), FY)).toMatchObject({ fy: FY2 });
    expect(scopeFilters(C, f({ fy: ALL_YEARS }), FY).fy).toBeNull();
  });

  it("ignores a client in the URL: the page's client always wins", () => {
    expect(scopeFilters(C, f({ client: OTHER }), FY).client).toBe(C);
  });

  it("with no current FY known, shows every year rather than nothing", () => {
    expect(scopeFilters(C, f(), null).fy).toBeNull();
  });
});

describe("scopedHref (AC-2)", () => {
  it("stays on the client page with tab=all and no client parameter", () => {
    expect(scopedHref(C, f({ client: C, fy: FY }))).toBe(`/clients/${C}?tab=all&fy=${FY}`);
  });

  it("keeps the other filters and the page, in /documents' order", () => {
    const href = scopedHref(C, f({ client: C, fy: FY, group: FY2, page: 2 }));
    expect(href.startsWith(`/clients/${C}?tab=all&`)).toBe(true);
    expect(href).toContain(`group=${FY2}`);
    expect(href).toContain("page=2");
    expect(href).not.toContain("client=");
  });

  it("'All years' is kept as fy=all so a reload doesn't fall back to the current FY", () => {
    expect(scopedHref(C, f({ client: C, fy: null }), { allYears: true })).toBe(`/clients/${C}?tab=all&fy=all`);
  });
});
