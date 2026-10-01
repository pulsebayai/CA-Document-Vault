import "server-only";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { todayForOffice } from "@/lib/expected/queries";
import { buildReminderMessage, type ReminderMessage } from "./message";
import {
  STALE_PENDING_MS, dialogItems, historyOf, historyText, maskEmail, type Channel, type DialogItem, type FollowUpStatus, type HistoryEntry,
  type RawDialogItem,
} from "./shape";

// Feature 06 — reads for the Remind / Log call dialogs, the message preview and the client's Reminders list
// (AC-7…AC-12). Everything runs as the signed-in user, so RLS limits it to clients they can see.
// Errors are logged as a code + request ID only — never an address, mobile, name or message text.

export class ReminderError extends Error {
  constructor(readonly op: string, readonly code: string | undefined, readonly requestId = randomUUID()) {
    super(`REMINDER_${op.toUpperCase()}_FAILED`);
  }
}
function fail(op: string, code: string | undefined): never {
  const e = new ReminderError(op, code);
  console.error(`reminders.${op}_failed`, { code: code ?? "unknown", requestId: e.requestId });
  throw e;
}

type Supa = Awaited<ReturnType<typeof createClient>>;

const ITEM_SELECT = `id, overdue_from, status,
  doc_type:doc_type_id (name, doc_group:doc_group_id (name, sort)),
  period:period_id (label, start_date),
  registration:registration_id (kind, state_code, number),
  row:client_doc_type_id (reminders, state, group:client_group_id (state)),
  follow_up_item (follow_up:follow_up_id (sent_on, sent_at, channel, status, staff:sent_by (full_name)))`;

type RawItem = {
  id: string; overdue_from: string; status: string;
  doc_type: { name: string; doc_group: { name: string; sort: number } };
  period: { label: string; start_date: string };
  registration: { kind: "gstin" | "tan"; state_code: string | null; number: string } | null;
  row: { reminders: boolean; state: string; group: { state: string } } | null;
  follow_up_item: Array<{ follow_up: { sent_on: string; sent_at: string; channel: Channel; status: FollowUpStatus; staff: { full_name: string } | null } | null }>;
};

function toRaw(r: RawItem): RawDialogItem {
  const reg = r.registration;
  return {
    id: r.id, group: r.doc_type.doc_group.name, groupSort: r.doc_type.doc_group.sort, type: r.doc_type.name,
    period: r.period.label, periodStart: r.period.start_date, regKind: reg?.kind ?? null,
    // Only the state code leaves this module; the GSTIN/TAN number is never passed on.
    stateCode: reg?.kind === "gstin" ? (reg.state_code ?? reg.number.slice(0, 2)) : null,
    overdueFrom: r.overdue_from, reminders: r.row?.reminders ?? false,
    history: r.follow_up_item.flatMap((fi) => fi.follow_up ? [{
      on: fi.follow_up.sent_on, at: fi.follow_up.sent_at, by: fi.follow_up.staff?.full_name ?? "—",
      channel: fi.follow_up.channel, status: fi.follow_up.status,
    } satisfies HistoryEntry] : []),
  };
}

/** The client's open items (pending, not on hold), as the dialog shows them. */
async function openItems(supabase: Supa, clientId: string): Promise<RawDialogItem[]> {
  const { data, error } = await supabase.from("expected_doc").select(ITEM_SELECT)
    .eq("client_id", clientId).eq("status", "pending").order("overdue_from").limit(500);
  if (error) fail("items", error.code);
  return ((data ?? []) as unknown as RawItem[])
    .filter((r) => r.row && r.row.state !== "paused" && r.row.group.state !== "paused")
    .map(toRaw);
}

export type DialogClient = {
  id: string; name: string;
  /** "a…@…" or null; the full address never reaches the browser. */
  emailMasked: string | null;
  /** Needed in the browser for the wa.me link (the documented exception); null if none. */
  mobile: string | null;
};

export type RemindDialogData = {
  today: string;
  client: DialogClient;
  items: DialogItem[];
  /** AC-8: set when the client was already emailed today (or an email is in flight). */
  emailedToday: { at: string; by: string; status: FollowUpStatus } | null;
  /** AC-14, as far as this user can see (a Limited user may only learn it on Send). */
  dailyLimitReached: boolean;
  sender: { name: string; firm: string };
};

