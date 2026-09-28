import { describe, expect, it } from "vitest";
import { RUN_TAG, testEmail, uniqueTestEmail } from "../support/test-data";

describe("test data addresses", () => {
  it("fixture users have stable addresses on the reserved .test domain", () => {
    expect(testEmail("Admin")).toBe("e2e-admin@example.test");
    expect(testEmail("admin")).toBe(testEmail("Admin"));
  });
  it("unique addresses carry the run tag", () => {
    const email = uniqueTestEmail("invitee");
    expect(email.startsWith(RUN_TAG.toLowerCase())).toBe(true);
    expect(email.endsWith("@example.test")).toBe(true);
  });
});

describe("synthetic identifiers", () => {
  it("are valid under the app's own validators and carry the requested type letter", async () => {
    const { isPan, isGstin, isTan, panOfGstin, panMatchesType } = await import("@/lib/validation/identifiers");
    const { testPan, testGstin, testTan } = await import("../support/test-data");
    const pan = testPan("P", 7);
    expect(pan).toBe("ZZZPZ0007Z");
    expect(isPan(pan)).toBe(true);
    expect(panMatchesType(pan, "individual")).toBe("ok");
    expect(panMatchesType(testPan("C", 1), "private_ltd")).toBe("ok");
    expect(isGstin(testGstin(pan))).toBe(true);
    expect(panOfGstin(testGstin(pan))).toBe(pan);
    expect(isTan(testTan(42))).toBe(true);
  });

  it("current period codes follow the Indian FY (Q1 = Apr–Jun)", async () => {
    const { currentPeriodCodes } = await import("../support/test-data");
    expect(currentPeriodCodes(new Date("2026-09-27T06:00:00Z"))).toEqual({ month: "2026-09", quarter: "2026-27-Q2", year: "2026-27" });
    expect(currentPeriodCodes(new Date("2027-03-31T20:00:00Z"))).toEqual({ month: "2027-04", quarter: "2027-28-Q1", year: "2027-28" }); // 01:30 IST 1 Apr
    expect(currentPeriodCodes(new Date("2027-01-15T06:00:00Z"))).toEqual({ month: "2027-01", quarter: "2026-27-Q4", year: "2026-27" });
  });
});
