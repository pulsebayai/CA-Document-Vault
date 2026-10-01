import { addDays, shortDate } from "@/lib/expected/schedule";
import { GST_STATES } from "@/lib/validation/gst-states";

// Feature 06 — AC-10: the reminder text (pure; unit-tested in tests/unit/reminder-message.test.ts).
// One text for email (plain + simple HTML) and WhatsApp. English only.
// Never: PAN, GSTIN/TAN numbers, links, attachments, DOC-IDs or internal remarks. Every value that comes from the
// database is scrubbed of those patterns, so a client or proposed-type name can't smuggle one in.

export type ReminderItem = {
  group: string;
  type: string;
  /** period.label: "Aug 2026" · "Q2 2026-27 (Jul–Sep)" · "FY 2025-26". */
  period: string;
  regKind: "gstin" | "tan" | null;
  /** GST state code (first two digits of the GSTIN) — the number itself never reaches the builder. */
  stateCode: string | null;
  /** expected_doc.overdue_from (YYYY-MM-DD); "due by" is the day before. */
  overdueFrom: string;
};

export type ReminderInput = {
  clientName: string;
  items: ReminderItem[];
  senderName: string;
  firmName: string;
  /** Office date (YYYY-MM-DD), for "overdue since" / "due by" wording. */
  today: string;
};

export type ReminderMessage = { subject: string; text: string; html: string };

const MONTHS: Record<string, string> = {
  Jan: "January", Feb: "February", Mar: "March", Apr: "April", May: "May", Jun: "June",
  Jul: "July", Aug: "August", Sep: "September", Oct: "October", Nov: "November", Dec: "December",
};

/** Removes links, GSTIN/PAN/TAN-shaped values and DOC-IDs, then tidies spaces. */
export function scrub(s: string): string {
  return s
    .replace(/\b(?:https?:\/\/|www\.)\S*/gi, " ")
    .replace(/DOC-FY\d{2}-\d{2}-\d+/gi, " ")
    .replace(/\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]{3}/g, " ")
    .replace(/[A-Z]{5}\d{4}[A-Z]/g, " ")
    .replace(/[A-Z]{4}\d{5}[A-Z]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function periodText(label: string): string {
  const m = /^([A-Z][a-z]{2}) (\d{4})$/.exec(label);
  return m && MONTHS[m[1]] ? `${MONTHS[m[1]]} ${m[2]}` : label;
}

function registrationText(item: ReminderItem): string {
  if (item.regKind === "gstin") {
    const state = item.stateCode ? GST_STATES[item.stateCode] : undefined;
    return state ? ` (${state} GSTIN)` : " (GSTIN)";
  }
  return item.regKind === "tan" ? " (TAN)" : "";
}

function stateText(overdueFrom: string, today: string): string {
  if (today >= overdueFrom) return `overdue since ${shortDate(overdueFrom, today)}`;
  const dueBy = addDays(overdueFrom, -1);
  return today === dueBy ? "due today" : `due by ${shortDate(dueBy, today)}`;
}

/** "GST · Sales invoices (Tamil Nadu GSTIN) · August 2026 — overdue since 5 Sep" */
export function itemLine(item: ReminderItem, today: string): string {
  return `${scrub(item.group)} · ${scrub(item.type)}${registrationText(item)} · ${scrub(periodText(item.period))} — ${stateText(item.overdueFrom, today)}`;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function buildReminderMessage(input: ReminderInput): ReminderMessage {
  if (input.items.length === 0) throw new Error("NO_ITEMS");
  const client = scrub(input.clientName);
  const sender = scrub(input.senderName);
  const firm = scrub(input.firmName);
  const lines = input.items.map((i) => itemLine(i, input.today));
  const intro = "The following documents are pending from you:";
  const ask = "Please send them at the earliest. If you have already sent them, please ignore this message.";

  const text = [`Dear ${client},`, "", intro, ...lines.map((l) => `- ${l}`), "", ask, "", "Regards,", sender, firm].join("\n");
  const html = [
    `<p>Dear ${escapeHtml(client)},</p>`,
    `<p>${escapeHtml(intro)}</p>`,
    `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`,
    `<p>${escapeHtml(ask)}</p>`,
    `<p>Regards,<br>${escapeHtml(sender)}<br>${escapeHtml(firm)}</p>`,
  ].join("\n");
  return { subject: `Documents pending — ${firm}`, text, html };
}

/** AC-9: click-to-chat link, built in the browser (the documented exception to "no PII in URLs"). */
export function whatsappUrl(mobile: string, text: string): string {
  if (!/^[6-9][0-9]{9}$/.test(mobile)) throw new Error("NO_MOBILE");
  return `https://wa.me/91${mobile}?text=${encodeURIComponent(text)}`;
}
