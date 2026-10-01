import { describe, expect, it } from "vitest";
import { initials, parseTodayParams, rowStatus, toTodayCard, todayHref, type TodayRowRaw } from "@/lib/today/shape";
import { dialogItems, historyOf, historyText, maskEmail, type HistoryEntry } from "@/lib/reminders/shape";

// Feature 06 — Today URL enums and view model (AC-2…AC-5), dialog ticks and row history (AC-7, AC-12).

describe("Today URL (AC-2, AC-3)", () => {
  it("accepts only the enums; defaults to My clients, no filter, first page", () => {
    expect(parseTodayParams({})).toEqual({ scope: "mine", show: null, page: 0 });
    expect(parseTodayParams({ scope: "everyone", show: "due_week", page: "2" })).toEqual({ scope: "everyone", show: "due_week", page: 2 });
    expect(parseTodayParams({ scope: "Acme Traders", show: "x", page: "-1" })).toEqual({ scope: "mine", show: null, page: 0 });
  });
  it("builds links with enums only", () => {
    expect(todayHref("mine", null)).toBe("/today");
    expect(todayHref("everyone", "overdue")).toBe("/today?scope=everyone&show=overdue");
  });
});

const row = (o: Partial<TodayRowRaw> = {}): TodayRowRaw => ({
  expected_doc_id: "e1", kind: "overdue", group: "GST", type: "Sales invoices / sales register", period: "Aug 2026",
  reg_kind: null, state_code: null, overdue_from: "2026-09-05", days_late: 27, reminders: true, reminded: 2,
  last_reminded_on: "2026-09-30", last_reminded_by: "Priya", last_channel: "email", ...o,
});

describe("Today rows and cards (AC-4, AC-5)", () => {
  it("row status text", () => {
    expect(rowStatus(row(), "2026-10-01")).toBe("Not received · 27 days late · reminded twice");
    expect(rowStatus(row({ days_late: 1, reminded: 0, reminders: false }), "2026-10-01")).toBe("Not received · 1 day late · reminders off");
    expect(rowStatus(row({ kind: "due_today", days_late: null, reminded: 1, overdue_from: "2026-10-02" }), "2026-10-01")).toBe("Due today · reminded once");
    expect(rowStatus(row({ kind: "due_week", days_late: null, reminded: 0, overdue_from: "2026-10-08" }), "2026-10-01")).toBe("Due 7 Oct");
  });

  it("card header, badge and row titles (registration by state, never number)", () => {
    const c = toTodayCard({
      client_id: "c1", name: "meenakshi traders", incharge: "Ravi", assignees: [{ group: "GST", name: "Priya" }],
      overdue: 0, due_week: 1, rows: [row({ reg_kind: "gstin", state_code: "33", kind: "due_week", days_late: null })],
    }, "2026-10-01");
    expect(c).toMatchObject({ initials: "MT", people: "Incharge Ravi · GST Priya", badge: "Due this week", badgeTone: "due" });
    expect(c.rows[0].title).toBe("GST · Sales invoices / sales register · Tamil Nadu · Aug 2026");
    expect(initials("  ")).toBe("?");
  });
});

describe("dialog and history (AC-7, AC-12)", () => {
  const h = (o: Partial<HistoryEntry>): HistoryEntry => ({ on: "2026-09-30", at: "2026-09-30T05:00:00Z", by: "Priya", channel: "email", status: "sent", ...o });

  it("history counts sent, suppressed, opened and logged — not failed or pending — and names the latest", () => {
    const hist = historyOf([h({}), h({ status: "failed", on: "2026-10-01" }), h({ status: "pending", on: "2026-10-01" }),
      h({ channel: "phone", status: "logged", on: "2026-10-01", by: "Ravi" })]);
    expect(hist.count).toBe(2);
    expect(historyText(hist, "2026-10-01")).toBe("reminded twice · last 1 Oct by Ravi (call)");
    expect(historyText(historyOf([]), "2026-10-01")).toBe("not reminded yet");
  });

  it("ticks every open item except reminders-off ones; most overdue first", () => {
    const items = dialogItems([
      { id: "b", group: "Banking", groupSort: 40, type: "Bank statement", period: "Sep 2026", periodStart: "2026-09-01", regKind: null, stateCode: null, overdueFrom: "2026-10-07", reminders: true, history: [] },
      { id: "a", group: "GST", groupSort: 10, type: "Sales", period: "Aug 2026", periodStart: "2026-08-01", regKind: null, stateCode: null, overdueFrom: "2026-09-05", reminders: false, history: [] },
    ], "2026-10-01");
    expect(items.map((i) => [i.id, i.ticked, i.kind])).toEqual([["a", false, "overdue"], ["b", true, "due"]]);
    expect(items[0].stateText).toBe("Overdue · 27 days late");
  });

  it("masks the address", () => {
    expect(maskEmail("abc@client.in")).toBe("a…@…");
  });
});
