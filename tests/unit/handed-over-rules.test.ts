import { describe, expect, it } from "vitest";
import { RECEIVED_AS, validateHandedOver } from "@/lib/validation/document";

// Feature 12, spec AC-8, AC-14 (amended by plan R2 and decision D1, 30 Oct): "Handed over by" is ONE text field,
// required on every staff screen — checked here, by the server actions — for a new hard copy or a change to hard
// copy. The database only checks the shape. Written before the code (plan step 1; changed for D1).

describe("validateHandedOver (AC-14, D1)", () => {
  it("a new hard copy needs it; the text is trimmed", () => {
    expect(validateHandedOver({ receivedAs: "hard_copy" }, { existing: null })).toEqual({
      data: null,
      errors: [{ field: "handedOverName", message: "Say who handed it over." }],
    });
    expect(validateHandedOver({ receivedAs: "hard_copy", handedOverName: "  Blue Dart — Suresh  " }, { existing: null }))
      .toEqual({ data: { handedOverName: "Blue Dart — Suresh" }, errors: [] });
  });

  it("refuses more than 120 characters", () => {
    expect(validateHandedOver({ receivedAs: "hard_copy", handedOverName: "x".repeat(121) }, { existing: null }).errors)
      .toEqual([{ field: "handedOverName", message: "Too long (120 characters max)." }]);
  });

  it("a soft copy never carries it (cleared, no error)", () => {
    expect(validateHandedOver({ receivedAs: "soft_copy", handedOverName: "Ravi" }, { existing: null }))
      .toEqual({ data: { handedOverName: null }, errors: [] });
  });

  it("changing a soft copy to a hard copy needs it", () => {
    expect(validateHandedOver({ receivedAs: "hard_copy" }, { existing: { receivedAs: "soft_copy", handedOverName: null } }).errors)
      .toHaveLength(1);
  });

  it("an existing hard copy recorded before 12 (none set) can be edited without it", () => {
    expect(validateHandedOver({ receivedAs: "hard_copy" }, { existing: { receivedAs: "hard_copy", handedOverName: null } }))
      .toEqual({ data: { handedOverName: null }, errors: [] });
  });

  it("once set it can be changed but not cleared", () => {
    const existing = { receivedAs: "hard_copy", handedOverName: "Ravi" };
    expect(validateHandedOver({ receivedAs: "hard_copy", handedOverName: " " }, { existing }).errors).toHaveLength(1);
    expect(validateHandedOver({ receivedAs: "hard_copy", handedOverName: "Gate security" }, { existing }).errors).toEqual([]);
  });

  it("legacy 'original' input (no UI sends it) is not asked for it", () => {
    expect(validateHandedOver({ receivedAs: "original" }, { existing: null }).errors).toEqual([]);
  });
});

describe("Received as options (AC-8)", () => {
  it("staff choose Soft copy or Hard copy; Returnable is a separate checkbox", () => {
    expect(RECEIVED_AS.map((r) => r.label)).toEqual(["Soft copy", "Hard copy"]);
  });
});
