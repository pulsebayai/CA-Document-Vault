import { describe, expect, it } from "vitest";
import { buildReminderMessage, type AdHocItem, type ReminderItem } from "@/lib/reminders/message";

// Feature 10 — reminder text with an upload link and ad-hoc lines (spec AC-1, "Message builder"; plan step 3).
// 06's own rules stay covered, unedited, by tests/unit/reminder-message.test.ts.

const TOKEN = "A".repeat(43);
const sched: ReminderItem = { group: "Banking", type: "Bank statement", period: "Apr 2026", regKind: null, stateCode: null, overdueFrom: "2026-05-08" };
const adHoc: AdHocItem = { group: "Other", type: "Rent agreement", period: null, neededBy: "2026-05-30", note: "for the new office lease" };
const base = { clientName: "Asha Traders", senderName: "Priya Raman", firmName: "Kushal Associates", today: "2026-05-15" };

describe("upload-link message", () => {
  it("adds the link line and the open-until date", () => {
    const m = buildReminderMessage({ ...base, items: [sched], uploadLink: { url: `https://vault.example.in/u#${TOKEN}`, openUntil: "2026-05-29" } });
    expect(m.text).toContain("You can upload them securely here (open until 29 May):");
    expect(m.text).toContain(`https://vault.example.in/u#${TOKEN}`);
    expect(m.html).toContain(`<a href="https://vault.example.in/u#${TOKEN}">`);
  });

  it("lists ad-hoc items with note and needed-by date, and allows a request of ad-hoc items only", () => {
    const m = buildReminderMessage({ ...base, items: [], adHoc: [adHoc] });
    expect(m.text).toContain("Please send us the following documents:");
    expect(m.text).toContain("- Other · Rent agreement — for the new office lease — needed by 30 May");
  });

  it("scrubs notes and refuses any link that isn't exactly <origin>/u#<token>", () => {
    const m = buildReminderMessage({ ...base, items: [], adHoc: [{ ...adHoc, note: "see www.evil.example and 33ABCDE1234F1Z5" }] });
    expect(m.text).not.toMatch(/evil|33ABCDE/);
    for (const url of [`https://vault.example.in/u?t=${TOKEN}`, `https://vault.example.in/x#${TOKEN}`, `javascript:alert(1)//u#${TOKEN}`, `https://vault.example.in/u#short`]) {
      expect(() => buildReminderMessage({ ...base, items: [sched], uploadLink: { url, openUntil: "2026-05-29" } })).toThrow("BAD_LINK");
    }
  });

  it("still refuses a message with no items at all", () => {
    expect(() => buildReminderMessage({ ...base, items: [], adHoc: [] })).toThrow("NO_ITEMS");
  });
});
