import { describe, expect, it } from "vitest";
import {
  allowedFrequencies, codeFromName, formatOffset, parseAliases, scheduleSummary, validateDocGroup, validateDocType,
} from "@/lib/validation/catalogue";
import { canAddFinancialYear, canManageCatalogue } from "@/lib/auth/roles";

// Spec 02 AC-2, AC-3, AC-6 — one validator for the catalogue dialogs and the server actions.
const monthly = {
  name: "Sales invoices", aliases: "", frequency: "monthly", askAfterMonths: "1", askDay: "1",
  overdueAfterMonths: "1", overdueDay: "5", reminders: "on", usedFor: "GSTR-1", active: "on",
};

describe("validateDocType", () => {
  it("accepts a scheduled client document and converts form strings", () => {
    const r = validateDocType(monthly, { source: "client", periodKind: "month" });
    expect(r.errors).toEqual([]);
    expect(r.data).toEqual({
      name: "Sales invoices", aliases: [], defaultFrequency: "monthly", askAfterMonths: 1, askDay: 1,
      overdueAfterMonths: 1, overdueDay: 5, reminders: true, usedFor: "GSTR-1", active: true,
    });
  });

  it("requires a name (≤ 120 characters)", () => {
    expect(validateDocType({ ...monthly, name: "  " }, { source: "client", periodKind: "month" }).errors[0]?.field).toBe("name");
    expect(validateDocType({ ...monthly, name: "x".repeat(121) }, { source: "client", periodKind: "month" }).errors[0]?.field).toBe("name");
  });

  it("a scheduled type needs complete offsets within range", () => {
    const r = validateDocType({ ...monthly, askDay: "", overdueAfterMonths: "13" }, { source: "client", periodKind: "month" });
    expect(r.errors.map((e) => e.field).sort()).toEqual(["askDay", "overdueAfterMonths"]);
    expect(validateDocType({ ...monthly, overdueDay: "32" }, { source: "client", periodKind: "month" }).errors[0]?.field).toBe("overdueDay");
  });

  it("overdue cannot come before the ask date (same rule as the DB check)", () => {
    const r = validateDocType({ ...monthly, askAfterMonths: "2", overdueAfterMonths: "1" }, { source: "client", periodKind: "month" });
    expect(r.errors).toEqual([{ field: "overdueDay", message: "Overdue must be on or after the ask date." }]);
    expect(validateDocType({ ...monthly, askDay: "5", overdueDay: "5" }, { source: "client", periodKind: "month" }).errors).toEqual([]);
  });

  it("'as needed' clears the schedule and reminders", () => {
    const r = validateDocType({ ...monthly, frequency: "as_needed" }, { source: "client", periodKind: "month" });
    expect(r.errors).toEqual([]);
    expect(r.data).toMatchObject({ defaultFrequency: "as_needed", askAfterMonths: null, askDay: null, overdueAfterMonths: null, overdueDay: null, reminders: false });
  });

  it("frequency must fit the type's period (a yearly document can't be collected monthly)", () => {
    expect(validateDocType({ ...monthly, frequency: "monthly" }, { source: "client", periodKind: "year" }).errors[0]?.field).toBe("frequency");
    expect(validateDocType({ ...monthly, frequency: "monthly" }, { source: "client", periodKind: "none" }).errors[0]?.field).toBe("frequency");
    expect(validateDocType({ ...monthly, frequency: "bogus" }, { source: "client", periodKind: "month" }).errors[0]?.field).toBe("frequency");
  });

  it("firm records are never scheduled or reminded, whatever the form says", () => {
    const r = validateDocType(monthly, { source: "firm", periodKind: "month" });
    expect(r.errors).toEqual([]);
    expect(r.data).toMatchObject({ defaultFrequency: "as_needed", askAfterMonths: null, reminders: false });
  });

  it("unchecked boxes are false; long 'Used for' is rejected", () => {
    const r = validateDocType({ ...monthly, reminders: undefined, active: undefined }, { source: "client", periodKind: "month" });
    expect(r.data).toMatchObject({ reminders: false, active: false });
    expect(validateDocType({ ...monthly, usedFor: "x".repeat(201) }, { source: "client", periodKind: "month" }).errors[0]?.field).toBe("usedFor");
  });
});

describe("parseAliases", () => {
  it("splits on commas/new lines, trims, drops blanks and case-insensitive duplicates", () => {
    expect(parseAliases(" Form 130, form 130\nForm 16 ,, ")).toEqual({ aliases: ["Form 130", "Form 16"], error: null });
  });
  it("limits count and length", () => {
    expect(parseAliases(Array.from({ length: 21 }, (_, i) => `a${i}`).join(",")).error).toMatch(/20/);
    expect(parseAliases("x".repeat(81)).error).toMatch(/80/);
  });
});

describe("allowedFrequencies", () => {
  it("follows the period kind", () => {
    expect(allowedFrequencies("month")).toEqual(["monthly", "quarterly", "yearly", "as_needed"]);
    expect(allowedFrequencies("quarter")).toEqual(["quarterly", "yearly", "as_needed"]);
    expect(allowedFrequencies("year")).toEqual(["yearly", "as_needed"]);
    expect(allowedFrequencies("none")).toEqual(["as_needed"]);
  });
});

describe("validateDocGroup", () => {
  it("requires a name ≤ 80 characters", () => {
    expect(validateDocGroup({ name: " Stock audit " })).toEqual({ data: { name: "Stock audit" }, errors: [] });
    expect(validateDocGroup({ name: "" }).errors[0]?.field).toBe("name");
    expect(validateDocGroup({ name: "x".repeat(81) }).errors[0]?.field).toBe("name");
  });
});

describe("schedule wording (offsets from period end)", () => {
  it("describes offsets in plain words", () => {
    expect(formatOffset(0, 25)).toBe("25th of the period's last month");
    expect(formatOffset(1, 1)).toBe("1st of the next month");
    expect(formatOffset(2, 22)).toBe("22nd, 2 months after");
    expect(formatOffset(1, 3)).toBe("3rd of the next month");
    expect(formatOffset(1, 11)).toBe("11th of the next month");
    expect(formatOffset(1, 31)).toBe("31st of the next month");
  });
  it("summarises a type's schedule", () => {
    expect(scheduleSummary({ ask_after_months: 1, ask_day: 1, overdue_after_months: 1, overdue_day: 5 }))
      .toBe("Ask 1st of the next month · overdue from 5th of the next month");
    expect(scheduleSummary({ ask_after_months: null, ask_day: null, overdue_after_months: null, overdue_day: null })).toBe("");
  });
});

describe("codeFromName", () => {
  it("makes a DB-safe code with a unique suffix", () => {
    expect(codeFromName("E-way bills (GST)", "a1b2")).toBe("e_way_bills_gst_a1b2");
    expect(codeFromName("आयकर", "zz99")).toBe("item_zz99");
    expect(codeFromName("x".repeat(100), "abcd")).toMatch(/^[a-z0-9_]{1,40}$/);
  });
});

describe("catalogue roles (AC-5, AC-6)", () => {
  it("Admin and Manager manage the catalogue; only Admin adds a financial year", () => {
    expect(["admin", "manager", "staff", "limited"].map((r) => canManageCatalogue(r as never))).toEqual([true, true, false, false]);
    expect(["admin", "manager", "staff", "limited"].map((r) => canAddFinancialYear(r as never))).toEqual([true, false, false, false]);
  });
});
