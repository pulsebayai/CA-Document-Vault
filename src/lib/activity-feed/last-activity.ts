import { ACTIVITY_CATALOGUE, actorLabel } from "./catalogue";

// Feature 15 (spec AC-5) — the All documents tab's Last activity column: "<who> · <sentence> · <when>", with 08's
// catalogue sentence; "Vault" for rows the system wrote; "—" when the viewer can see no event for the document.

/** Events shown in an expanded row (AC-7); "See all" opens /activity?document=<id>. */
export const EXPANDED_EVENTS = 5;

export type LastActivityRow = {
  id: number;
  at: string;
  action: string;
  entity_type: string;
  data: Record<string, unknown>;
  actor_id: string | null;
  actor_name: string | null;
  doc_type_name: string | null;
  doc_group_name: string | null;
};

export function lastActivityLine(r: LastActivityRow | null, now: Date = new Date()): string {
  if (!r) return "—";
  const entry = ACTIVITY_CATALOGUE[r.action];
  const view = { action: r.action, actor_name: r.actor_name, client_name: null, doc_code: null, doc_type_name: r.doc_type_name, doc_group_name: r.doc_group_name, data: r.data ?? {} };
  const sentence = entry ? entry.text(view) : r.action;
  return `${actorLabel(r.actor_name)} · ${sentence} · ${whenText(r.at, now)}`;
}

const IST = "Asia/Kolkata";
const dayKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const dayNumber = (d: Date) => Math.round(Date.parse(`${dayKey(d)}T00:00:00Z`) / 86_400_000);

/** "just now" · "N min ago" · "N h ago" (same IST day) · "yesterday" · "N days ago" (≤ 7) · "12 Oct" · "12 Oct 2025". */
export function whenText(at: string, now: Date = new Date()): string {
  const d = new Date(at);
  const secs = (now.getTime() - d.getTime()) / 1000;
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  const days = dayNumber(now) - dayNumber(d);
  if (days <= 0) return `${Math.floor(secs / 3600)} h ago`;
  if (days === 1) return "yesterday";
  if (days <= 7) return `${days} days ago`;
  const sameYear = dayKey(d).slice(0, 4) === dayKey(now).slice(0, 4);
  return new Intl.DateTimeFormat("en-GB", { timeZone: IST, day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }).format(d);
}
