import { describe, expect, it } from "vitest";
import { decidedBy, governanceErrorMessage, isStaleDecision, notificationText } from "@/lib/catalogue/messages";
import { validateDecisionComment, validateTypeEdits } from "@/lib/validation/catalogue";

// Feature 05 step 3: database codes → plain words, notification text (AC-13), Edit & approve validation (AC-3),
// decision comments (AC-9, AC-12). Pure functions.

const G = "11111111-1111-4111-8111-111111111111";

describe("governanceErrorMessage", () => {
  it.each([
    ["ALREADY_DECIDED: 1b6…", /Already decided/],
    ["DUPLICATE_TYPE: an approved type with this name already exists in this group", /Merge into/],
    ["PERIOD_KIND: 2 documents don't fit a year type", /periods this type can't hold/],
    ["HAS_DOCUMENTS: 3 documents use this type", /Merge it into an approved type/],
    ["TARGET_INVALID: merge into an approved, active type", /approved type the firm collects/],
    ["REASON_REQUIRED: give a reason", /reason/],
    ["COMMENT_TOO_LONG: a comment has at most 500 characters", /500 characters/],
    ["ROLE_REQUIRED: only Admin or Manager can decide proposed types", /Admin or Manager/],
    ["new row for relation \"doc_type\" violates check constraint \"doc_type_offsets_complete\"", /schedule/],
  ])("%s", (raw, expected) => {
    expect(governanceErrorMessage(raw)).toMatch(expected);
  });

  it("never echoes the database text for something unknown", () => {
    expect(governanceErrorMessage("some internal failure with Acme Traders")).toBe("Couldn't save. Please try again.");
  });

  it("stale decisions are recognised and the decider's id is read from the code", () => {
    expect(isStaleDecision("ALREADY_DECIDED: x")).toBe(true);
    expect(isStaleDecision("NOT_PROPOSED: this type is not waiting")).toBe(true);
    expect(isStaleDecision("HAS_DOCUMENTS: 1")).toBe(false);
    expect(decidedBy("ALREADY_DECIDED: 27002DB8-2E30-43A3-8CB7-8D8C5469119A")).toBe("27002db8-2e30-43a3-8cb7-8d8c5469119a");
    expect(decidedBy("NOT_PROPOSED")).toBeNull();
  });
});

describe("notificationText (AC-13)", () => {
  it("the three decisions, as in the spec", () => {
    expect(notificationText({ decision: "approved", name: "Salary register", groupName: "Payroll" })).toBe("Salary register (Payroll) was approved.");
    expect(notificationText({ decision: "merged", name: "Salary register", targetName: "Payroll register" })).toBe("Salary register was merged into Payroll register.");
    expect(notificationText({ decision: "rejected", name: "Salary register", comment: "Not needed" })).toBe("Salary register was rejected: Not needed");
  });

  it("an approval that moved group names the new type", () => {
    expect(notificationText({ decision: "approved", name: "Director KYC", targetName: "Director KYC (DIR-3)", groupName: "ROC/MCA" }))
      .toBe("Director KYC was approved as Director KYC (DIR-3) (ROC/MCA).");
  });
});

describe("validateTypeEdits (AC-3: 02's add-type rules)", () => {
  const base = { name: " Payroll summary ", aliases: "Pay sheet, pay sheet", groupId: G, periodKind: "month" };

  it("as needed: no offsets, no reminders; aliases de-duplicated", () => {
    const v = validateTypeEdits({ ...base, frequency: "as_needed" });
    expect(v.data).toEqual({
      name: "Payroll summary", aliases: ["Pay sheet"], doc_group_id: G, period_kind: "month", default_frequency: "as_needed",
      ask_after_months: null, ask_day: null, overdue_after_months: null, overdue_day: null, reminders: false,
    });
  });

  it("scheduled: offsets required and overdue on or after ask", () => {
    expect(validateTypeEdits({ ...base, frequency: "monthly" }).errors.map((e) => e.field)).toContain("askDay");
    const late = validateTypeEdits({ ...base, frequency: "monthly", askAfterMonths: "1", askDay: "10", overdueAfterMonths: "1", overdueDay: "5" });
    expect(late.errors.map((e) => e.field)).toContain("overdueDay");
    const ok = validateTypeEdits({ ...base, frequency: "monthly", askAfterMonths: "1", askDay: "1", overdueAfterMonths: "1", overdueDay: "5", reminders: "on" });
    expect(ok.data).toMatchObject({ default_frequency: "monthly", ask_after_months: 1, overdue_day: 5, reminders: true });
  });

  it("frequency can't be more often than the period; group and period are required", () => {
    expect(validateTypeEdits({ ...base, periodKind: "year", frequency: "monthly" }).errors.map((e) => e.field)).toContain("frequency");
    const v = validateTypeEdits({ name: "X", frequency: "as_needed" });
    expect(v.errors.map((e) => e.field)).toEqual(expect.arrayContaining(["groupId", "periodKind"]));
  });
});

describe("validateDecisionComment (AC-9, AC-12)", () => {
  it("optional comment: blank → null, trimmed, ≤ 500", () => {
    expect(validateDecisionComment("  ", false)).toEqual({ data: null, error: null });
    expect(validateDecisionComment("  ok  ", false)).toEqual({ data: "ok", error: null });
    expect(validateDecisionComment("x".repeat(501), false).error).toMatch(/500/);
  });

  it("Reject's reason is required, 1–500", () => {
    expect(validateDecisionComment(" ", true).error).toMatch(/reason/);
    expect(validateDecisionComment("x".repeat(501), true).error).toMatch(/reason/);
    expect(validateDecisionComment("Not a compliance document", true).data).toBe("Not a compliance document");
  });
});
