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
