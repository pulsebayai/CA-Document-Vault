import { describe, expect, it } from "vitest";
import { parseTodayParams, toDocRow, todayHref, type TodayDocRowRaw } from "@/lib/today/shape";

// Feature 13 (spec AC-11, S4) — Today's "To place in office" and "In office > 30 days": URL values and row text.

const base: TodayDocRowRaw = {
  document_id: "d1", kind: "to_place", doc_code: "DOC-FY26-27-00010", group: "Banking", type: "Bank statement", period: "Apr 2026",
  received_as: "hard_copy", received_on: "2026-10-01", reviewed_on: "2026-10-02", reviewed_by: "Ravi", needs_correction: false,
  returnable: true, in_office_on: null,
};

describe("Today custody rows (AC-11)", () => {
  it("show=to_place and show=held round-trip through the URL", () => {
    expect(parseTodayParams({ show: "to_place" }).show).toBe("to_place");
    expect(parseTodayParams({ show: "held" }).show).toBe("held");
    expect(todayHref("everyone", "held")).toBe("/today?scope=everyone&show=held");
  });

  it("To place: the review and 'not in office yet'", () => {
    expect(toDocRow(base, "2026-10-31")).toMatchObject({ label: "To place in office", detail: "Reviewed 2 Oct by Ravi · not in office yet", original: true });
    expect(toDocRow({ ...base, needs_correction: true }, "2026-10-31").detail).toBe("Needs correction · not in office yet");
  });

  it("Held: since when it has been in the office", () => {
    expect(toDocRow({ ...base, kind: "held", in_office_on: "2026-09-20" }, "2026-10-31"))
      .toMatchObject({ label: "In office > 30 days", detail: "In office since 20 Sep · still to go back" });
  });
});
