import type { FieldIssue } from "./client";
import { validateSchedule, type Frequency, type PeriodKind, type ScheduleInput } from "./catalogue";

// Spec 02 AC-20: a client's own copy of a type — frequency, schedule, reminders, start period.
// Same rules as the catalogue (validateSchedule) and the client_doc_type DB checks.

export type PlanTypeInput = ScheduleInput & { startPeriodId?: unknown };
export type ValidPlanType = {
  frequency: Frequency; askAfterMonths: number | null; askDay: number | null; overdueAfterMonths: number | null;
  overdueDay: number | null; reminders: boolean; startPeriodId: string | null;
};
export type PeriodRef = { id: string; kind: Exclude<PeriodKind, "none"> };

/** Which periods a frequency is counted in; "as needed" has no start period. */
export function periodKindFor(f: Frequency): PeriodRef["kind"] | null {
  return f === "monthly" ? "month" : f === "quarterly" ? "quarter" : f === "yearly" ? "year" : null;
}

export function validatePlanType(input: PlanTypeInput, ctx: { periodKind: PeriodKind; periods: PeriodRef[] }) {
  const s = validateSchedule(input, ctx.periodKind);
  const errors: FieldIssue[] = [...s.errors];
  let startPeriodId: string | null = null;
  const kind = periodKindFor(s.frequency);
  if (kind && !errors.some((e) => e.field === "frequency")) {
    const id = typeof input.startPeriodId === "string" ? input.startPeriodId : "";
    if (ctx.periods.some((p) => p.id === id && p.kind === kind)) startPeriodId = id;
    else errors.push({ field: "startPeriodId", message: "Choose the first period to collect." });
  }
  if (errors.length) return { data: null, errors };
  const [askAfterMonths, askDay, overdueAfterMonths, overdueDay] = s.offsets;
  const data: ValidPlanType = {
    frequency: s.frequency, askAfterMonths, askDay, overdueAfterMonths, overdueDay, reminders: s.reminders, startPeriodId,
  };
  return { data, errors };
}

/** Pause remark (group or type): optional, ≤ 500 characters (DB check). Stored on the row, never in activity. */
export function validateRemark(v: unknown): { remark: string | null; error: string | null } {
  const remark = typeof v === "string" ? v.trim() : "";
  if (remark.length > 500) return { remark: null, error: "Remark is too long (500 characters max)." };
  return { remark: remark || null, error: null };
}
