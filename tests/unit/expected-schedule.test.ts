import { describe, expect, it } from "vitest";
import { expectedState, isOpen, offsetDate, scheduleDates, todayInIndia } from "@/lib/expected/schedule";

// Feature 04 step 3 — the TypeScript mirror of private.offset_date / schedule_dates (spec "Key definitions") and the
// shown state of an expected document (spec "Stored status / Shown state", AC-13 state text). The database is the
// source of the stored dates; tests/rls/expected-docs.test.ts checks this mirror against every item it generated.

describe("offsetDate (period end + N months, on day D clamped to the month's last day)", () => {
  it.each([
    ["2026-09-30", 1, 1, "2026-10-01"], // spec example: Sep 2026 sales, ask +1/1
    ["2026-09-30", 1, 5, "2026-10-05"], // … overdue +1/5
    ["2026-03-31", 1, 31, "2026-04-30"], // 31 → 30 in April
    ["2026-03-31", 2, 31, "2026-05-31"],
    ["2027-12-31", 2, 31, "2028-02-29"], // leap year
    ["2026-12-31", 2, 31, "2027-02-28"], // not a leap year
    ["2026-12-31", 1, 7, "2027-01-07"], // across the calendar year
    ["2026-03-31", 2, 16, "2026-05-16"], // FY end + 2 months (Form 16)
    ["2028-03-31", 0, 15, "2028-03-15"], // offset 0: in the period's own last month
    ["2028-03-31", 0, 31, "2028-03-31"],
    ["2026-06-30", 13, 31, "2027-07-31"], // more than a year
  ] as const)("%s + %i months, day %i → %s", (end, months, day, expected) => {
    expect(offsetDate(end, months, day)).toBe(expected);
  });

  it("rejects malformed input instead of guessing", () => {
    expect(() => offsetDate("2026-13-01", 1, 1)).toThrow();
    expect(() => offsetDate("2026-09-30", 1, 0)).toThrow();
    expect(() => offsetDate("2026-09-30", -1, 1)).toThrow();
  });
});

describe("scheduleDates", () => {
  it("gives ask date, overdue-from date and due-by (the day before overdue from)", () => {
    expect(scheduleDates("2026-09-30", { askAfterMonths: 1, askDay: 1, overdueAfterMonths: 1, overdueDay: 5 }))
      .toEqual({ askOn: "2026-10-01", overdueFrom: "2026-10-05", dueBy: "2026-10-04" });
    expect(scheduleDates("2026-02-28", { askAfterMonths: 0, askDay: 1, overdueAfterMonths: 1, overdueDay: 1 }))
      .toEqual({ askOn: "2026-02-01", overdueFrom: "2026-03-01", dueBy: "2026-02-28" });
  });
});

describe("todayInIndia", () => {
  it("is the calendar date in IST (UTC+5:30)", () => {
    expect(todayInIndia(new Date("2026-09-30T18:29:59Z"))).toBe("2026-09-30");
    expect(todayInIndia(new Date("2026-09-30T18:30:00Z"))).toBe("2026-10-01");
  });
});

describe("expectedState (spec Shown state; AC-13 state text)", () => {
  const item = { status: "pending" as const, overdueFrom: "2026-10-05", onHold: false };

  it("Due <date> before the due-by day", () => {
    expect(expectedState(item, "2026-10-01")).toEqual({ kind: "due", text: "Due 4 Oct", dueBy: "2026-10-04" });
  });

  it("Due today on the due-by day", () => {
    expect(expectedState(item, "2026-10-04")).toMatchObject({ kind: "due_today", text: "Due today" });
  });

  it("Overdue · N days late from the overdue-from date (1 day late on that date)", () => {
    expect(expectedState(item, "2026-10-05")).toEqual({ kind: "overdue", text: "Overdue · 1 day late", daysLate: 1 });
    expect(expectedState(item, "2026-10-17")).toEqual({ kind: "overdue", text: "Overdue · 13 days late", daysLate: 13 });
  });

  it("shows the year when the due-by date is in another year", () => {
    expect(expectedState({ ...item, overdueFrom: "2027-01-05" }, "2026-12-20").text).toBe("Due 4 Jan 2027");
  });

  it("On hold for a pending item of a paused row or group, whatever the dates", () => {
    expect(expectedState({ ...item, onHold: true }, "2026-12-01")).toEqual({ kind: "on_hold", text: "On hold" });
  });

  it("Received <date> · DOC-ID", () => {
    expect(expectedState({ status: "received", overdueFrom: "2026-10-05", onHold: false, receivedOn: "2026-10-03", docCode: "DOC-FY26-27-00042" }, "2026-10-10"))
      .toEqual({ kind: "received", text: "Received 3 Oct · DOC-FY26-27-00042" });
    expect(expectedState({ status: "received", overdueFrom: "2026-10-05", onHold: true, receivedOn: "2026-10-03" }, "2026-10-10").text)
      .toBe("Received 3 Oct"); // received wins over on hold; no DOC-ID when not known
  });

  it("Not needed · reason (waived)", () => {
    expect(expectedState({ status: "waived", overdueFrom: "2026-10-05", onHold: false, waivedReason: "Client closed GST" }, "2026-10-10"))
      .toEqual({ kind: "not_needed", text: "Not needed · Client closed GST" });
    expect(expectedState({ status: "waived", overdueFrom: "2026-10-05", onHold: false }, "2026-10-10").text).toBe("Not needed");
  });

  it("isOpen: Due, Due today and Overdue count; On hold, Received and Not needed don't (Expected tab count, AC-13)", () => {
    const kinds = ["due", "due_today", "overdue", "on_hold", "received", "not_needed"] as const;
    expect(kinds.filter((k) => isOpen(k))).toEqual(["due", "due_today", "overdue"]);
  });
});
