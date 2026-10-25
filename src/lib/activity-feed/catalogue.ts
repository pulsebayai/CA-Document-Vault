import type { ActivityCategory } from "./categories";

// Feature 08 AC-5/AC-6 — one sentence per action. Rows hold IDs and field names only; the names shown here
// (actor, client, type, group, DOC-ID) come from activity_feed, resolved under the viewer's RLS. A name the viewer
// can't see is never blank: the sentence falls back to "a document" and the detail line drops it.
// tests/unit/activity-catalogue.test.ts fails when an action written in src/ or supabase/migrations/ is missing.

export type ActivityRowView = {
  action: string;
  actor_name: string | null; // null = written by the vault itself (system jobs)
  client_name: string | null;
  doc_code: string | null;
  doc_type_name: string | null;
  doc_group_name: string | null;
  data: Record<string, unknown>;
};

type Entry = { category: ActivityCategory; text: (r: ActivityRowView) => string };

const doc = (r: ActivityRowView) => r.doc_type_name ?? "a document";
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fixed = (category: ActivityCategory, s: string): Entry => ({ category, text: () => s });

export const ACTIVITY_CATALOGUE: Record<string, Entry> = {
  // Documents (03)
  "document.added": { category: "documents", text: (r) => (r.doc_type_name ? `added ${r.doc_type_name}` : "added a document to the Inbox") },
  "document.classified": { category: "documents", text: (r) => `filed ${doc(r)}` },
  "document.updated": { category: "documents", text: (r) => `edited ${doc(r)}` },
  "document.version_added": { category: "documents", text: (r) => `added a new file to ${doc(r)}` },
  "document.archived": { category: "documents", text: (r) => `archived ${doc(r)}` },
  "document.unarchived": { category: "documents", text: (r) => `unarchived ${doc(r)}` },
  "document.type_merged": { category: "documents", text: (r) => `re-filed ${r.doc_type_name ? `a document under ${r.doc_type_name}` : "a document"} (type merged)` }, // 05
  // Review & dispatch (07)
  "document.reviewed": { category: "review_dispatch", text: (r) => `reviewed ${doc(r)}` },
  "document.needs_correction": { category: "review_dispatch", text: (r) => `marked ${doc(r)} as needs correction` },
  "document.review_undone": { category: "review_dispatch", text: (r) => `undid the review of ${doc(r)}` },
  "dispatch.created": {
    category: "review_dispatch",
    text: (r) => `dispatched ${plural(Array.isArray(r.data.document_ids) ? r.data.document_ids.length : 1, "original")}`,
  },
  "dispatch.item_removed": { category: "review_dispatch", text: (r) => `removed ${doc(r)} from a dispatch` },
  // Expected (04)
  "expected.generated": { category: "expected", text: (r) => `generated ${plural(num(r.data.created), "expected item")}` },
  "expected.waived": fixed("expected", "marked an expected document not needed"),
  "expected.auto_waived": fixed("expected", "marked an expected document not needed (plan changed)"),
  "expected.waive_undone": fixed("expected", "undid “not needed” on an expected document"),
  "expected.reopened": fixed("expected", "reopened an expected document"),
  // Reminders (06)
  "reminder.email": fixed("reminders", "emailed a reminder"),
  "reminder.whatsapp": fixed("reminders", "opened a WhatsApp reminder"),
  "reminder.call": fixed("reminders", "logged a call"),
  // Upload links (10)
  "upload_request.created": {
    category: "reminders",
    text: (r) => `sent an upload link for ${plural(num(r.data.scheduled) + num(r.data.ad_hoc), "document")}`,
  },
  "upload_request.retried": fixed("reminders", "re-sent an upload link after a failed email"),
  "upload_request.revoked": fixed("reminders", "revoked an upload link"),
  "upload_request_item.cancelled": fixed("reminders", "cancelled a requested document"),
  "upload_request_item.reopened": fixed("reminders", "reopened a requested document"),
  // Clients & plans (02, 04)
  "client.created": fixed("clients_plans", "added a client"),
  "client.imported": { category: "clients_plans", text: (r) => `imported ${plural(num(r.data.count), "client")}` },
  "client.updated": fixed("clients_plans", "edited a client"),
  "client.archived": fixed("clients_plans", "archived a client"),
  "client.unarchived": fixed("clients_plans", "unarchived a client"),
  "client_group.enabled": fixed("clients_plans", "added a document group to a plan"),
  "client_group.disabled": fixed("clients_plans", "removed a document group from a plan"),
  "client_group.assigned": fixed("clients_plans", "assigned a document group"),
  "client_group.reassigned": { category: "clients_plans", text: (r) => `changed the incharge (${plural(num(r.data.groups), "group")} moved)` },
  "client_group.paused": fixed("clients_plans", "paused a document group"),
  "client_group.resumed": fixed("clients_plans", "resumed a document group"),
  "client_doc_type.added": { category: "clients_plans", text: (r) => `added ${doc(r)} to a plan` },
  "client_doc_type.removed": fixed("clients_plans", "removed a type from a plan"),
  "client_doc_type.restored": fixed("clients_plans", "restored a type to a plan"),
  "client_doc_type.updated": fixed("clients_plans", "changed a type's schedule"),
  "client_doc_type.paused": fixed("clients_plans", "paused a type"),
  "client_doc_type.resumed": fixed("clients_plans", "resumed a type"),
  // Catalogue (02, 03)
  "doc_type.proposed": fixed("catalogue", "proposed a new type"),
  "doc_type.approved": fixed("catalogue", "approved a proposed type"), // 05
  "doc_type.merged": fixed("catalogue", "merged a proposed type into an existing type"), // 05
  "doc_type.rejected": fixed("catalogue", "rejected a proposed type"), // 05
  "doc_type.created": fixed("catalogue", "added a type to the catalogue"),
  "doc_type.updated": fixed("catalogue", "edited a catalogue type"),
  "doc_group.created": fixed("catalogue", "added a document group"),
  "doc_group.updated": fixed("catalogue", "edited a document group"),
  "doc_group.reordered": fixed("catalogue", "reordered the document groups"),
  "financial_year.added": fixed("catalogue", "added a financial year"),
  // Users (01)
  "staff.invited": fixed("users", "invited a user"),
  "staff.activated": fixed("users", "activated their account"),
  "staff.role_changed": fixed("users", "changed a user's role"),
  "staff.deactivated": fixed("users", "deactivated a user"),
  "staff.reactivated": fixed("users", "reactivated a user"),
  // Sign-ins (01)
  "auth.signed_in": fixed("sign_ins", "signed in"),
};

