import { describe, expect, it } from "vitest";
import { documentState, heldDays, isReadyToDispatch, isToReview, nextAction, type DocumentStateInput } from "@/lib/documents/state";
import { validateDispatch, validateReason } from "@/lib/validation/document";
import {
  DEFAULT_FILTERS, DOC_RETURNS, DOC_STATUSES, filtersToQuery, isFiltered, parseDocumentSearchParams, toSearchInput,
} from "@/lib/validation/document-search";

// Feature 07 — the shown-state order (spec "Shown state"), held days (AC-11), the next action (AC-12), the dialog
// rules (AC-2, AC-8) and the /documents Status + Return values (AC-14).

const TODAY = "2026-10-01";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const filed = (over: Partial<DocumentStateInput> = {}): DocumentStateInput => ({
  archived: false, clientId: A, docTypeId: B, receivedAs: "hard_copy", status: "received", ...over,
});

describe("documentState: first match wins (spec order)", () => {
  it("1 Archived beats everything", () => {
    expect(documentState(filed({ archived: true, receivedAs: "original", status: "reviewed", dispatchedOn: "2026-09-01" }), TODAY))
      .toEqual({ kind: "archived", text: "Archived" });
  });

  it("2 In inbox when client or type is missing, whatever the status", () => {
    expect(documentState(filed({ docTypeId: null }), TODAY).kind).toBe("inbox");
    expect(documentState(filed({ clientId: null, docTypeId: null, status: "reviewed" }), TODAY).text).toBe("Untagged"); // 12 (D2)
  });

  it("3 Dispatched <date> · <method> for an original in a live packet", () => {
    expect(documentState(filed({ receivedAs: "original", status: "needs_correction", correctionReason: "x", dispatchedOn: "2026-09-12", dispatchMethod: "courier" }), TODAY))
      .toMatchObject({ kind: "dispatched", text: "Dispatched 12 Sep · Courier" });
    expect(documentState(filed({ receivedAs: "original", status: "reviewed", dispatchedOn: "2025-12-30", dispatchMethod: "client_collected" }), TODAY).text)
      .toBe("Dispatched 30 Dec 2025 · Client collected");
  });

  // 13 (plan test list, approved 2026-10-31): Ready to dispatch is a stored custody step, not derived from the review.
  it("4 Ready to dispatch: a reviewed or Needs-correction original marked ready, not yet sent", () => {
    expect(documentState(filed({ receivedAs: "original", status: "reviewed", custody: "ready" }), TODAY).kind).toBe("ready");
    expect(documentState(filed({ receivedAs: "original", status: "needs_correction", correctionReason: "Wrong year", custody: "ready" }), TODAY).text).toBe("Ready to dispatch");
    expect(documentState(filed({ receivedAs: "original", custody: "ready" }), TODAY).kind).toBe("to_review"); // not reviewed (again) yet
  });

  it("5 Needs correction · <reason>", () => {
    expect(documentState(filed({ status: "needs_correction", correctionReason: "Pages missing" }), TODAY))
      .toMatchObject({ kind: "needs_correction", text: "Needs correction · Pages missing" });
  });

  it("6 Reviewed <date> by <name> (date in India time)", () => {
    expect(documentState(filed({ status: "reviewed", reviewedAt: "2026-09-02T20:00:00Z", reviewedByName: "Priya" }), TODAY))
      .toMatchObject({ kind: "reviewed", text: "Reviewed 3 Sep by Priya" });
    expect(documentState(filed({ status: "reviewed", receivedAs: "soft_copy" }), TODAY).text).toBe("Reviewed");
  });

  it("7 To review", () => {
    expect(documentState(filed(), TODAY)).toEqual({ kind: "to_review", text: "To review" });
  });
});

