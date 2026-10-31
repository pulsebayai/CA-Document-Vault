// Feature 14 (spec AC-3, AC-8, AC-11) — expiry status and current holder, as shown on the DSC tab and Today.
// A DSC is valid through its expiry date; it is "due" when it expires within the client's remind days (default 30)
// or has expired. Mirrors public.dsc_due (tests/rls/dsc-due.test.ts checks the same boundaries).

export const DEFAULT_REMIND_DAYS = 30;

const DAY = 86_400_000;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const daysBetween = (from: string, to: string) => Math.round((utc(to) - utc(from)) / DAY);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "12 Mar 2027" (an office date, no time zone involved). */
export function shortDate(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  return `${day} ${MONTHS[m - 1]} ${y}`;
}

export type ExpiryTone = "ok" | "warn" | "bad";
export type ExpiryStatus = { tone: ExpiryTone; text: string; daysLeft: number };

export function expiryStatus(expiresOn: string, today: string, remindDays: number = DEFAULT_REMIND_DAYS): ExpiryStatus {
  const daysLeft = daysBetween(today, expiresOn);
  if (daysLeft < 0) {
    const ago = -daysLeft;
    return { tone: "bad", text: ago === 1 ? "Expired yesterday" : `Expired ${ago} days ago`, daysLeft };
  }
  if (daysLeft <= remindDays) {
    const text = daysLeft === 0 ? "Expires today" : daysLeft === 1 ? "Expires tomorrow" : `Expires in ${daysLeft} days`;
    return { tone: "warn", text, daysLeft };
  }
  return { tone: "ok", text: `Valid till ${shortDate(expiresOn)}`, daysLeft };
}

export const isDue = (expiresOn: string, today: string, remindDays: number = DEFAULT_REMIND_DAYS) =>
  expiryStatus(expiresOn, today, remindDays).tone !== "ok";

export type CustodyMove = { direction: "out" | "in"; person_name: string; on_date: string };

/** The current holder from the latest move (AC-8). */
export function custodyText(latest: CustodyMove | null): string {
  if (!latest || latest.direction === "in") return "In office";
  return `With ${latest.person_name} since ${shortDate(latest.on_date)}`;
}