/** "Ravi Kumar" → "Ravi"; system rows → "Vault". */
export const actorLabel = (name: string | null) => (name ? name.trim().split(/\s+/)[0] : "Vault");

export function describeActivity(r: ActivityRowView): { sentence: string; detail: string } {
  const who = actorLabel(r.actor_name);
  const entry = ACTIVITY_CATALOGUE[r.action];
  const sentence = entry ? `${who} ${entry.text(r)}` : `${who} · ${r.action}`;
  const detail = [r.client_name, r.doc_group_name, r.doc_code].filter(Boolean).join(" · ");
  return { sentence, detail };
}

// ── Day headings and times, in India (AC-5) ──────────────────────────────────────────────────────────────────────
const IST = "Asia/Kolkata";
const dayKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/** "Today, 2 October" · "Yesterday, 1 October" · "Monday, 28 September" (IST calendar days). */
export function dayHeading(at: string, now: Date = new Date()): string {
  const d = new Date(at);
  const dayMonth = new Intl.DateTimeFormat("en-GB", { timeZone: IST, day: "numeric", month: "long" }).format(d);
  const key = dayKey(d);
  if (key === dayKey(now)) return `Today, ${dayMonth}`;
  if (key === dayKey(new Date(now.getTime() - 86_400_000))) return `Yesterday, ${dayMonth}`;
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: IST, weekday: "long" }).format(d);
  return `${weekday}, ${dayMonth}`;
}

/** "HH:MM" in IST, 24-hour. */
export function timeOfDay(at: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: IST, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));
}

/** The IST day key (YYYY-MM-DD) used to group rows under one heading. */
export const istDay = (at: string) => dayKey(new Date(at));
