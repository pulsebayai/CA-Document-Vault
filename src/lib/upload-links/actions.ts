"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ReminderMessage } from "@/lib/reminders/message";
import { maskEmail, reminderErrorMessage } from "@/lib/reminders/shape";
import { notePii, NOTE_MAX, NOTE_PII_MESSAGE } from "./note";
import type { AdHocInput, LinkOptions } from "./queries";
import { buildLink, newLinkToken } from "./token";

// Server-only dependencies load on first use, so a client component (and its unit tests) can import these action
// references without pulling server modules into the browser bundle or the jsdom test environment.
async function deps() {
  const [staff, expected, mail, message, reminders, supabase, queries] = await Promise.all([
    import("@/lib/auth/staff"), import("@/lib/expected/queries"), import("@/lib/mail"), import("@/lib/reminders/message"),
    import("@/lib/reminders/queries"), import("@/lib/supabase/server"), import("./queries"),
  ]);
  return {
    requireStaff: staff.requireStaff, todayForOffice: expected.todayForOffice, mailConfig: mail.mailConfig, sendMail: mail.sendMail,
    buildReminderMessage: message.buildReminderMessage, chosenItemsAs: reminders.chosenItemsAs, createClient: supabase.createClient,
    adHocLinesAs: queries.adHocLinesAs, linkBase: queries.linkBase, linkOptionsAs: queries.linkOptionsAs, retryContentAs: queries.retryContentAs,
  };
}

// Feature 10 step 6 — sending an upload link from the Remind dialog (spec AC-1…AC-5). Server actions (POST).
// The token is made here, stored only as its hash (begin_link_email / record_link_whatsapp), and leaves the server
// only inside the message: in the email body, or in the WhatsApp text returned to the sender's own browser.
// Nothing about the token, the address or the message is logged (code + request ID only).

type Failure = { ok: false; error: string };
const uuid = z.uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const adHocSchema = z.object({
  docTypeId: z.uuid(), periodId: z.uuid().nullable(), registrationId: z.uuid().nullable(),
  neededBy: date.nullable(), note: z.string().max(NOTE_MAX).nullable(),
});
const input = z.object({
  clientId: z.uuid(),
  itemIds: z.array(z.uuid()).max(50),
  adHoc: z.array(adHocSchema).max(50),
  replaces: z.uuid().nullable().optional(),
}).refine((v) => v.itemIds.length + v.adHoc.length > 0 && v.itemIds.length + v.adHoc.length <= 50);
export type LinkSendInput = z.infer<typeof input>;

