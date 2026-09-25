import { describe, expect, it } from "vitest";
import { initials, normaliseEmail, ROLE_LABEL } from "@/lib/auth/roles";

describe("initials", () => {
  it("uses first and last name", () => expect(initials("Raja Krishna Kumar")).toBe("RK"));
  it("uses first two letters for a single name", () => expect(initials("Priya")).toBe("PR"));
  it("handles extra spaces and empty input", () => {
    expect(initials("  ravi   s ")).toBe("RS");
    expect(initials("   ")).toBe("?");
  });
});

describe("normaliseEmail", () => {
  it("trims and lower-cases", () => expect(normaliseEmail("  RajaK@Pulsebay.IN ")).toBe("rajak@pulsebay.in"));
});

describe("role labels", () => {
  it("match the mockup wording", () => expect(ROLE_LABEL.limited).toBe("Staff (limited)"));
});
