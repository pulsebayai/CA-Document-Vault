import { addDays, shortDate } from "@/lib/expected/schedule";
import { GST_STATES } from "@/lib/validation/gst-states";
import { remindedShort } from "@/lib/reminders/shape";

// Feature 06 — Today (spec AC-2…AC-5): URL enums and the view model from today_items(). Pure; unit-tested.

export const SCOPES = ["mine", "everyone"] as const;
export const SHOWS = ["overdue", "due_week", "to_review", "ready", "requested", "to_place", "held"] as const; // 13: to_place, held
export type Scope = (typeof SCOPES)[number];
export type Show = (typeof SHOWS)[number];

/** Last "Show more" page (pages 0…33, 30 cards each). */
export const MAX_PAGE = 33;

/** AC-2 / AC-3: scope and filter come from the URL as enums only; anything else falls back to the default. */
export function parseTodayParams(sp: Record<string, string | string[] | undefined>): { scope: Scope; show: Show | null; page: number } {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const scope = SCOPES.find((s) => s === one(sp.scope)) ?? "mine";
  const show = SHOWS.find((s) => s === one(sp.show)) ?? null;
  const n = Number.parseInt(one(sp.page) ?? "", 10);
  return { scope, show, page: Number.isFinite(n) && n > 0 && n <= MAX_PAGE ? n : 0 };
}

/** The URL for a scope / filter (clicking an active count clears it). */
export function todayHref(scope: Scope, show: Show | null, page = 0): string {
  const q = new URLSearchParams();
  if (scope !== "mine") q.set("scope", scope);
  if (show) q.set("show", show);
  if (page > 0) q.set("page", String(page));
  const s = q.toString();
  return s ? `/today?${s}` : "/today";
}

export type TodayRowRaw = {
  expected_doc_id: string; kind: "overdue" | "due_today" | "due_week"; group: string; type: string; period: string;
  reg_kind: "gstin" | "tan" | null; state_code: string | null; overdue_from: string; days_late: number | null;
  reminders: boolean; reminded: number; last_reminded_on: string | null; last_reminded_by: string | null;
  last_channel: string | null;
};
/** Step 9 (07's states): a filed document To review, or an original Ready to dispatch (migration 2). */
export type TodayDocRowRaw = {
  /** 13: "to_place" and "held" rows come only when that count is chosen (show=to_place | held). */
  document_id: string; kind: "to_review" | "ready" | "to_place" | "held"; doc_code: string; group: string; type: string; period: string | null;
  received_as: string; received_on: string; reviewed_on: string | null; reviewed_by: string | null; needs_correction: boolean;
  /** 12: returnable hard copy (absent on rows written before 12; legacy received_as "original" counts too). */
  returnable?: boolean;
  /** 13: India date it was marked in office (null when not placed). */
  in_office_on?: string | null;
};
/** 10 (AC-17): an open ad-hoc requested item with a needed-by date that has passed or falls within 7 days. */
export type TodayAskRowRaw = {
  item_id: string; kind: "requested"; due: "overdue" | "due_week"; group: string; type: string; period: string | null;
  needed_by: string; note: string | null;
};
export type TodayCardRaw = {
  client_id: string; name: string; incharge: string | null; assignees: Array<{ group: string; name: string }>;
  overdue: number; due_week: number; to_review?: number; ready?: number; requested?: number; requested_overdue?: number;
  to_place?: number; held?: number; // 13
  rows: Array<TodayRowRaw | TodayDocRowRaw | TodayAskRowRaw>;
};
export type TodayRaw = {
  today: string; counts: { overdue: number; due_week: number; to_review?: number; ready?: number; requested?: number; requested_later?: number;
    to_place?: number; held?: number }; // 13
  clients?: number; cards: TodayCardRaw[]; has_more: boolean;
};