const LINK_MESSAGES: Record<string, string> = {
  NOTE_PII: NOTE_PII_MESSAGE,
  NOTE_TOO_LONG: "Keep each note to 200 characters.",
  TYPE_INVALID: "One of the document types can't be requested from this client.",
  PERIOD_INVALID: "A period doesn't fit its document type.",
  REGISTRATION_INVALID: "Choose one of this client's active registrations of that kind.",
  NEEDED_BY_PAST: "A needed-by date can't be in the past.",
  TOO_MANY_ITEMS: "A link can request at most 50 documents.",
  NOT_SENDER: "Only the person who sent the link can retry it.",
  NOT_FAILED: "Only a link whose email failed can be retried.",
  NOT_ACTIVE: "This link is no longer active.",
};
function failure(op: string, err: { code?: string; message?: string }): Failure {
  const code = /^([A-Z_]+):/.exec(err.message ?? "")?.[1];
  if (code && LINK_MESSAGES[code]) return { ok: false, error: LINK_MESSAGES[code] };
  if (code) return { ok: false, error: reminderErrorMessage(err.message) };
  const requestId = randomUUID();
  console.error(`upload_links.${op}_failed`, { code: err.code ?? "unknown", requestId });
  return { ok: false, error: `Something went wrong. Please try again. (Ref ${requestId.slice(0, 8)})` };
}
const touch = (clientId: string) => { revalidatePath(`/clients/${clientId}`); revalidatePath("/today"); };
const items = (v: LinkSendInput) => [
  ...v.itemIds.map((id) => ({ kind: "scheduled", expected_doc_id: id })),
  ...v.adHoc.map((a) => ({ kind: "ad_hoc", doc_type_id: a.docTypeId, period_id: a.periodId, registration_id: a.registrationId,
    needed_by: a.neededBy, note: a.note?.trim() || null })),
];
const openUntilOf = (expiresAt: string) =>
  new Date(Date.parse(expiresAt) - 86_400_000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

/** The ad-hoc type list, periods and registrations for the dialog; enabled = APP_PUBLIC_URL is set. */
export async function linkOptions(clientId: string): Promise<{ ok: true; data: LinkOptions } | Failure> {
  const { requireStaff, linkOptionsAs } = await deps();
  await requireStaff();
  if (!uuid.safeParse(clientId).success) return { ok: false, error: "Invalid request." };
  try {
    return { ok: true, data: await linkOptionsAs(clientId) };
  } catch {
    return { ok: false, error: "Could not load document types. Please try again." };
  }
}

/** Validates the ad-hoc notes before anything is written (the database checks again). */
function checkNotes(v: LinkSendInput): Failure | null {
  for (const a of v.adHoc) if (notePii(a.note)) return { ok: false, error: NOTE_PII_MESSAGE };
  return null;
}

async function buildLinkMessage(
  me: { officeId: string; officeName: string; fullName: string }, clientId: string, clientName: string,
  itemIds: string[], adHoc: AdHocInput[], link: { url: string; openUntil: string },
): Promise<ReminderMessage | null> {
  const { todayForOffice, chosenItemsAs, adHocLinesAs, buildReminderMessage } = await deps();
  const today = await todayForOffice(me.officeId);
  const [scheduled, lines] = await Promise.all([chosenItemsAs(clientId, itemIds, today), adHocLinesAs(adHoc)]);
  if (!scheduled || !lines) return null;
  return buildReminderMessage({ clientName, items: scheduled, adHoc: lines, senderName: me.fullName, firmName: me.officeName, today, uploadLink: link });
}

async function clientName(clientId: string): Promise<string | null> {
  const { createClient } = await deps();
  const supabase = await createClient();
  const { data } = await supabase.from("client").select("name, archived_at").eq("id", clientId).maybeSingle();
  return data && !data.archived_at ? data.name : null;
}

export type LinkEmailResult =
  | { ok: true; requestId: string; status: "sent" | "failed" | "suppressed"; at: string; to: string; openUntil: string; error?: string }
  | Failure;

/** AC-2: Send email with an upload link. Two-phase (06): pending follow-up + request, then Brevo, then the result. */
export async function sendLinkEmail(raw: LinkSendInput): Promise<LinkEmailResult> {
  const { requireStaff, linkBase, mailConfig, createClient } = await deps();
  const me = await requireStaff();
  const p = input.safeParse(raw);
  if (!p.success) return { ok: false, error: reminderErrorMessage("NO_ITEMS") };
  const bad = checkNotes(p.data); if (bad) return bad;
  const base = linkBase();
  if (!base) return { ok: false, error: "Upload links aren't set up in this environment." };
  let cfg;
  try { cfg = mailConfig(); } catch { return failure("config", { code: "MAIL_CONFIG" }); }
  const name = await clientName(p.data.clientId);
  if (!name) return { ok: false, error: reminderErrorMessage("NOT_FOUND") };

  const { token, hash } = newLinkToken();
  const supabase = await createClient();
  const begun = await supabase.rpc("begin_link_email", { p: {
    client_id: p.data.clientId, items: items(p.data), token_hash: hash, daily_max: cfg.dailyMax, replaces: p.data.replaces ?? null,
  } });
  if (begun.error) return failure("begin", begun.error);
  const b = begun.data as { request_id: string; follow_up_id: string; recipient: string; expires_at: string };
  return deliver(me, p.data.clientId, name, p.data.itemIds, p.data.adHoc, b.request_id, b.follow_up_id, b.recipient, b.expires_at, buildLink(base, token));
}

async function deliver(
  me: { officeId: string; officeName: string; fullName: string; email: string }, clientId: string, name: string,
  itemIds: string[], adHoc: AdHocInput[], requestId: string, followUpId: string, recipient: string, expiresAt: string, url: string,
): Promise<LinkEmailResult> {
  const { createClient, sendMail, mailConfig } = await deps();
  const openUntil = openUntilOf(expiresAt);
  const message = await buildLinkMessage(me, clientId, name, itemIds, adHoc, { url, openUntil });
  const supabase = await createClient();
  const finish = (status: "sent" | "failed" | "suppressed", providerId: string | null, errorCode: string | null) =>
    supabase.rpc("finish_email_reminder", { p_id: followUpId, p_status: status, p_provider_id: providerId, p_error_code: errorCode });
  if (!message) {
    await finish("failed", null, "MESSAGE");
    touch(clientId);
    return { ok: true, requestId, status: "failed", at: new Date().toISOString(), to: maskEmail(recipient), openUntil,
      error: "Not sent: some documents changed meanwhile. You can retry." };
  }
  const result = await sendMail({ to: recipient, subject: message.subject, text: message.text, html: message.html,
    replyTo: { email: me.email, name: me.fullName } }, mailConfig());
  let fin = await finish(result.status, result.providerId ?? null, result.errorCode ?? null);
  if (fin.error) fin = await finish(result.status, result.providerId ?? null, result.errorCode ?? null);
  touch(clientId);
  if (fin.error) return failure("finish", fin.error);
  return { ok: true, requestId, status: result.status, at: new Date().toISOString(), to: maskEmail(recipient), openUntil,
    ...(result.status === "failed" ? { error: `Not sent (${result.errorCode ?? "error"}). You can retry.` } : {}) };
}

/** AC-2: Retry after a failed email — a new token for the same request (the old one was never delivered). */
export async function retryLinkEmail(requestId: string): Promise<LinkEmailResult> {
  const { requireStaff, linkBase, retryContentAs, createClient, mailConfig } = await deps();
  const me = await requireStaff();
  if (!uuid.safeParse(requestId).success) return { ok: false, error: "Invalid request." };
  const base = linkBase();
  if (!base) return { ok: false, error: "Upload links aren't set up in this environment." };
  const content = await retryContentAs(requestId);
  if (!content) return { ok: false, error: "This link is no longer available." };
  const name = await clientName(content.clientId);
  if (!name) return { ok: false, error: reminderErrorMessage("NOT_FOUND") };
  const { token, hash } = newLinkToken();
  const supabase = await createClient();
  const r = await supabase.rpc("retry_link_email", { p_request: requestId, p_token_hash: hash, p_daily_max: mailConfig().dailyMax });
  if (r.error) return failure("retry", r.error);
  const d = r.data as { follow_up_id: string; recipient: string; expires_at: string };
  return deliver(me, content.clientId, name, content.scheduledIds, content.adHoc, requestId, d.follow_up_id, d.recipient, d.expires_at, buildLink(base, token));
}

export type LinkWhatsAppResult = { ok: true; requestId: string; text: string; openUntil: string } | Failure;

/**
 * AC-2: the WhatsApp variant. The browser has already opened a blank tab from the click (popup blockers); this
 * records the follow-up and the request and returns the message text (with the link) for that tab's wa.me URL.
 */
export async function recordLinkWhatsApp(raw: LinkSendInput): Promise<LinkWhatsAppResult> {
  const { requireStaff, linkBase, createClient } = await deps();
  const me = await requireStaff();
  const p = input.safeParse(raw);
  if (!p.success) return { ok: false, error: reminderErrorMessage("NO_ITEMS") };
  const bad = checkNotes(p.data); if (bad) return bad;
  const base = linkBase();
  if (!base) return { ok: false, error: "Upload links aren't set up in this environment." };
  const name = await clientName(p.data.clientId);
  if (!name) return { ok: false, error: reminderErrorMessage("NOT_FOUND") };
  const { token, hash } = newLinkToken();
  const supabase = await createClient();
  const r = await supabase.rpc("record_link_whatsapp", { p: {
    client_id: p.data.clientId, items: items(p.data), token_hash: hash, replaces: p.data.replaces ?? null,
  } });
  if (r.error) return failure("whatsapp", r.error);
  const d = r.data as { request_id: string; expires_at: string };
  const openUntil = openUntilOf(d.expires_at);
  const message = await buildLinkMessage(me, p.data.clientId, name, p.data.itemIds, p.data.adHoc, { url: buildLink(base, token), openUntil });
  touch(p.data.clientId);
  if (!message) return { ok: false, error: "The link was created but the message couldn't be built. Revoke it and try again." };
  return { ok: true, requestId: d.request_id, text: message.text, openUntil };
}

/** AC-18: Revoke (requester or Admin/Manager; the database checks). */
export async function revokeLink(requestId: string, clientId: string): Promise<{ ok: true } | Failure> {
  const { requireStaff, createClient } = await deps();
  await requireStaff();
  if (!uuid.safeParse(requestId).success || !uuid.safeParse(clientId).success) return { ok: false, error: "Invalid request." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("revoke_upload_request", { p_id: requestId });
  if (error) return failure("revoke", error);
  touch(clientId);
  return { ok: true };
}
