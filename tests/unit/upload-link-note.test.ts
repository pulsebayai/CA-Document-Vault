import { describe, expect, it } from "vitest";
import { notePii } from "@/lib/upload-links/note";

// Feature 10 AC-4 — the same vectors as tests/rls/upload-links-staff.test.ts (SQL private.note_pii).

describe("note PII check", () => {
  const refused: Array<[string, string]> = [
    ["PAN", "pan abcde1234f please"],
    ["GSTIN", "for 33ABCDE1234F1Z5"],
    ["TAN", "TAN CHEA12345B"],
    ["EMAIL", "send to ravi@example.com"],
    ["MOBILE", "call +91 98765 43210"],
    ["NUMBER", "account 1234 5678 9012"],
  ];
  for (const [kind, note] of refused) {
    it(`finds a ${kind}`, () => expect(notePii(note)).toBe(kind));
  }
  it("accepts ordinary notes", () => {
    for (const ok of ["Rent agreement for the new office, FY 2026-27 (2 pages)", "for the loan application", "Q2 statement", null, ""]) {
      expect(notePii(ok)).toBeNull();
    }
  });
});
