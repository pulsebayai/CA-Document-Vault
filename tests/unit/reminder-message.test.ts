import { describe, expect, it } from "vitest";
import { buildReminderMessage, whatsappUrl, type ReminderItem } from "@/lib/reminders/message";

// Feature 06 — AC-10 message content (and AC-9's WhatsApp link). Pure builder; same text for email and WhatsApp.

const item = (o: Partial<ReminderItem> = {}): ReminderItem => ({
  group: "GST", type: "Sales invoices / sales register", period: "Aug 2026", regKind: null, stateCode: null,
  overdueFrom: "2026-09-05", ...o,
});
const base = { clientName: "Meenakshi Traders", senderName: "Priya Raman", firmName: "Kushal Associates", today: "2026-10-01" };

describe("buildReminderMessage (AC-10)", () => {
  it("greets the client, lists one line per item and signs off with the sender and the firm", () => {
    const m = buildReminderMessage({ ...base, items: [item(), item({ group: "Banking", type: "Bank statement", period: "Sep 2026", overdueFrom: "2026-10-08" })] });
    const lines = m.text.split("\n");
    expect(lines[0]).toBe("Dear Meenakshi Traders,");
    expect(m.text).toContain("GST · Sales invoices / sales register · August 2026 — overdue since 5 Sep");
    expect(m.text).toContain("Banking · Bank statement · September 2026 — due by 7 Oct");
    expect(m.text.trimEnd().split("\n").slice(-3)).toEqual(["Regards,", "Priya Raman", "Kushal Associates"]);
    expect(m.subject).toBe("Documents pending — Kushal Associates");
  });

  it("says 'due today' on the due date and keeps quarter / year labels", () => {
    const m = buildReminderMessage({ ...base, items: [
      item({ period: "Q2 2026-27 (Jul–Sep)", overdueFrom: "2026-10-02" }),
      item({ group: "Income Tax", type: "Form 16 from employer", period: "FY 2025-26", overdueFrom: "2026-06-10" }),
    ] });
    expect(m.text).toContain("GST · Sales invoices / sales register · Q2 2026-27 (Jul–Sep) — due today");
    expect(m.text).toContain("Income Tax · Form 16 from employer · FY 2025-26 — overdue since 10 Jun");
  });

  it("names a registration by its state or kind, never by number", () => {
    const m = buildReminderMessage({ ...base, items: [
      item({ regKind: "gstin", stateCode: "33" }),
      item({ group: "TDS/TCS", type: "Salary paid to employees (for TDS)", regKind: "tan", stateCode: null }),
    ] });
    expect(m.text).toContain("GST · Sales invoices / sales register (Tamil Nadu GSTIN) · August 2026");
    expect(m.text).toContain("TDS/TCS · Salary paid to employees (for TDS) (TAN) · August 2026");
  });

  it("never carries PAN, GSTIN/TAN numbers, links or DOC-IDs, even if a name contains one", () => {
    const m = buildReminderMessage({ ...base,
      clientName: "Arun ZZZPZ1234Z Traders",
      items: [item({ type: "Invoices 33ZZZPZ1234Z1Z5 see https://evil.example/x and www.x.com", period: "Aug 2026" }),
        item({ type: "Challan ZZZZ12345Z for DOC-FY26-27-00012" })] });
    for (const body of [m.text, m.html, m.subject]) {
      expect(body).not.toMatch(/[A-Z]{5}[0-9]{4}[A-Z]/);
      expect(body).not.toMatch(/[A-Z]{4}[0-9]{5}[A-Z]/);
      expect(body).not.toMatch(/https?:|www\./i);
      expect(body).not.toMatch(/DOC-FY/);
    }
    expect(m.text).toContain("Dear Arun Traders,");
  });

  it("also catches lower-case PAN / GSTIN / TAN (review N-5)", () => {
    const m = buildReminderMessage({ ...base, clientName: "Arun zzzpz1234z Traders",
      items: [item({ type: "Invoices 33zzzpz1234z1z5 and zzzz12345z" })] });
    expect(m.text).not.toMatch(/[a-z]{5}[0-9]{4}[a-z]/i);
    expect(m.text).not.toMatch(/[a-z]{4}[0-9]{5}[a-z]/i);
    expect(m.text).toContain("Dear Arun Traders,");
  });

  it("HTML is the same content, escaped, as a simple list", () => {
    const m = buildReminderMessage({ ...base, clientName: "R&D <Labs>", items: [item()] });
    expect(m.html).toContain("Dear R&amp;D &lt;Labs&gt;,");
    expect(m.html).toContain("<li>GST · Sales invoices / sales register · August 2026 — overdue since 5 Sep</li>");
    expect(m.html).not.toMatch(/<a\b|<img\b|<script\b/i);
  });

  it("shows the year when the date is in another year", () => {
    const m = buildReminderMessage({ ...base, today: "2027-01-03", items: [item({ overdueFrom: "2026-12-20" })] });
    expect(m.text).toContain("overdue since 20 Dec 2026");
  });

  it("refuses an empty list", () => {
    expect(() => buildReminderMessage({ ...base, items: [] })).toThrow(/NO_ITEMS/);
  });
});

describe("whatsappUrl (AC-9)", () => {
  it("is wa.me/91<mobile> with the message URL-encoded", () => {
    expect(whatsappUrl("9876500001", "Dear A,\nGST · X — due today")).toBe(
      "https://wa.me/919876500001?text=" + encodeURIComponent("Dear A,\nGST · X — due today"),
    );
  });

  it("accepts only a 10-digit Indian mobile", () => {
    expect(() => whatsappUrl("12345", "x")).toThrow(/NO_MOBILE/);
  });
});
