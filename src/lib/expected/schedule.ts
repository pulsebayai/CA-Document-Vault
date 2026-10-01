// Feature 04 — schedule date maths and the shown state of an expected document (spec "Key definitions").
// The database stores ask / overdue-from dates (private.offset_date, private.schedule_dates); this is their mirror for
// screens and server code, checked against every generated item in tests/rls/expected-docs.test.ts.
// All dates are IST calendar dates written YYYY-MM-DD; no time zones or clock times are involved.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const IST_OFFSET_MS = 330 * 60_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parse(date: string): { y: number; m: number; d: number } {
  const match = ISO_DATE.exec(date);
  if (!match) throw new Error(`not a date: ${date}`);
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) throw new Error(`not a date: ${date}`);
  return { y, m, d };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const format = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
/** Days in month m (1–12) of year y. */
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const toUtcMs = (date: string) => { const { y, m, d } = parse(date); return Date.UTC(y, m - 1, d); };

/** Period end + `months` months, on `day` clamped to that month's last day (private.offset_date). */
export function offsetDate(periodEnd: string, months: number, day: number): string {
  if (!Number.isInteger(months) || months < 0) throw new Error(`months must be a whole number ≥ 0: ${months}`);
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error(`day must be 1–31: ${day}`);
  const { y, m } = parse(periodEnd);
  const index = y * 12 + (m - 1) + months; // months since year 0, zero-based
  const ty = Math.floor(index / 12);
  const tm = (index % 12) + 1;
  return format(ty, tm, Math.min(day, daysInMonth(ty, tm)));
}

export type ScheduleOffsets = { askAfterMonths: number; askDay: number; overdueAfterMonths: number; overdueDay: number };

/** Ask date, overdue-from date, and due-by (= the day before overdue from) for a period ending on `periodEnd`. */
export function scheduleDates(periodEnd: string, o: ScheduleOffsets) {
  const askOn = offsetDate(periodEnd, o.askAfterMonths, o.askDay);
  const overdueFrom = offsetDate(periodEnd, o.overdueAfterMonths, o.overdueDay);
  return { askOn, overdueFrom, dueBy: addDays(overdueFrom, -1) };
}

export function addDays(date: string, days: number): string {
  return new Date(toUtcMs(date) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / 86_400_000);
}

/** Today's calendar date in India (the rule's "today" outside test offices). */
export function todayInIndia(now: Date = new Date()): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** "4 Oct", or "4 Jan 2027" when the year differs from `today`'s. */
export function shortDate(date: string, today: string): string {
  const { y, m, d } = parse(date);
  return `${d} ${MONTHS[m - 1]}${y === parse(today).y ? "" : ` ${y}`}`;
}

export type StateKind = "due" | "due_today" | "overdue" | "on_hold" | "received" | "not_needed";
export type ExpectedState =
  | { kind: "due"; text: string; dueBy: string }
  | { kind: "due_today"; text: string; dueBy: string }
  | { kind: "overdue"; text: string; daysLate: number }
  | { kind: "on_hold" | "received" | "not_needed"; text: string };

export type StateInput = {
  status: "pending" | "received" | "waived";
  overdueFrom: string;
  /** The plan row or its group is paused (spec: pending items of paused rows show On hold). */
  onHold: boolean;
  receivedOn?: string | null;
  docCode?: string | null;
  waivedReason?: string | null;
};

/**
 * The shown state (never stored): Due <date> · Due today · Overdue · N days late · On hold · Received <date> · DOC-ID ·
 * Not needed · reason. Overdue counts the overdue-from date itself as 1 day late.
 */
export function expectedState(item: StateInput, today: string): ExpectedState {
  if (item.status === "waived") {
    return { kind: "not_needed", text: item.waivedReason ? `Not needed · ${item.waivedReason}` : "Not needed" };
  }
  if (item.status === "received") {
    const parts = ["Received" + (item.receivedOn ? ` ${shortDate(item.receivedOn, today)}` : ""), item.docCode].filter(Boolean);
    return { kind: "received", text: parts.join(" · ") };
  }
  if (item.onHold) return { kind: "on_hold", text: "On hold" };
  const dueBy = addDays(item.overdueFrom, -1);
  if (today >= item.overdueFrom) {
    const daysLate = daysBetween(item.overdueFrom, today) + 1;
    return { kind: "overdue", text: `Overdue · ${daysLate} ${daysLate === 1 ? "day" : "days"} late`, daysLate };
  }
  if (today === dueBy) return { kind: "due_today", text: "Due today", dueBy };
  return { kind: "due", text: `Due ${shortDate(dueBy, today)}`, dueBy };
}

/** Items that count as open (Expected tab count, Documents cards): Due, Due today and Overdue. */
export const isOpen = (kind: StateKind) => kind === "due" || kind === "due_today" || kind === "overdue";