export type TodayRow = {
  id: string; kind: TodayRowRaw["kind"];
  /** "GST · Sales invoices / sales register · Tamil Nadu · Aug 2026" */
  title: string;
  /** Right-hand state (mockup 01): "Overdue" · "Due today" · "Due Fri 18 Sep". Text, not colour alone. */
  label: string;
  labelTone: "late" | "due" | "muted";
  /** "Not received · 13 days late · reminded twice" (+ "reminders off"). */
  detail: string;
  reminders: boolean;
  overdueFrom: string;
  /** Add document pre-filled (04's link: UUIDs only), set by the query; null if the IDs couldn't be read. */
  uploadHref: string | null;
};
/** Mockup 01 document rows: "GST · Invoices · July 2026 [DOC-ID] [Original]", "Received 2 Aug · waiting for review". */
export type TodayDocRow = {
  id: string; kind: TodayDocRowRaw["kind"]; title: string; docCode: string; original: boolean;
  /** "To review" · "Ready to dispatch" */
  label: string;
  /** "Received 2 Aug · waiting for review" · "Reviewed 12 Sep by Ravi" · "Needs correction · still to go back" */
  detail: string;
  /** 12 (AC-18): To review rows — the current file (null = no file yet; absent = not loaded). Set by the query. */
  file?: { versionId: string; mimeType: string; viewBlocked: boolean } | null;
};
/** 10: "Requested · Other · GST notice / order received" · "Needed by 30 May · for the new office lease". */
export type TodayAskRow = {
  id: string; title: string; label: string; labelTone: "late" | "due"; detail: string;
  /** Add document pre-filled and linked to the item, set by the query; null if the IDs couldn't be read. */
  uploadHref: string | null;
};
export type TodayCard = {
  clientId: string; name: string; initials: string; people: string; badge: string; badgeTone: "late" | "due" | "muted";
  /** Expected rows (Overdue → Due), then document rows (To review → Ready). */
  rows: TodayRow[];
  docs: TodayDocRow[];
  /** 10: requested (ad-hoc) rows, after the expected rows (optional: 06's view tests build cards without it). */
  asks?: TodayAskRow[];
};

type AnyRowRaw = TodayRowRaw | TodayDocRowRaw | TodayAskRowRaw;
const isDocRow = (r: AnyRowRaw): r is TodayDocRowRaw => "document_id" in r;
const isAskRow = (r: AnyRowRaw): r is TodayAskRowRaw => "item_id" in r;

export function toAskRow(r: TodayAskRowRaw, today: string): TodayAskRow {
  return {
    id: r.item_id, title: ["Requested", r.group, r.type, r.period].filter(Boolean).join(" · "),
    label: r.due === "overdue" ? "Overdue" : `Needed by ${shortDate(r.needed_by, today)}`, labelTone: r.due === "overdue" ? "late" : "due",
    detail: [r.due === "overdue" ? `Needed by ${shortDate(r.needed_by, today)}` : "Not received", r.note].filter(Boolean).join(" · "),
    uploadHref: null,
  };
}

const DOC_LABEL: Record<TodayDocRowRaw["kind"], string> = {
  to_review: "To review", ready: "Ready to dispatch", to_place: "To place in office", held: "In office > 30 days", // 13
};

export function toDocRow(r: TodayDocRowRaw, today: string): TodayDocRow {
  const reviewed = ["Reviewed", r.reviewed_on ? shortDate(r.reviewed_on, today) : null, r.reviewed_by ? `by ${r.reviewed_by}` : null].filter(Boolean).join(" ");
  const detail = r.kind === "to_review"
    ? `Received ${shortDate(r.received_on, today)} · waiting for review`
    : r.kind === "held" && r.in_office_on ? `In office since ${shortDate(r.in_office_on, today)} · still to go back` // 13
    : r.needs_correction ? (r.kind === "to_place" ? "Needs correction · not in office yet" : "Needs correction · original still to go back")
    : r.kind === "to_place" ? `${reviewed} · not in office yet` // 13
    : reviewed;
  return {
    id: r.document_id, kind: r.kind, title: [r.group, r.type, r.period].filter(Boolean).join(" · "), docCode: r.doc_code,
    original: r.returnable === true || r.received_as === "original", label: DOC_LABEL[r.kind], detail,
  };
}