/** Remind / Log call dialog data for one client (AC-7, AC-8, AC-11). Null if the client isn't visible or archived. */
export async function remindDialogAs(
  me: { officeId: string; officeName: string; fullName: string }, clientId: string, dailyMax: number,
): Promise<RemindDialogData | null> {
  const supabase = await createClient();
  const today = await todayForOffice(me.officeId);
  const [{ data: client, error: e1 }, items, { data: todays, error: e2 }, { count, error: e3 }] = await Promise.all([
    supabase.from("client").select("id, name, email, mobile, archived_at").eq("id", clientId).maybeSingle(),
    openItems(supabase, clientId),
    supabase.from("follow_up").select("sent_at, status, staff:sent_by (full_name)")
      .eq("client_id", clientId).eq("channel", "email").eq("sent_on", today).in("status", ["pending", "sent", "suppressed"])
      .order("sent_at", { ascending: false }).limit(1),
    supabase.from("follow_up").select("id", { count: "exact", head: true })
      .eq("office_id", me.officeId).eq("channel", "email").eq("sent_on", today)
      .or(`status.eq.sent,and(status.eq.pending,sent_at.gt.${new Date(Date.now() - STALE_PENDING_MS).toISOString()})`),
  ]);
  if (e1 || e2 || e3) fail("dialog", (e1 ?? e2 ?? e3)?.code);
  if (!client || client.archived_at) return null;
  const t = (todays ?? [])[0] as unknown as { sent_at: string; status: FollowUpStatus; staff: { full_name: string } | null } | undefined;
  const fresh = t && (t.status !== "pending" || Date.now() - Date.parse(t.sent_at) < STALE_PENDING_MS);
  return {
    today,
    client: { id: client.id, name: client.name, emailMasked: client.email ? maskEmail(client.email) : null, mobile: client.mobile },
    items: dialogItems(items, today),
    emailedToday: fresh ? { at: t.sent_at, by: t.staff?.full_name ?? "—", status: t.status } : null,
    dailyLimitReached: (count ?? 0) >= dailyMax,
    sender: { name: me.fullName, firm: me.officeName },
  };
}

/** The exact message for the ticked items (AC-10), built from the database's current state, not the browser's. */
export async function messageFor(
  me: { officeId: string; officeName: string; fullName: string }, clientId: string, itemIds: string[],
): Promise<{ message: ReminderMessage; clientName: string } | null> {
  const supabase = await createClient();
  const [today, { data: client, error }, items] = await Promise.all([
    todayForOffice(me.officeId),
    supabase.from("client").select("name").eq("id", clientId).maybeSingle(),
    openItems(supabase, clientId),
  ]);
  if (error) fail("message", error.code);
  if (!client) return null;
  const wanted = new Set(itemIds);
  const chosen = dialogItems(items.filter((i) => wanted.has(i.id)), today);
  if (chosen.length !== wanted.size || chosen.length === 0) return null; // an item closed meanwhile → the DB says ITEMS_INVALID
  return {
    clientName: client.name,
    message: buildReminderMessage({ clientName: client.name, items: chosen, senderName: me.fullName, firmName: me.officeName, today }),
  };
}

export type ReminderListEntry = {
  id: string; on: string; at: string; channel: Channel; status: FollowUpStatus; by: string;
  items: string[]; note: string | null; errorCode: string | null; recipientMasked: string | null;
};

/** AC-12: the client's Reminders list, newest first. Pending emails older than 10 minutes show as failed. */
export async function clientRemindersAs(clientId: string, limit = 50): Promise<ReminderListEntry[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("follow_up")
    .select(`id, sent_on, sent_at, channel, status, note, error_code, recipient, staff:sent_by (full_name),
      follow_up_item (expected_doc:expected_doc_id (doc_type:doc_type_id (name), period:period_id (label)))`)
    .eq("client_id", clientId).order("sent_at", { ascending: false }).limit(limit);
  if (error) fail("list", error.code);
  type Row = {
    id: string; sent_on: string; sent_at: string; channel: Channel; status: FollowUpStatus; note: string | null;
    error_code: string | null; recipient: string | null; staff: { full_name: string } | null;
    follow_up_item: Array<{ expected_doc: { doc_type: { name: string }; period: { label: string } } | null }>;
  };
  return ((data ?? []) as unknown as Row[]).map((r) => {
    const stale = r.status === "pending" && Date.now() - Date.parse(r.sent_at) >= STALE_PENDING_MS;
    return {
      id: r.id, on: r.sent_on, at: r.sent_at, channel: r.channel, status: stale ? "failed" : r.status,
      by: r.staff?.full_name ?? "—", note: r.note, errorCode: stale ? "TIMEOUT" : r.error_code,
      recipientMasked: r.channel === "email" && r.recipient ? maskEmail(r.recipient) : null,
      items: r.follow_up_item.flatMap((fi) => fi.expected_doc ? [`${fi.expected_doc.doc_type.name} · ${fi.expected_doc.period.label}`] : []),
    };
  });
}

/** AC-12: "reminded N times · last <date> by <name> (<channel>)" for every expected item of one client. */
export async function itemHistoryAs(clientId: string, today: string): Promise<Record<string, string>> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("follow_up")
    .select("sent_on, sent_at, channel, status, staff:sent_by (full_name), follow_up_item (expected_doc_id)")
    .eq("client_id", clientId).limit(2000);
  if (error) fail("history", error.code);
  type Row = { sent_on: string; sent_at: string; channel: Channel; status: FollowUpStatus; staff: { full_name: string } | null; follow_up_item: Array<{ expected_doc_id: string }> };
  const byItem = new Map<string, HistoryEntry[]>();
  for (const f of (data ?? []) as unknown as Row[]) {
    for (const fi of f.follow_up_item) {
      const list = byItem.get(fi.expected_doc_id) ?? [];
      list.push({ on: f.sent_on, at: f.sent_at, by: f.staff?.full_name ?? "—", channel: f.channel, status: f.status });
      byItem.set(fi.expected_doc_id, list);
    }
  }
  return Object.fromEntries([...byItem].map(([id, h]) => [id, historyText(historyOf(h), today)]));
}
