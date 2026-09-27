import type { FieldIssue } from "./client";

// Spec 02 AC-2/AC-3: one validator for the catalogue dialogs and the server actions.
// The database enforces the same rules (doc_type checks); this gives plain-word errors first.

export const FREQUENCIES = ["monthly", "quarterly", "yearly", "as_needed"] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export const FREQUENCY_LABEL: Record<Frequency, string> = {
  monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly", as_needed: "As needed",
};

export const PERIOD_KINDS = ["month", "quarter", "year", "none"] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];
export const PERIOD_LABEL: Record<PeriodKind, string> = {
  month: "Month", quarter: "Quarter (FY)", year: "Financial year", none: "No period (e.g. certificates, notices)",
};

export type DocSource = "client" | "firm";

/** A document can be collected per its own period or less often, never more often. */
export function allowedFrequencies(kind: PeriodKind): Frequency[] {
  const order: Record<PeriodKind, number> = { month: 0, quarter: 1, year: 2, none: 3 };
  const byFreq: Record<Exclude<Frequency, "as_needed">, number> = { monthly: 0, quarterly: 1, yearly: 2 };
  return [...(Object.keys(byFreq) as (keyof typeof byFreq)[]).filter((f) => byFreq[f] >= order[kind]), "as_needed"];
}