/** Card badge (mockup 01): "N overdue" · "Due this week" · "N to review" · "N to dispatch". */
function badgeOf(c: TodayCardRaw): Pick<TodayCard, "badge" | "badgeTone"> {
  if (c.overdue > 0) return { badge: `${c.overdue} overdue`, badgeTone: "late" };
  if (c.due_week > 0) return { badge: "Due this week", badgeTone: "due" };
  if (c.requested) return { badge: `${c.requested} requested`, badgeTone: c.requested_overdue ? "late" : "due" };
  if (c.to_review) return { badge: `${c.to_review} to review`, badgeTone: "muted" };
  return { badge: `${c.ready ?? 0} to dispatch`, badgeTone: "due" };
}

export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "?";
}

function registration(r: TodayRowRaw): string {
  if (r.reg_kind === "gstin") return ` · ${(r.state_code && GST_STATES[r.state_code]) ?? "GSTIN"}`;
  return r.reg_kind === "tan" ? " · TAN" : "";
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekday = (date: string) => WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()];

/** Mockup 01's right-hand state: Overdue · Due today · "Due Fri 18 Sep" (the due-by date). */
export function rowLabel(r: TodayRowRaw, today: string): { label: string; tone: TodayRow["labelTone"] } {
  if (r.kind === "overdue") return { label: "Overdue", tone: "late" };
  if (r.kind === "due_today") return { label: "Due today", tone: "due" };
  const dueBy = addDays(r.overdue_from, -1);
  return { label: `Due ${weekday(dueBy)} ${shortDate(dueBy, today)}`, tone: "muted" };
}

/** AC-5 detail line: "Not received · 13 days late · reminded twice" (+ "reminders off"). */
export function rowDetail(r: TodayRowRaw): string {
  const parts = ["Not received"];
  if (r.kind === "overdue" && r.days_late) parts.push(`${r.days_late} ${r.days_late === 1 ? "day" : "days"} late`);
  const reminded = remindedShort(r.reminded);
  if (reminded) parts.push(reminded);
  if (!r.reminders) parts.push("reminders off");
  return parts.join(" · ");
}

export function toTodayCard(c: TodayCardRaw, today: string): TodayCard {
  const people = [c.incharge ? `Incharge ${c.incharge}` : null, ...c.assignees.map((a) => `${a.group} ${a.name}`)]
    .filter(Boolean).join(" · ");
  return {
    clientId: c.client_id, name: c.name, initials: initials(c.name), people, ...badgeOf(c),
    docs: c.rows.filter(isDocRow).map((r) => toDocRow(r, today)),
    asks: c.rows.filter(isAskRow).map((r) => toAskRow(r, today)),
    rows: c.rows.filter((r): r is TodayRowRaw => !isDocRow(r) && !isAskRow(r)).map((r) => ({
      id: r.expected_doc_id, kind: r.kind, title: `${r.group} · ${r.type}${registration(r)} · ${r.period}`,
      ...(({ label, tone }) => ({ label, labelTone: tone }))(rowLabel(r, today)),
      detail: rowDetail(r), reminders: r.reminders, overdueFrom: r.overdue_from, uploadHref: null,
    })),
  };
}

/** 04's Add document link from an expected row. Returns to the client's Expected tab (Add document's return
 *  allow-list; the saved item is visible there as Received). */
export function uploadHref(clientId: string, ids: { typeId: string; periodId: string; registrationId: string | null }): string {
  const q = new URLSearchParams({ client: clientId, type: ids.typeId, period: ids.periodId });
  if (ids.registrationId) q.set("registration", ids.registrationId);
  q.set("from", `/clients/${clientId}?tab=expected`);
  return `/documents/new?${q.toString()}`;
}
