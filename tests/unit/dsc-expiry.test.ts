import { describe, expect, it } from "vitest";
import { DEFAULT_REMIND_DAYS, custodyText, expiryStatus, isDue } from "@/lib/dsc/expiry";

// Feature 14 spec AC-3, AC-8, AC-11 — the expiry status on the DSC list and Today. A DSC is valid through its
// expiry date; "due" = expires within the client's remind days, or already expired. Mirrors dsc_due's SQL
// (tests/rls/dsc-due.test.ts checks the same boundaries). Contract (plan step 4).

const TODAY = "2026-10-31";

describe("expiryStatus (AC-3)", () => {
  it("ok outside the window: 'Valid till 12 Mar 2027'", () => {
    expect(expiryStatus("2027-03-12", TODAY, 30)).toEqual({ tone: "ok", text: "Valid till 12 Mar 2027", daysLeft: 132 });
  });

  it("warn inside the window: 'Expires in N days', 'Expires tomorrow', 'Expires today'", () => {
    expect(expiryStatus("2026-11-23", TODAY, 30)).toEqual({ tone: "warn", text: "Expires in 23 days", daysLeft: 23 });
    expect(expiryStatus("2026-11-30", TODAY, 30).tone).toBe("warn"); // day 30 is inside
    expect(expiryStatus("2026-12-01", TODAY, 30).tone).toBe("ok"); // day 31 is not
    expect(expiryStatus("2026-11-01", TODAY, 30).text).toBe("Expires tomorrow");
    expect(expiryStatus(TODAY, TODAY, 30)).toEqual({ tone: "warn", text: "Expires today", daysLeft: 0 });
  });

  it("bad once passed: 'Expired 4 days ago', 'Expired yesterday'", () => {
    expect(expiryStatus("2026-10-27", TODAY, 30)).toEqual({ tone: "bad", text: "Expired 4 days ago", daysLeft: -4 });
    expect(expiryStatus("2026-10-30", TODAY, 30).text).toBe("Expired yesterday");
  });

  it("the window follows the client's setting", () => {
    expect(expiryStatus("2026-12-10", TODAY, 45).tone).toBe("warn");
    expect(expiryStatus("2026-11-10", TODAY, 7).tone).toBe("ok");
  });

  it("isDue matches the warn and bad tones; the default window is 30 days", () => {
    expect(DEFAULT_REMIND_DAYS).toBe(30);
    expect(isDue("2026-11-30", TODAY)).toBe(true);
    expect(isDue("2026-12-01", TODAY)).toBe(false);
    expect(isDue("2020-01-01", TODAY)).toBe(true);
    expect(isDue("2026-12-10", TODAY, 45)).toBe(true);
  });
});

describe("custodyText (AC-8)", () => {
  it("'In office' with no move or after a return; 'With <name> since <date>' when out", () => {
    expect(custodyText(null)).toBe("In office");
    expect(custodyText({ direction: "in", person_name: "Ravi", on_date: "2026-10-01" })).toBe("In office");
    expect(custodyText({ direction: "out", person_name: "Ravi", on_date: "2026-10-05" })).toBe("With Ravi since 5 Oct 2026");
  });
});
