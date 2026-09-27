import { describe, expect, it } from "vitest";
import { periodKindFor, validatePlanType, validateRemark } from "@/lib/validation/plan";

// Feature 02 step 9 — Client › Settings type dialog (spec AC-20). Same schedule rules as the catalogue
// (and the client_doc_type DB checks); the start period must be a period of the chosen frequency.

const periods = [
  { id: "11111111-1111-4111-8111-111111111111", kind: "month" as const },
  { id: "22222222-2222-4222-8222-222222222222", kind: "quarter" as const },
  { id: "33333333-3333-4333-8333-333333333333", kind: "year" as const },
];
const monthly = {
  frequency: "monthly", askAfterMonths: "1", askDay: "1", overdueAfterMonths: "1", overdueDay: "10", reminders: "on",
  startPeriodId: periods[0].id,
};

describe("validatePlanType", () => {
  it("accepts a scheduled type and converts form strings", () => {
    const r = validatePlanType(monthly, { periodKind: "month", periods });
    expect(r.errors).toEqual([]);
    expect(r.data).toEqual({
      frequency: "monthly", askAfterMonths: 1, askDay: 1, overdueAfterMonths: 1, overdueDay: 10, reminders: true,
      startPeriodId: periods[0].id,
    });
  });

  it("frequency can't be more often than the type's period", () => {
    expect(validatePlanType(monthly, { periodKind: "year", periods }).errors[0]?.field).toBe("frequency");
  });

  it("the start period must be a period of the chosen frequency", () => {
    const wrongKind = validatePlanType({ ...monthly, startPeriodId: periods[2].id }, { periodKind: "month", periods });
    expect(wrongKind.errors.map((e) => e.field)).toContain("startPeriodId");
    const missing = validatePlanType({ ...monthly, startPeriodId: "" }, { periodKind: "month", periods });
    expect(missing.errors.map((e) => e.field)).toContain("startPeriodId");
    const quarterly = validatePlanType({ ...monthly, frequency: "quarterly", startPeriodId: periods[1].id }, { periodKind: "month", periods });
    expect(quarterly.data?.startPeriodId).toBe(periods[1].id);
  });

  it("'as needed' clears the schedule, reminders and start period", () => {
    const r = validatePlanType({ ...monthly, frequency: "as_needed" }, { periodKind: "month", periods });
    expect(r.data).toMatchObject({
      frequency: "as_needed", askAfterMonths: null, askDay: null, overdueAfterMonths: null, overdueDay: null, reminders: false, startPeriodId: null,
    });
  });

  it("offsets must be complete, in range, and overdue on or after ask", () => {
    const r = validatePlanType({ ...monthly, askDay: "32", overdueAfterMonths: "0" }, { periodKind: "month", periods });
    expect(r.data).toBeNull();
    expect(r.errors.map((e) => e.field)).toEqual(expect.arrayContaining(["askDay"]));
    const early = validatePlanType({ ...monthly, overdueAfterMonths: "0" }, { periodKind: "month", periods });
    expect(early.errors.map((e) => e.field)).toContain("overdueDay");
  });
});

describe("periodKindFor", () => {
  it("maps a frequency to the period its start period is taken from", () => {
    expect(periodKindFor("monthly")).toBe("month");
    expect(periodKindFor("quarterly")).toBe("quarter");
    expect(periodKindFor("yearly")).toBe("year");
    expect(periodKindFor("as_needed")).toBeNull();
  });
});

describe("validateRemark", () => {
  it("is optional, trimmed and at most 500 characters", () => {
    expect(validateRemark("  client travelling ")).toEqual({ remark: "client travelling", error: null });
    expect(validateRemark("   ")).toEqual({ remark: null, error: null });
    expect(validateRemark(undefined)).toEqual({ remark: null, error: null });
    expect(validateRemark("x".repeat(501)).error).toMatch(/500/);
  });
});
