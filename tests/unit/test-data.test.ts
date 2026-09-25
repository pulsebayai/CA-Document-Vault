import { describe, expect, it } from "vitest";
import { RUN_TAG, testEmail } from "../support/test-data";

describe("test data tagging", () => {
  it("tags test emails with the run tag and a reserved test domain", () => {
    const email = testEmail("Admin");
    expect(email.startsWith(RUN_TAG.toLowerCase())).toBe(true);
    expect(email.endsWith("@example.test")).toBe(true);
  });
});
