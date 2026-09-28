import { describe, expect, it } from "vitest";
import {
  allowedPeriodKinds, defaultPeriod, docIdFy, fyCodeOf, formatDocId, istDate,
} from "@/lib/documents/period";

// Spec 03 AC-3 (period defaults to the period that just ended) and AC-6 (DOC-ID = DOC-FY26-27-NNNNN, FY of the
// date added, India time). Codes match the period table: month "2026-08", quarter "2026-27-Q1", year "2026-27".

describe("istDate", () => {
  it("gives the India calendar date of an instant", () => {
    expect(istDate(new Date("2026-03-31T18:29:59Z"))).toBe("2026-03-31");
    expect(istDate(new Date("2026-03-31T18:30:00Z"))).toBe("2026-04-01");
  });
});

describe("fyCodeOf / docIdFy / formatDocId (AC-6, D7)", () => {
  it("FY starts on 1 April", () => {
    expect(fyCodeOf("2026-03-31")).toBe("2025-26");
    expect(fyCodeOf("2026-04-01")).toBe("2026-27");
    expect(fyCodeOf("2027-02-15")).toBe("2026-27");
    expect(fyCodeOf("2099-12-31")).toBe("2099-00");
  });

  it("formats the DOC-ID with the full FY; numbers pad to 5 and grow past 99,999", () => {
    expect(docIdFy("2026-27")).toBe("26-27");
    expect(formatDocId("2026-27", 1)).toBe("DOC-FY26-27-00001");
    expect(formatDocId("2031-32", 100000)).toBe("DOC-FY31-32-100000");
  });
});

describe("defaultPeriod (AC-3): the period that just ended", () => {
  it("monthly → last month, across the year boundary", () => {
    expect(defaultPeriod("monthly", "2026-09-28")).toEqual({ kind: "month", code: "2026-08" });
    expect(defaultPeriod("monthly", "2026-01-05")).toEqual({ kind: "month", code: "2025-12" });
    expect(defaultPeriod("monthly", "2026-04-01")).toEqual({ kind: "month", code: "2026-03" });
  });

  it("quarterly → last FY quarter (Q1 = Apr–Jun), across the FY boundary", () => {
    expect(defaultPeriod("quarterly", "2026-09-28")).toEqual({ kind: "quarter", code: "2026-27-Q1" });
    expect(defaultPeriod("quarterly", "2026-10-01")).toEqual({ kind: "quarter", code: "2026-27-Q2" });
    expect(defaultPeriod("quarterly", "2027-01-15")).toEqual({ kind: "quarter", code: "2026-27-Q3" });
    expect(defaultPeriod("quarterly", "2026-04-10")).toEqual({ kind: "quarter", code: "2025-26-Q4" });
    expect(defaultPeriod("quarterly", "2026-06-30")).toEqual({ kind: "quarter", code: "2025-26-Q4" });
  });

  it("yearly → last FY", () => {
    expect(defaultPeriod("yearly", "2026-09-28")).toEqual({ kind: "year", code: "2025-26" });
    expect(defaultPeriod("yearly", "2026-03-31")).toEqual({ kind: "year", code: "2024-25" });
  });

  it("as needed → Not needed", () => {
    expect(defaultPeriod("as_needed", "2026-09-28")).toBeNull();
  });
});

describe("allowedPeriodKinds (same rule as the DB trigger)", () => {
  it("month-types take month/quarter/year; quarter-types quarter/year; year-types year; untyped any", () => {
    expect(allowedPeriodKinds("month")).toEqual(["month", "quarter", "year"]);
    expect(allowedPeriodKinds("quarter")).toEqual(["quarter", "year"]);
    expect(allowedPeriodKinds("year")).toEqual(["year"]);
    expect(allowedPeriodKinds("none")).toEqual(["month", "quarter", "year"]);
  });
});
