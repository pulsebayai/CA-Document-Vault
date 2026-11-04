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

/** `actor`: who a row with no staff actor is shown as (default "Vault", the system). */
type Entry = { category: ActivityCategory; text: (r: ActivityRowView) => string; actor?: (r: ActivityRowView) => string | null };

/** 19: the platform operator, as a firm sees them in its own Activity (spec AC-13). */
export const PLATFORM_ACTOR = "Pulsebay support";
const platform = () => PLATFORM_ACTOR;
const clientOr = (r: ActivityRowView, fallback: string) => r.client_name ?? fallback;
/** 19: what support read, from the view name and the IDs the row carries (names resolved under the viewer's RLS). */
const VIEWED: Record<string, (r: ActivityRowView) => string> = {
  clients: () => "viewed the client list",
  client: (r) => `viewed ${clientOr(r, "a client")}`,
  documents: (r) => (r.client_name ? `viewed the documents of ${r.client_name}` : "viewed the document list"),
  document: (r) => `viewed ${r.doc_code ?? "a document"}`,
  expected: (r) => `viewed the expected documents of ${clientOr(r, "a client")}`,
  activity: () => "viewed the firm's activity",
};

const doc = (r: ActivityRowView) => r.doc_type_name ?? "a document";
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fixed = (category: ActivityCategory, s: string): Entry => ({ category, text: () => s });

export const ACTIVITY_CATALOGUE: Record<string, Entry> = {
  // Documents (03)
  "document.added": { category: "documents", text: (r) => (r.doc_type_name ? `added ${r.doc_type_name}` : "added an untagged document") },
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
  // 13: hard-copy custody (data: client_id, doc_type_id; undo also `step`).
  "document.in_office": { category: "review_dispatch", text: (r) => `marked ${doc(r)} as in the office` },
  "document.ready": { category: "review_dispatch", text: (r) => `marked ${doc(r)} ready to dispatch` },
  "document.custody_undone": {
    category: "review_dispatch",
    text: (r) => (r.data?.step === "ready" ? `undid Ready to dispatch for ${doc(r)}` : `undid Document in office for ${doc(r)}`),
  },
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
  // A link upload has no actor (the client did it); the feed's "Vault" reads as "Vault received …".
  "document.link_upload": { category: "documents", text: (r) => `received ${doc(r)} through the client's upload link` },
  "upload_request.retried": fixed("reminders", "re-sent an upload link after a failed email"),
  "upload_request.revoked": fixed("reminders", "revoked an upload link"),
  "upload_request_item.cancelled": fixed("reminders", "cancelled a requested document"),
  "upload_request_item.reopened": fixed("reminders", "reopened a requested document"),
  "upload_request_item.filed": fixed("documents", "filed a requested document"),
  // DSCs (14): IDs only (data: client_id; updated also `fields`). Never the holder, a custody name or the password.
  "dsc.created": fixed("dsc", "added a DSC"),
  "dsc.updated": {
    category: "dsc",
    text: (r) => (Array.isArray(r.data.fields) && r.data.fields.length === 1 && r.data.fields[0] === "expires_on"
      ? "renewed a DSC (new expiry date)" : "edited a DSC"),
  },
  "dsc.password_changed": fixed("dsc", "changed a DSC password"),
  "dsc.password_revealed": fixed("password_reveals", "revealed a DSC password"),
  "dsc.given_out": fixed("dsc", "gave out a DSC"),
  "dsc.received_back": fixed("dsc", "received a DSC back"),
  "dsc.archived": fixed("dsc", "archived a DSC"),
  "dsc.unarchived": fixed("dsc", "unarchived a DSC"),
  "dsc.remind_days_set": { category: "dsc", text: (r) => `set DSC expiry reminders to ${plural(num(r.data.remind_days), "day")} before expiry` },
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
  "client_doc_type.format_exception_set": fixed("clients_plans", "allowed any file format for a type"), // 11
  "client_doc_type.format_exception_cleared": fixed("clients_plans", "turned preferred formats back on for a type"), // 11
  // Catalogue (02, 03)
  "doc_type.proposed": fixed("catalogue", "proposed a new type"),
  "doc_type.approved": fixed("catalogue", "approved a proposed type"), // 05
  "doc_type.merged": fixed("catalogue", "merged a proposed type into an existing type"), // 05
  "doc_type.rejected": fixed("catalogue", "rejected a proposed type"), // 05
  "doc_type.created": fixed("catalogue", "added a type to the catalogue"),
  "doc_type.updated": fixed("catalogue", "edited a catalogue type"),
  "doc_type.formats_changed": fixed("catalogue", "changed a type's preferred file formats"), // 11
  "doc_group.created": fixed("catalogue", "added a document group"),
  "doc_group.updated": fixed("catalogue", "edited a document group"),
  "doc_group.reordered": fixed("catalogue", "reordered the document groups"),
  "financial_year.added": fixed("catalogue", "added a financial year"),
  // Users (01)
  // 19: the first Admin of a firm set up from the console is invited by the platform (actor null, via 'platform')
  "staff.invited": { category: "users", text: () => "invited a user", actor: (r) => (r.data.via === "platform" ? PLATFORM_ACTOR : null) },
  "staff.activated": fixed("users", "activated their account"),
  "staff.role_changed": fixed("users", "changed a user's role"),
  "staff.deactivated": fixed("users", "deactivated a user"),
  "staff.reactivated": fixed("users", "reactivated a user"),
  // Firm (17): the Admin's name/branch edit; the operator's bootstrap (actor null → shown as the system)
  "office.updated": fixed("users", "updated the firm's name or branch"),
  "office.bootstrapped": fixed("users", "set up the firm in the vault"),
  // Super admin (19, spec AC-13): read-only support access, suspension. Actor null in the row = the platform. Filed
  // under Users: 08's filter list is fixed by its spec, so a separate "Support access" filter needs its own approval.
  "platform.access_opened": { category: "users", actor: platform, text: () => "opened read-only access to the firm's data for 60 minutes" },
  "platform.viewed": { category: "users", actor: platform, text: (r) => (VIEWED[String(r.data.view)] ?? (() => "viewed the firm's data"))(r) },
  "office.suspended": { category: "users", actor: platform, text: () => "paused the firm's access to the vault" },
  "office.reactivated": { category: "users", actor: platform, text: () => "restored the firm's access to the vault" },
  // written to the platform audit only (src/lib/platform/invite.ts), never to a firm's activity; listed for 08's scan
  "staff.reinvited": { category: "users", actor: platform, text: () => "sent the first Admin's invite again" },
  // Sign-ins (01)
  "auth.signed_in": fixed("sign_ins", "signed in"),
};

/** "Ravi Kumar" → "Ravi"; a row with no staff actor → its entry's actor ("Pulsebay support", 19) or "Vault" (the system). */
export const actorLabel = (name: string | null, row?: ActivityRowView) =>
  name ? name.trim().split(/\s+/)[0] : (row && ACTIVITY_CATALOGUE[row.action]?.actor?.(row)) || "Vault";

export function describeActivity(r: ActivityRowView): { sentence: string; detail: string } {
  const who = actorLabel(r.actor_name, r);
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
