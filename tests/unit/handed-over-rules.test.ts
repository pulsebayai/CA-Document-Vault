import { describe, expect, it } from "vitest";
import { HANDED_OVER_KINDS, RECEIVED_AS, validateHandedOver } from "@/lib/validation/document";

// Feature 12, spec AC-8, AC-14 (amended by plan R2): "Handed over by" is required on every staff screen — checked
// here, by the server actions — for a new hard copy or a change to hard copy. The database only checks the shape.
// Written before the code (plan step 1).

describe("Handed over by kinds (AC-14)", () => {
  it("are Client's staff, Courier, Security and Other", () => {
    expect(HANDED_OVER_KINDS.map((k) => [k.value, k.label])).toEqual([
      ["client_staff", "Client's staff"], ["courier", "Courier"], ["security", "Security"], ["other", "Other"],
    ]);
  });
});

describe("validateHandedOver (AC-14)", () => {
  const ok = { handedOverKind: "courier", handedOverName: "  Blue Dart — Suresh  " };

  it("a new hard copy needs both a kind and a name; the name is trimmed", () => {
    expect(validateHandedOver({ receivedAs: "hard_copy" }, { existing: null })).toEqual({
      data: null,
      errors: [
        { field: "handedOverKind", message: "Say who handed it over." },
        { field: "handedOverName", message: "Give their name." },
      ],
    });
    expect(validateHandedOver({ receivedAs: "hard_copy", ...ok }, { existing: null }))
      .toEqual({ data: { handedOverKind: "courier", handedOverName: "Blue Dart — Suresh" }, errors: [] });
  });

  it("refuses an unknown kind and a name over 120 characters", () => {
    expect(validateHandedOver({ receivedAs: "hard_copy", handedOverKind: "drone", handedOverName: "X" }, { existing: null }).errors)
      .toEqual([{ field: "handedOverKind", message: "Say who handed it over." }]);
    expect(validateHandedOver({ receivedAs: "hard_copy", handedOverKind: "other", handedOverName: "x".repeat(121) }, { existing: null }).errors)
      .toEqual([{ field: "handedOverName", message: "Name is too long (120 characters max)." }]);
  });

  it("a soft copy never carries it (cleared, no error)", () => {
    expect(validateHandedOver({ receivedAs: "soft_copy", ...ok }, { existing: null }))
      .toEqual({ data: { handedOverKind: null, handedOverName: null }, errors: [] });
  });

  it("changing a soft copy to a hard copy needs it", () => {
    expect(validateHandedOver({ receivedAs: "hard_copy" }, { existing: { receivedAs: "soft_copy", handedOverKind: null } }).errors)
      .toHaveLength(2);
  });

  it("an existing hard copy recorded before 12 (none set) can be edited without it", () => {
    expect(validateHandedOver({ receivedAs: "hard_copy" }, { existing: { receivedAs: "hard_copy", handedOverKind: null } }))
      .toEqual({ data: { handedOverKind: null, handedOverName: null }, errors: [] });
  });

  it("once set it can be changed but not cleared", () => {
    const existing = { receivedAs: "hard_copy", handedOverKind: "courier" };
    expect(validateHandedOver({ receivedAs: "hard_copy" }, { existing }).errors).toHaveLength(2);
    expect(validateHandedOver({ receivedAs: "hard_copy", handedOverKind: "security", handedOverName: "Gate" }, { existing }).errors).toEqual([]);
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
