import { addDays, shortDate } from "@/lib/expected/schedule";
import { GST_STATES } from "@/lib/validation/gst-states";

// Feature 06 — AC-10: the reminder text (pure; unit-tested in tests/unit/reminder-message.test.ts).
// One text for email (plain + simple HTML) and WhatsApp. English only.
// Never: PAN, GSTIN/TAN numbers, links, attachments, DOC-IDs or internal remarks. Feature 10: the per-request upload
// link is the only link allowed; it is validated to be exactly <origin>/u#<token>, never taken from data. Every value that comes from the
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

/** Feature 10: a document asked for once ("as needed" or one-off), with an optional needed-by date and a note. */
export type AdHocItem = {
  group: string;
  type: string;
  /** period.label, or null for undated types. */
  period: string | null;
  /** YYYY-MM-DD or null. */
  neededBy: string | null;
  /** Shown publicly; already PII-checked on save, scrubbed again here. */
  note: string | null;
};

export type ReminderInput = {
  clientName: string;
  items: ReminderItem[];
  /** Feature 10: ad-hoc items on an upload request. */
  adHoc?: AdHocItem[];
  /** Feature 10: the per-request upload link (the only link a reminder may carry) and its last open day. */
  uploadLink?: { url: string; openUntil: string } | null;
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
    // Review N-5: case-insensitive, so a lower-case PAN/GSTIN/TAN typed into a name is caught too.
    .replace(/\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]{3}/gi, " ")
    .replace(/[A-Z]{5}\d{4}[A-Z]/gi, " ")
    .replace(/[A-Z]{4}\d{5}[A-Z]/gi, " ")
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

/** Feature 10: "Other · Rent agreement — for the new office lease — needed by 5 Nov" */
export function adHocLine(item: AdHocItem, today: string): string {
  const period = item.period ? ` · ${scrub(periodText(item.period))}` : "";
  const note = item.note ? ` — ${scrub(item.note)}` : "";
  const need = item.neededBy ? ` — needed by ${shortDate(item.neededBy, today)}` : "";
  return `${scrub(item.group)} · ${scrub(item.type)}${period}${note}${need}`;
}

/** The upload link is ours, never data: it must be exactly an https origin + /u#<43-char token>. */
const LINK = /^https:\/\/[a-z0-9.-]+(?::\d+)?\/u#[A-Za-z0-9_-]{43}$/i;
const LOCAL_LINK = /^http:\/\/localhost(?::\d+)?\/u#[A-Za-z0-9_-]{43}$/;

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function buildReminderMessage(input: ReminderInput): ReminderMessage {
  const adHoc = input.adHoc ?? [];
  if (input.items.length === 0 && adHoc.length === 0) throw new Error("NO_ITEMS");
  const link = input.uploadLink ?? null;
  if (link && !LINK.test(link.url) && !LOCAL_LINK.test(link.url)) throw new Error("BAD_LINK");
  const client = scrub(input.clientName);
  const sender = scrub(input.senderName);
  const firm = scrub(input.firmName);
  const lines = [...input.items.map((i) => itemLine(i, input.today)), ...adHoc.map((i) => adHocLine(i, input.today))];
  const intro = input.items.length > 0 ? "The following documents are pending from you:" : "Please send us the following documents:";
  const ask = link
    ? `You can upload them securely here (open until ${shortDate(link.openUntil, input.today)}):`
    : "Please send them at the earliest. If you have already sent them, please ignore this message.";

  const text = [`Dear ${client},`, "", intro, ...lines.map((l) => `- ${l}`), "", ask, ...(link ? [link.url] : []),
    "", "Regards,", sender, firm].join("\n");
  const html = [
    `<p>Dear ${escapeHtml(client)},</p>`,
    `<p>${escapeHtml(intro)}</p>`,
    `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`,
    `<p>${escapeHtml(ask)}${link ? `<br><a href="${escapeHtml(link.url)}">${escapeHtml(link.url)}</a>` : ""}</p>`,
    `<p>Regards,<br>${escapeHtml(sender)}<br>${escapeHtml(firm)}</p>`,
  ].join("\n");
  return { subject: `Documents pending — ${firm}`, text, html };
}

/** AC-9: click-to-chat link, built in the browser (the documented exception to "no PII in URLs"). */
export function whatsappUrl(mobile: string, text: string): string {
  if (!/^[6-9][0-9]{9}$/.test(mobile)) throw new Error("NO_MOBILE");
  return `https://wa.me/91${mobile}?text=${encodeURIComponent(text)}`;
}
