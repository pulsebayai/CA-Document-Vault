import { describe, expect, it } from "vitest";
import { fixtureNames } from "../support/test-data";

// Chore test-isolation: concurrent CI/Regression runs lease a lane and get their own fixture offices and users.
describe("test lanes — fixture names", () => {
  it("local runs keep the pre-lane names (a developer's machine or a Claude session)", () => {
    const n = fixtureNames("local");
    expect(n.email("Admin")).toBe("e2e-admin@example.test");
    expect(n.office("plan")).toBe("e2e office plan");
  });

  it("each lane gets its own office and user names on the reserved .test domain", () => {
    const one = fixtureNames("1");
    const two = fixtureNames("2");
    expect(one.email("Admin")).toBe("e2e-admin-l1@example.test");
    expect(two.email("admin")).toBe("e2e-admin-l2@example.test");
    expect(one.office("plan")).toBe("e2e office plan #1");
    expect(two.office("plan")).not.toBe(one.office("plan"));
    expect(two.office("plan").startsWith("e2e office ")).toBe(true); // still recognisable as a test office
  });

  it("refuses anything but 1–9 or local", () => {
    for (const bad of ["0", "10", "", "lane1", "1 ", "../x"]) expect(() => fixtureNames(bad)).toThrow(/TEST_LANE/);
  });
});
