import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTERS, MAX_WORDS, MAX_WORD_LENGTH, filtersToQuery, isFiltered, normaliseSearchText, parseDocId,
  parseDocumentSearchParams, toSearchInput, type DocumentFilters,
} from "@/lib/validation/document-search";

// Spec 03b AC-3, AC-6, AC-8, AC-11: filters live in the URL (IDs, enums and dates only); the search text never does.
// The text rules mirror search_documents (5 words × 50 chars) so what the user sees is what the DB matches.

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

describe("parseDocumentSearchParams (AC-6)", () => {
  it("with no params gives the defaults: no filters, newest received first, page 1, archived hidden", () => {
    expect(parseDocumentSearchParams({})).toEqual(DEFAULT_FILTERS);
    expect(DEFAULT_FILTERS).toMatchObject({ sort: "received", page: 1, archived: false, client: null, channel: null });
  });

  it("reads every filter from its URL key", () => {
    const f = parseDocumentSearchParams({
      client: A, group: B, type: C, fy: A, period: B, registration: C, as: "original", channel: "courier",
      by: A, from: "2026-08-01", to: "2026-08-31", status: "received", state: "inbox", archived: "1", sort: "docid", page: "3",
    });
    expect(f).toEqual({
      client: A, group: B, type: C, fy: A, period: B, registration: C, as: "original", channel: "courier",
      by: A, from: "2026-08-01", to: "2026-08-31", status: "received", state: "inbox", archived: true, sort: "docid", page: 3,
    });
  });

  it("drops malformed values instead of failing (a bad shared link still opens the page)", () => {
    const f = parseDocumentSearchParams({
      client: "not-a-uuid", as: "paper", channel: "fax", from: "2026-02-30", to: "yesterday", state: "both",
      status: "lost", archived: "yes", sort: "name", page: "-2",
    });
    expect(f).toEqual(DEFAULT_FILTERS);
  });

  it("takes the first value when a key repeats", () => {
    expect(parseDocumentSearchParams({ channel: ["email", "courier"] }).channel).toBe("email");
  });

  it("caps the page number", () => {
    expect(parseDocumentSearchParams({ page: "999999" }).page).toBe(1000);
    expect(parseDocumentSearchParams({ page: "2.5" }).page).toBe(1);
  });

  it("keeps GSTIN/TAN only when a client is chosen", () => {
    expect(parseDocumentSearchParams({ registration: C }).registration).toBeNull();
    expect(parseDocumentSearchParams({ client: A, registration: C }).registration).toBe(C);
  });

  it("swaps a reversed date range", () => {
    expect(parseDocumentSearchParams({ from: "2026-09-30", to: "2026-09-01" })).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("ignores any text-like key: search text is never read from the URL", () => {
    const f = parseDocumentSearchParams({ q: "hdfc", text: "hdfc", query: "hdfc" } as Record<string, string>);
    expect(f).toEqual(DEFAULT_FILTERS);
  });
});

describe("filtersToQuery (AC-6, AC-11)", () => {
  it("writes only non-default values, in a stable order", () => {
    expect(filtersToQuery(DEFAULT_FILTERS)).toBe("");
    const f: DocumentFilters = { ...DEFAULT_FILTERS, channel: "email", client: A, page: 2, archived: true };
    expect(filtersToQuery(f)).toBe(`client=${A}&channel=email&archived=1&page=2`);
  });

  it("round-trips through the parser", () => {
    const f: DocumentFilters = {
      ...DEFAULT_FILTERS, client: A, group: B, type: C, fy: A, period: B, registration: C, as: "soft_copy",
      channel: "portal", by: A, from: "2026-04-01", to: "2027-03-31", status: "received", state: "classified",
      archived: true, sort: "added", page: 4,
    };
    const params = Object.fromEntries(new URLSearchParams(filtersToQuery(f)));
    expect(parseDocumentSearchParams(params)).toEqual(f);
  });

  it("has no way to carry search text (the type has no text field, and output keys are the fixed filter keys)", () => {
    const f = { ...DEFAULT_FILTERS, text: "secret client name" } as unknown as DocumentFilters;
    const q = filtersToQuery(f);
    expect(q).not.toMatch(/secret|text=|q=/);
  });
});

describe("normaliseSearchText (AC-8)", () => {
  it("trims, collapses spaces and keeps at most 5 words of at most 50 characters", () => {
    expect(normaliseSearchText("  bank   statement \n hdfc ")).toBe("bank statement hdfc");
    expect(normaliseSearchText("a b c d e f g")).toBe("a b c d e");
    expect(normaliseSearchText("x".repeat(60))).toBe("x".repeat(50));
    expect(MAX_WORDS).toBe(5);
    expect(MAX_WORD_LENGTH).toBe(50);
  });

  it("keeps %, _ and \\ as typed (the database escapes them)", () => {
    expect(normaliseSearchText("100% a_b c\\d")).toBe("100% a_b c\\d");
  });

  it("returns an empty string for blank input", () => {
    expect(normaliseSearchText("   ")).toBe("");
    expect(normaliseSearchText(undefined)).toBe("");
  });
});

describe("parseDocId (AC-3)", () => {
  it("recognises a complete DOC-ID in any case with surrounding spaces, and returns it upper-cased", () => {
    expect(parseDocId("  doc-fy26-27-00123 ")).toBe("DOC-FY26-27-00123");
    expect(parseDocId("DOC-FY31-32-100000")).toBe("DOC-FY31-32-100000");
  });

  it("rejects partial or decorated IDs", () => {
    for (const s of ["doc-fy26-27-0012", "DOC-FY26-27", "DOC-FY2627-00123", "see DOC-FY26-27-00123", "DOC-FY26-27-00123x", ""]) {
      expect(parseDocId(s), s).toBeNull();
    }
  });
});

describe("toSearchInput (the search_documents / search_document_facets argument)", () => {
  it("maps URL filters to the function's keys and adds the normalised text", () => {
    const f: DocumentFilters = { ...DEFAULT_FILTERS, client: A, group: B, as: "hard_copy", by: C, from: "2026-08-01", state: "inbox", archived: true, sort: "docid", page: 2 };
    expect(toSearchInput(f, "  hdfc   aug ")).toEqual({
      text: "hdfc aug",
      filters: { client_id: A, group_id: B, received_as: "hard_copy", received_by: C, from: "2026-08-01", state: "inbox" },
      include_archived: true, sort: "docid", page: 2,
    });
  });

  it("omits empty text and unset filters", () => {
    expect(toSearchInput(DEFAULT_FILTERS, "")).toEqual({ filters: {}, include_archived: false, sort: "received", page: 1 });
  });
});

describe("isFiltered", () => {
  it("is false for defaults and ignores sort and page", () => {
    expect(isFiltered(DEFAULT_FILTERS)).toBe(false);
    expect(isFiltered({ ...DEFAULT_FILTERS, sort: "added", page: 3 })).toBe(false);
    expect(isFiltered({ ...DEFAULT_FILTERS, archived: true })).toBe(true);
    expect(isFiltered({ ...DEFAULT_FILTERS, channel: "email" })).toBe(true);
  });
});
