import { addDays, expectedState, shortDate } from "@/lib/expected/schedule";
import type { ReminderItem } from "./message";

// Feature 06 — pure shaping for the Remind / Log call dialogs, row history and the client's Reminders list
// (AC-7, AC-11, AC-12). No I/O; unit-tested.

export type Channel = "email" | "whatsapp" | "phone";
export type FollowUpStatus = "pending" | "sent" | "failed" | "suppressed" | "opened" | "logged";

/** Statuses that count as a reminder (row history, metric 2, the cap): never failed or pending. */
export const COUNTING: ReadonlySet<FollowUpStatus> = new Set(["sent", "suppressed", "opened", "logged"]);
/** A pending email older than this counts as failed (the DB closes it as TIMEOUT on the next send). */
export const STALE_PENDING_MS = 10 * 60_000;

export type HistoryEntry = { on: string; at: string; by: string; channel: Channel; status: FollowUpStatus };
export type History = { count: number; last: HistoryEntry | null };

/** Row history from an item's follow-ups (any order): counting ones only, latest by date then time. */
export function historyOf(entries: HistoryEntry[]): History {
  const counted = entries.filter((e) => COUNTING.has(e.status))
    .sort((a, b) => b.on.localeCompare(a.on) || b.at.localeCompare(a.at));
  return { count: counted.length, last: counted[0] ?? null };
}

const CHANNEL_LABEL: Record<Channel, string> = { email: "email", whatsapp: "WhatsApp", phone: "call" };
const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

/** AC-12: "reminded twice · last 3 Oct by Priya (email)" · "not reminded yet". */
export function historyText(h: History, today: string): string {
  if (h.count === 0 || !h.last) return "not reminded yet";
  return `reminded ${times(h.count)} · last ${shortDate(h.last.on, today)} by ${h.last.by} (${CHANNEL_LABEL[h.last.channel]})`;
}

/** Short form for Today rows (AC-5): "reminded twice". */
export function remindedShort(count: number): string | null {
  return count === 0 ? null : `reminded ${times(count)}`;
}

/** "a…@…" — the address is shown masked; the full one stays on the follow-up row (spec decision 2). */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? `${email[0]}…@…` : "…";
}

export type DialogItem = ReminderItem & {
  id: string;
  /** Overdue · Due today · Due 4 Oct (04's wording). */
  stateText: string;
  kind: "overdue" | "due_today" | "due";
  reminders: boolean;
  /** AC-7: ticked unless the plan row has reminders off. */
  ticked: boolean;
  history: string;
};

export type RawDialogItem = {
  id: string; group: string; groupSort: number; type: string; period: string; periodStart: string;
  regKind: "gstin" | "tan" | null; stateCode: string | null; overdueFrom: string; reminders: boolean;
  history: HistoryEntry[];
};

/** Open items for the dialog: most overdue first, then group, type, period. */
export function dialogItems(rows: RawDialogItem[], today: string): DialogItem[] {
  return [...rows]
    .sort((a, b) => a.overdueFrom.localeCompare(b.overdueFrom) || a.groupSort - b.groupSort
      || a.type.localeCompare(b.type) || a.periodStart.localeCompare(b.periodStart))
    .map((r) => {
      const st = expectedState({ status: "pending", overdueFrom: r.overdueFrom, onHold: false }, today);
      const kind = st.kind === "overdue" || st.kind === "due_today" ? st.kind : "due";
      return {
        id: r.id, group: r.group, type: r.type, period: r.period, regKind: r.regKind, stateCode: r.stateCode,
        overdueFrom: r.overdueFrom, stateText: st.text, kind, reminders: r.reminders, ticked: r.reminders,
        history: historyText(historyOf(r.history), today),
      };
    });
}

/** "Due by" date of an item (the day before it becomes overdue). */
export const dueBy = (overdueFrom: string) => addDays(overdueFrom, -1);

/** Plain messages for the SQL errors of 06's functions (codes from 20261001122813_follow_up.sql). */
export function reminderErrorMessage(message: string | undefined): string {
  const m = message ?? "";
  if (m.includes("ALREADY_EMAILED_TODAY")) return "This client was already emailed today. One email per client per day.";
  if (m.includes("DAILY_LIMIT")) return "Daily email limit reached — use WhatsApp or try tomorrow.";
  if (m.includes("NO_EMAIL")) return "No email on file — add one in Settings.";
  if (m.includes("NO_MOBILE")) return "No mobile number on file — add one in Settings.";
  if (m.includes("NO_ITEMS")) return "Choose at least one document.";
  if (m.includes("ITEMS_INVALID")) return "Some of these documents are no longer open. Close the dialog and try again.";
  if (m.includes("FUTURE_DATE")) return "A call can't be logged for a future date.";
  if (m.includes("NOTE_TOO_LONG")) return "Keep the note to 300 characters.";
  if (m.includes("NOT_FOUND")) return "This client is not available.";
  return "Something went wrong. Please try again.";
}
