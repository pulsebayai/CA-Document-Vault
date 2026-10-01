import { addDays, shortDate } from "@/lib/expected/schedule";
import { GST_STATES } from "@/lib/validation/gst-states";
import { remindedShort } from "@/lib/reminders/shape";

// Feature 06 — Today (spec AC-2…AC-5): URL enums and the view model from today_items(). Pure; unit-tested.

export const SCOPES = ["mine", "everyone"] as const;
export const SHOWS = ["overdue", "due_week"] as const;
export type Scope = (typeof SCOPES)[number];
export type Show = (typeof SHOWS)[number];

/** AC-2 / AC-3: scope and filter come from the URL as enums only; anything else falls back to the default. */
export function parseTodayParams(sp: Record<string, string | string[] | undefined>): { scope: Scope; show: Show | null; page: number } {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const scope = SCOPES.find((s) => s === one(sp.scope)) ?? "mine";
  const show = SHOWS.find((s) => s === one(sp.show)) ?? null;
  const n = Number.parseInt(one(sp.page) ?? "", 10);
  return { scope, show, page: Number.isFinite(n) && n > 0 && n < 34 ? n : 0 };
}

/** The URL for a scope / filter (clicking an active count clears it). */
export function todayHref(scope: Scope, show: Show | null): string {
  const q = new URLSearchParams();
  if (scope !== "mine") q.set("scope", scope);
  if (show) q.set("show", show);
  const s = q.toString();
  return s ? `/today?${s}` : "/today";
}

export type TodayRowRaw = {
  expected_doc_id: string; kind: "overdue" | "due_today" | "due_week"; group: string; type: string; period: string;
  reg_kind: "gstin" | "tan" | null; state_code: string | null; overdue_from: string; days_late: number | null;
  reminders: boolean; reminded: number; last_reminded_on: string | null; last_reminded_by: string | null;
  last_channel: string | null;
};
export type TodayCardRaw = {
  client_id: string; name: string; incharge: string | null; assignees: Array<{ group: string; name: string }>;
  overdue: number; due_week: number; rows: TodayRowRaw[];
};
export type TodayRaw = { today: string; counts: { overdue: number; due_week: number }; cards: TodayCardRaw[]; has_more: boolean };

export type TodayRow = {
  id: string; kind: TodayRowRaw["kind"]; title: string; status: string; reminders: boolean;
  /** Client page link for Upload (Add document pre-filled is opened from the client's Expected tab, 04). */
  overdueFrom: string;
};
export type TodayCard = {
  clientId: string; name: string; initials: string; people: string; badge: string; badgeTone: "late" | "due";
  rows: TodayRow[];
};

export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "?";
}

function registration(r: TodayRowRaw): string {
  if (r.reg_kind === "gstin") return ` · ${(r.state_code && GST_STATES[r.state_code]) ?? "GSTIN"}`;
  return r.reg_kind === "tan" ? " · TAN" : "";
}

/** AC-5: "Not received · 12 days late · reminded twice" / "Due today" / "Due 4 Oct" (+ "reminders off"). */
export function rowStatus(r: TodayRowRaw, today: string): string {
  const parts: string[] = [];
  if (r.kind === "overdue") parts.push("Not received", `${r.days_late} ${r.days_late === 1 ? "day" : "days"} late`);
  else if (r.kind === "due_today") parts.push("Due today");
  else parts.push(`Due ${shortDate(addDays(r.overdue_from, -1), today)}`);
  const reminded = remindedShort(r.reminded);
  if (reminded) parts.push(reminded);
  if (!r.reminders) parts.push("reminders off");
  return parts.join(" · ");
}

export function toTodayCard(c: TodayCardRaw, today: string): TodayCard {
  const people = [c.incharge ? `Incharge ${c.incharge}` : null, ...c.assignees.map((a) => `${a.group} ${a.name}`)]
    .filter(Boolean).join(" · ");
  return {
    clientId: c.client_id, name: c.name, initials: initials(c.name), people,
    badge: c.overdue > 0 ? `${c.overdue} overdue` : "Due this week", badgeTone: c.overdue > 0 ? "late" : "due",
    rows: c.rows.map((r) => ({
      id: r.expected_doc_id, kind: r.kind, title: `${r.group} · ${r.type}${registration(r)} · ${r.period}`,
      status: rowStatus(r, today), reminders: r.reminders, overdueFrom: r.overdue_from,
    })),
  };
}