describe("predicates shared with Today (06) and the SQL", () => {
  it("To review = filed, live, status received", () => {
    expect(isToReview(filed())).toBe(true);
    for (const d of [filed({ docTypeId: null }), filed({ archived: true }), filed({ status: "reviewed" }), filed({ status: "needs_correction" })]) {
      expect(isToReview(d)).toBe(false);
    }
  });

  // 13 (plan test list, approved 2026-10-31): inputs carry the stored custody step.
  it("Ready to dispatch = filed, live original, reviewed or Needs correction, marked ready, not dispatched", () => {
    expect(isReadyToDispatch(filed({ receivedAs: "original", status: "reviewed", custody: "ready" }))).toBe(true);
    expect(isReadyToDispatch(filed({ receivedAs: "original", status: "needs_correction", custody: "ready" }))).toBe(true);
    for (const d of [
      filed({ receivedAs: "hard_copy", status: "reviewed", custody: "ready" }), filed({ receivedAs: "soft_copy", status: "reviewed", custody: "ready" }),
      filed({ receivedAs: "original", custody: "ready" }), filed({ receivedAs: "original", status: "reviewed", archived: true, custody: "ready" }),
      filed({ receivedAs: "original", status: "reviewed", dispatchedOn: "2026-09-01", custody: "ready" }),
      filed({ receivedAs: "original", status: "reviewed", docTypeId: null, custody: "ready" }),
    ]) expect(isReadyToDispatch(d)).toBe(false);
  });

  it("13: a reviewed original not marked ready (or only in office) is not Ready to dispatch", () => {
    expect(isReadyToDispatch(filed({ receivedAs: "original", status: "reviewed" }))).toBe(false);
    expect(isReadyToDispatch(filed({ receivedAs: "original", status: "reviewed", custody: "in_office" }))).toBe(false);
  });
});

describe("held days (AC-11)", () => {
  it("counts days since received for originals not yet dispatched", () => {
    expect(heldDays({ ...filed({ receivedAs: "original" }), receivedOn: "2026-09-01" }, TODAY)).toBe(30);
    expect(heldDays({ ...filed({ receivedAs: "original" }), receivedOn: TODAY }, TODAY)).toBe(0);
  });
  it("is null for copies, dispatched or archived originals", () => {
    expect(heldDays({ ...filed({ receivedAs: "hard_copy" }), receivedOn: "2026-09-01" }, TODAY)).toBeNull();
    expect(heldDays({ ...filed({ receivedAs: "soft_copy" }), receivedOn: "2026-09-01" }, TODAY)).toBeNull();
    expect(heldDays({ ...filed({ receivedAs: "original", dispatchedOn: "2026-09-10" }), receivedOn: "2026-09-01" }, TODAY)).toBeNull();
    expect(heldDays({ ...filed({ receivedAs: "original", archived: true }), receivedOn: "2026-09-01" }, TODAY)).toBeNull();
  });
});

describe("next action on Client › Documents (AC-12)", () => {
  it("Mark reviewed on To review and Needs correction; Mark dispatched on Ready; nothing otherwise", () => {
    expect(nextAction(documentState(filed(), TODAY))).toBe("review");
    expect(nextAction(documentState(filed({ status: "needs_correction", correctionReason: "x" }), TODAY))).toBe("review");
    expect(nextAction(documentState(filed({ receivedAs: "original", status: "reviewed", custody: "ready" }), TODAY))).toBe("dispatch"); // 13 (approved 2026-10-31)
    expect(nextAction(documentState(filed({ status: "reviewed" }), TODAY))).toBeNull();
    expect(nextAction(documentState(filed({ receivedAs: "original", status: "reviewed", dispatchedOn: "2026-09-01" }), TODAY))).toBeNull();
    expect(nextAction(documentState(filed({ archived: true }), TODAY))).toBeNull();
  });
});

describe("validateReason (AC-2, AC-5)", () => {
  it("needs 1–500 characters after trimming", () => {
    expect(validateReason("  Blurred  ")).toEqual({ data: "Blurred", error: null });
    expect(validateReason("   ").error).toMatch(/reason/i);
    expect(validateReason(undefined).error).toMatch(/reason/i);
    expect(validateReason("x".repeat(501)).error).toMatch(/500/);
  });
});

