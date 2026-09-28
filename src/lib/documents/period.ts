import type { Frequency, PeriodKind } from "@/lib/validation/catalogue";

// Spec 03 AC-3 and AC-6. India time; FY starts 1 April; Q1 = Apr–Jun. Codes match the period table
// (month "2026-08", quarter "2026-27-Q1", year "2026-27") and private.fy_code_of in the database.

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** India calendar date (YYYY-MM-DD) of an instant. */
export function istDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(at);
}

const parts = (date: string) => {
  const [y, m] = date.split("-").map(Number);
  return { y, m };
};
const fyStartYear = (y: number, m: number) => (m >= 4 ? y : y - 1);
const fyCode = (start: number) => `${start}-${pad((start + 1) % 100)}`;
/** 1–4, Q1 = Apr–Jun. */
const fyQuarter = (m: number) => Math.floor(((m + 8) % 12) / 3) + 1;

/** "2026-27" for any date from 1 Apr 2026 to 31 Mar 2027. */
export function fyCodeOf(date: string): string {
  const { y, m } = parts(date);
  return fyCode(fyStartYear(y, m));
}

/** "2026-27" → "26-27" (as written in a DOC-ID). */
export const docIdFy = (fy: string) => fy.slice(2);

/** DOC-FY26-27-00001 (D7). The database assigns DOC-IDs; this formats/predicts them for UI and tests. */
export function formatDocId(fy: string, n: number): string {
  return `DOC-FY${docIdFy(fy)}-${n > 99999 ? String(n) : pad(n, 5)}`;
}

export type PeriodDefault = { kind: Exclude<PeriodKind, "none">; code: string } | null;

/** AC-3: the period that just ended for the type's frequency; "as needed" → Not needed (null). */
export function defaultPeriod(frequency: Frequency, today: string): PeriodDefault {
  const { y, m } = parts(today);
  switch (frequency) {
    case "monthly": {
      const pm = m === 1 ? 12 : m - 1;
      return { kind: "month", code: `${m === 1 ? y - 1 : y}-${pad(pm)}` };
    }
    case "quarterly": {
      const start = fyStartYear(y, m);
      const q = fyQuarter(m);
      return q === 1 ? { kind: "quarter", code: `${fyCode(start - 1)}-Q4` } : { kind: "quarter", code: `${fyCode(start)}-Q${q - 1}` };
    }
    case "yearly":
      return { kind: "year", code: fyCode(fyStartYear(y, m) - 1) };
    default:
      return null;
  }
}

/** Period kinds a type may be filed under (same rule as the document trigger's PERIOD_KIND check). */
export function allowedPeriodKinds(typeKind: PeriodKind): Array<Exclude<PeriodKind, "none">> {
  if (typeKind === "quarter") return ["quarter", "year"];
  if (typeKind === "year") return ["year"];
  return ["month", "quarter", "year"];
}
