import { describe, expect, it } from "vitest";
import {
  HELD_AFTER_DAYS, custodyAction, documentState, inOfficeDays, isHeld, isToPlace, type DocumentStateInput,
} from "@/lib/documents/state";
import { DEFAULT_FILTERS, filtersToQuery, parseDocumentSearchParams, toSearchInput } from "@/lib/validation/document-search";

// Feature 13 — custody in the shown state (spec AC-8, AC-10), the next custody action (AC-9) and the /documents
// Custody filter + "In office over 30 days" (AC-12). Pure functions; the SQL side is tests/rls/custody*.test.ts.

const TODAY = "2026-10-31";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const filed = (over: Partial<DocumentStateInput> = {}): DocumentStateInput => ({
  archived: false, clientId: A, docTypeId: B, receivedAs: "hard_copy", status: "reviewed", custody: null, ...over,
});

describe("shown state with custody (AC-8)", () => {
  it("Document in office: custody set and Reviewed", () => {
    expect(documentState(filed({ custody: "in_office" }), TODAY)).toMatchObject({ kind: "in_office", text: "Document in office" });
    expect(documentState(filed({ custody: "in_office", returnable: true }), TODAY).kind).toBe("in_office");
  });

  it("Needs correction still wins over In office; To review wins over a kept custody step (Q4)", () => {
    expect(documentState(filed({ custody: "in_office", status: "needs_correction", correctionReason: "Blurred" }), TODAY).kind).toBe("needs_correction");
    expect(documentState(filed({ custody: "in_office", status: "received" }), TODAY).kind).toBe("to_review");
  });

  it("Ready to dispatch comes before Needs correction for a returnable copy marked ready (07's order)", () => {
    expect(documentState(filed({ custody: "ready", returnable: true, status: "needs_correction", correctionReason: "x" }), TODAY).kind).toBe("ready");
  });

  it("a reviewed copy with no step stays Reviewed; a soft copy never shows a custody state", () => {
    expect(documentState(filed(), TODAY).kind).toBe("reviewed");
    expect(documentState(filed({ receivedAs: "soft_copy" }), TODAY).kind).toBe("reviewed");
  });
});

describe("To place and the next custody action (AC-9, AC-11)", () => {
  it("To place = filed, live hard copy with a review decision and no custody step", () => {
    expect(isToPlace(filed())).toBe(true);
    expect(isToPlace(filed({ status: "needs_correction" }))).toBe(true);
    for (const d of [filed({ status: "received" }), filed({ custody: "in_office" }), filed({ receivedAs: "soft_copy" }),
      filed({ archived: true }), filed({ docTypeId: null })]) expect(isToPlace(d)).toBe(false);
  });

  it("the next action is Mark in office, then Ready to dispatch for returnable copies, then none", () => {
    expect(custodyAction(filed())).toBe("in_office");
    expect(custodyAction(filed({ custody: "in_office", returnable: true }))).toBe("ready");
    expect(custodyAction(filed({ custody: "in_office", returnable: true, status: "needs_correction" }))).toBe("ready");
    expect(custodyAction(filed({ custody: "in_office" }))).toBeNull(); // the firm keeps it
    expect(custodyAction(filed({ custody: "ready", returnable: true }))).toBeNull(); // Dispatch is 07's action
    expect(custodyAction(filed({ custody: "in_office", returnable: true, status: "received" }))).toBeNull(); // review first
    expect(custodyAction(filed({ status: "received" }))).toBeNull();
    expect(custodyAction(filed({ receivedAs: "soft_copy" }))).toBeNull();
    expect(custodyAction(filed({ archived: true }))).toBeNull();
  });
});

describe("In office N days (AC-10, P1)", () => {
  const held = (over: Partial<DocumentStateInput>) => filed({ returnable: true, custody: "in_office", ...over });
  it("counts office days since marking in office (India date), for returnable copies not yet dispatched", () => {
    expect(HELD_AFTER_DAYS).toBe(30);
    expect(inOfficeDays(held({ inOfficeAt: "2026-09-30T19:00:00Z" }), TODAY)).toBe(30); // 1 Oct in India
    expect(inOfficeDays(held({ inOfficeAt: "2026-09-29T10:00:00Z" }), TODAY)).toBe(32);
    expect(inOfficeDays(held({ inOfficeAt: "2026-09-29T10:00:00Z", returnable: false }), TODAY)).toBeNull();
    expect(inOfficeDays(held({ inOfficeAt: "2026-09-29T10:00:00Z", dispatchedOn: "2026-10-01" }), TODAY)).toBeNull();
    expect(inOfficeDays(held({ inOfficeAt: null }), TODAY)).toBeNull();
  });

  it("held = more than 30 days", () => {
    expect(isHeld(held({ inOfficeAt: "2026-09-30T19:00:00Z" }), TODAY)).toBe(false);
    expect(isHeld(held({ inOfficeAt: "2026-09-29T10:00:00Z" }), TODAY)).toBe(true);
    expect(isHeld(held({ inOfficeAt: "2026-09-29T10:00:00Z", archived: true }), TODAY)).toBe(false);
  });
});

describe("/documents Custody filter (AC-12)", () => {
  it("round-trips to_place / in_office and the held flag through the URL; old return=ready keeps working", () => {
    for (const ret of ["to_place", "in_office", "ready", "dispatched"] as const) {
      const f = { ...DEFAULT_FILTERS, return: ret };
      expect(parseDocumentSearchParams(Object.fromEntries(new URLSearchParams(filtersToQuery(f))))).toEqual(f);
    }
    const h = { ...DEFAULT_FILTERS, held: "1" as const };
    expect(filtersToQuery(h)).toBe("held=1");
    expect(parseDocumentSearchParams({ held: "1" })).toEqual(h);
    expect(parseDocumentSearchParams({ held: "yes" })).toEqual(DEFAULT_FILTERS);
  });

  it("passes held to the search functions as true", () => {
    expect(toSearchInput({ ...DEFAULT_FILTERS, held: "1" }, "").filters).toEqual({ held: true });
  });
});