describe("validateDispatch (AC-8)", () => {
  const ok = { clientId: A, documentIds: [B], dispatchedOn: "2026-09-30", method: "hand_delivery", recipientName: " R. Kumar " };
  it("accepts a complete packet, trims the recipient and de-duplicates the documents", () => {
    expect(validateDispatch({ ...ok, documentIds: [B, B] }, { today: TODAY }).data)
      .toEqual({ clientId: A, documentIds: [B], dispatchedOn: "2026-09-30", method: "hand_delivery", courierName: null, trackingNo: null, recipientName: "R. Kumar" });
  });
  it("keeps courier details only for Courier", () => {
    expect(validateDispatch({ ...ok, courierName: "DTDC", trackingNo: "X1" }, { today: TODAY }).data).toMatchObject({ courierName: null, trackingNo: null });
    expect(validateDispatch({ ...ok, method: "courier", courierName: " DTDC ", trackingNo: "X1" }, { today: TODAY }).data).toMatchObject({ courierName: "DTDC", trackingNo: "X1" });
  });
  it("refuses: no originals, a future date, a date before receipt, no method, no or long recipient, long courier fields", () => {
    const fields = (input: Record<string, unknown>, latest?: string) =>
      validateDispatch({ ...ok, ...input }, { today: TODAY, latestReceivedOn: latest }).errors.map((e) => e.field);
    expect(fields({ documentIds: [] })).toEqual(["documentIds"]);
    expect(fields({ dispatchedOn: "2026-10-02" })).toEqual(["dispatchedOn"]);
    expect(fields({ dispatchedOn: "2026-09-29" }, "2026-09-30")).toEqual(["dispatchedOn"]);
    expect(fields({ dispatchedOn: "2026-02-30" })).toEqual(["dispatchedOn"]);
    expect(fields({ method: "email" })).toEqual(["method"]);
    expect(fields({ recipientName: "  " })).toEqual(["recipientName"]);
    expect(fields({ recipientName: "x".repeat(121) })).toEqual(["recipientName"]);
    expect(fields({ method: "courier", courierName: "x".repeat(101), trackingNo: "y".repeat(61) })).toEqual(["courierName", "trackingNo"]);
  });
});

describe("/documents Status and Return values (AC-14)", () => {
  // 13 (plan test list, approved 2026-10-31): "Return" becomes "Custody" with four values; return=ready keeps its URL.
  it("offers To review · Reviewed · Needs correction, and To place · In office · Ready to dispatch · Dispatched", () => {
    expect(DOC_STATUSES.map((s) => s.label)).toEqual(["To review", "Reviewed", "Needs correction"]);
    expect(DOC_RETURNS.map((s) => s.value)).toEqual(["to_place", "in_office", "ready", "dispatched"]);
  });
  it("round-trips the new values through the URL (enums only, no text)", () => {
    const f = { ...DEFAULT_FILTERS, status: "needs_correction" as const, return: "ready" as const };
    const q = filtersToQuery(f);
    expect(q).toBe("status=needs_correction&return=ready");
    expect(parseDocumentSearchParams(Object.fromEntries(new URLSearchParams(q)))).toEqual(f);
    expect(parseDocumentSearchParams({ return: "lost" })).toEqual(DEFAULT_FILTERS);
  });
  it("passes return to the search functions and counts as a filter", () => {
    expect(toSearchInput({ ...DEFAULT_FILTERS, return: "dispatched" }, "").filters).toEqual({ return: "dispatched" });
    expect(isFiltered({ ...DEFAULT_FILTERS, return: "ready" })).toBe(true);
    expect(isFiltered(DEFAULT_FILTERS)).toBe(false);
  });
});

describe("packetSummary (AC-10)", async () => {
  const { packetSummary } = await import("@/lib/dispatch/summary");
  it("says how many items were removed, and Cancelled when all were", () => {
    expect(packetSummary([{ removedAt: null }, { removedAt: null }])).toBeNull();
    expect(packetSummary([{ removedAt: "2026-09-01T00:00:00Z" }, { removedAt: null }, { removedAt: null }])).toBe("1 of 3 removed");
    expect(packetSummary([{ removedAt: "2026-09-01T00:00:00Z" }, { removedAt: "2026-09-02T00:00:00Z" }])).toBe("Cancelled");
  });
});