export type DocTypeInput = {
  name?: unknown; aliases?: unknown; frequency?: unknown; askAfterMonths?: unknown; askDay?: unknown;
  overdueAfterMonths?: unknown; overdueDay?: unknown; reminders?: unknown; usedFor?: unknown; active?: unknown;
};
export type ValidDocType = {
  name: string; aliases: string[]; defaultFrequency: Frequency;
  askAfterMonths: number | null; askDay: number | null; overdueAfterMonths: number | null; overdueDay: number | null;
  reminders: boolean; usedFor: string | null; active: boolean;
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const checked = (v: unknown) => v === true || v === "on" || v === "true";

function intIn(v: unknown, min: number, max: number): number | null {
  const s = typeof v === "number" ? String(v) : str(v);
  if (!/^\d{1,2}$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

export function parseAliases(v: unknown): { aliases: string[]; error: string | null } {
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const a of str(v).split(/[,\n]/).map((x) => x.trim()).filter(Boolean)) {
    if (a.length > 80) return { aliases: [], error: "Each alias can be 80 characters at most." };
    if (!seen.has(a.toLowerCase())) { seen.add(a.toLowerCase()); aliases.push(a); }
  }
  if (aliases.length > 20) return { aliases: [], error: "Up to 20 aliases." };
  return { aliases, error: null };
}

type Offsets4 = [number | null, number | null, number | null, number | null];
export type ScheduleInput = {
  frequency?: unknown; askAfterMonths?: unknown; askDay?: unknown; overdueAfterMonths?: unknown; overdueDay?: unknown; reminders?: unknown;
};

/**
 * How often + when to ask (catalogue master types and client plan types share this rule, spec AC-2 / AC-20):
 * frequency no more often than the period; offsets complete and in range exactly when scheduled; overdue on or
 * after ask; "as needed" clears offsets and reminders. Same rules as the DB checks.
 */
export function validateSchedule(input: ScheduleInput, periodKind: PeriodKind) {
  const errors: FieldIssue[] = [];
  let frequency: Frequency = "as_needed";
  let reminders = false;
  let offsets: Offsets4 = [null, null, null, null];
  const f = str(input.frequency) as Frequency;
  if (!allowedFrequencies(periodKind).includes(f)) {
    errors.push({ field: "frequency", message: "Choose how often this is collected (it can't be more often than its period)." });
  } else frequency = f;

  if (frequency !== "as_needed") {
    reminders = checked(input.reminders);
    const askAfterMonths = intIn(input.askAfterMonths, 0, 12);
    const askDay = intIn(input.askDay, 1, 31);
    const overdueAfterMonths = intIn(input.overdueAfterMonths, 0, 12);
    const overdueDay = intIn(input.overdueDay, 1, 31);
    if (askAfterMonths === null) errors.push({ field: "askAfterMonths", message: "Months after period end: 0 to 12." });
    if (askDay === null) errors.push({ field: "askDay", message: "Day: 1 to 31." });
    if (overdueAfterMonths === null) errors.push({ field: "overdueAfterMonths", message: "Months after period end: 0 to 12." });
    if (overdueDay === null) errors.push({ field: "overdueDay", message: "Day: 1 to 31." });
    if (askAfterMonths !== null && askDay !== null && overdueAfterMonths !== null && overdueDay !== null
      && (overdueAfterMonths < askAfterMonths || (overdueAfterMonths === askAfterMonths && overdueDay < askDay))) {
      errors.push({ field: "overdueDay", message: "Overdue must be on or after the ask date." });
    }
    offsets = [askAfterMonths, askDay, overdueAfterMonths, overdueDay];
  }
  return { frequency, reminders, offsets, errors };
}

export function validateDocType(input: DocTypeInput, ctx: { source: DocSource; periodKind: PeriodKind }) {
  const errors: FieldIssue[] = [];
  const name = str(input.name);
  if (!name) errors.push({ field: "name", message: "Enter a name." });
  else if (name.length > 120) errors.push({ field: "name", message: "Name is too long (120 characters max)." });

  const { aliases, error: aliasError } = parseAliases(input.aliases);
  if (aliasError) errors.push({ field: "aliases", message: aliasError });

  const usedFor = str(input.usedFor) || null;
  if (usedFor && usedFor.length > 200) errors.push({ field: "usedFor", message: "“Used for” is too long (200 characters max)." });

  const active = checked(input.active);
  let frequency: Frequency = "as_needed";
  let reminders = false;
  let offsets: Offsets4 = [null, null, null, null];
  if (ctx.source === "client") {
    const s = validateSchedule(input, ctx.periodKind);
    errors.push(...s.errors);
    ({ frequency, reminders, offsets } = s);
  }

  if (errors.length) return { data: null, errors };
  const [askAfterMonths, askDay, overdueAfterMonths, overdueDay] = offsets;
  const data: ValidDocType = {
    name, aliases, defaultFrequency: frequency, askAfterMonths, askDay, overdueAfterMonths, overdueDay, reminders, usedFor, active,
  };
  return { data, errors };
}

export function validateDocGroup(input: { name?: unknown }): { data: { name: string } | null; errors: FieldIssue[] } {
  const name = str(input.name);
  if (!name) return { data: null, errors: [{ field: "name", message: "Enter a group name." }] };
  if (name.length > 80) return { data: null, errors: [{ field: "name", message: "Name is too long (80 characters max)." }] };
  return { data: { name }, errors: [] };
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
}

/** Offsets are counted from the end of the period (spec "Key definitions"). */
export function formatOffset(months: number, day: number): string {
  if (months === 0) return `${ordinal(day)} of the period's last month`;
  if (months === 1) return `${ordinal(day)} of the next month`;
  return `${ordinal(day)}, ${months} months after`;
}

type Offsets = { ask_after_months: number | null; ask_day: number | null; overdue_after_months: number | null; overdue_day: number | null };
export function scheduleSummary(t: Offsets): string {
  if (t.ask_after_months === null || t.ask_day === null || t.overdue_after_months === null || t.overdue_day === null) return "";
  return `Ask ${formatOffset(t.ask_after_months, t.ask_day)} · overdue from ${formatOffset(t.overdue_after_months, t.overdue_day)}`;
}

/** Internal code (never shown): slug of the name + a random suffix so it is unique without a lookup. */
export function codeFromName(name: string, suffix: string): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 34) || "item";
  return `${slug}_${suffix}`.replace(/_+/g, "_");
}
