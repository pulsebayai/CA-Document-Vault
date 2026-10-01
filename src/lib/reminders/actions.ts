"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { mailConfig, sendMail } from "@/lib/mail";
import { createClient } from "@/lib/supabase/server";
import { clientRemindersAs, messageFor, remindDialogAs, type ReminderListEntry, type RemindDialogData } from "./queries";
import { maskEmail, reminderErrorMessage, type FollowUpStatus } from "./shape";

// Feature 06 step 4 — Remind (email / WhatsApp), Log call, the dialog data and the client's Reminders list.
// Server actions are POSTs: no client data in URLs. Errors are logged as a code + request ID only.
//
// Email is two-phase (spec "Sending"): begin_email_reminder records a pending follow-up and enforces the cap and the
// office ceiling in the database → the mailer (test transport unless MAIL_TRANSPORT=brevo; allow-list outside
// production; .test never) → finish_email_reminder records Sent / Failed / Suppressed.

type Failure = { ok: false; error: string };
const uuid = z.uuid();
const ids = z.array(z.uuid()).min(1).max(200);

function logged(op: string, code: string | undefined): Failure & { requestId: string } {
  const requestId = randomUUID();
  console.error(`reminders.${op}_failed`, { code: code ?? "unknown", requestId });
  return { ok: false, error: "", requestId };
}
const dbFailure = (op: string, err: { code?: string; message?: string }): Failure => {
  const known = /^[A-Z_]+:/.test(err.message ?? "");
  if (known) return { ok: false, error: reminderErrorMessage(err.message) };
  const l = logged(op, err.code);
  return { ok: false, error: `${reminderErrorMessage(undefined)} (Ref ${l.requestId.slice(0, 8)})` };
};
const touch = (clientId: string) => { revalidatePath(`/clients/${clientId}`); revalidatePath("/today"); };

export type DialogResult = { ok: true; data: RemindDialogData } | Failure;

/** AC-7 / AC-11: everything the Remind and Log call dialogs need for one client. */
export async function remindDialog(clientId: string): Promise<DialogResult> {
  const me = await requireStaff();
  if (!uuid.safeParse(clientId).success) return { ok: false, error: "Invalid request." };
  try {
    const data = await remindDialogAs(me, clientId, mailConfig().dailyMax);
    return data ? { ok: true, data } : { ok: false, error: reminderErrorMessage("NOT_FOUND") };
  } catch {
    return { ok: false, error: "Could not load this client's open documents. Please try again." };
  }
}

/** The preview text for the ticked items (AC-7: exactly what will be sent). */
export async function reminderPreview(clientId: string, itemIds: string[]): Promise<{ ok: true; text: string } | Failure> {
  const me = await requireStaff();
  if (!uuid.safeParse(clientId).success || !ids.safeParse(itemIds).success) return { ok: false, error: reminderErrorMessage("NO_ITEMS") };
  try {
    const built = await messageFor(me, clientId, itemIds);
    return built ? { ok: true, text: built.message.text } : { ok: false, error: reminderErrorMessage("ITEMS_INVALID") };
  } catch {
    return { ok: false, error: "Could not build the message. Please try again." };
  }
}

export type SendEmailResult =
  | { ok: true; status: Extract<FollowUpStatus, "sent" | "failed" | "suppressed">; at: string; to: string; error?: string }
  | Failure;

/** AC-8: Send email. A failed send returns ok:true with status "failed" (the UI offers Retry). */
export async function sendEmailReminder(clientId: string, itemIds: string[]): Promise<SendEmailResult> {
  const me = await requireStaff();
  if (!uuid.safeParse(clientId).success || !ids.safeParse(itemIds).success) return { ok: false, error: reminderErrorMessage("NO_ITEMS") };
  let cfg;
  try {
    cfg = mailConfig();
  } catch {
    const l = logged("config", "MAIL_CONFIG"); // review N-3: a bad MAIL_TRANSPORT is a plain error, not a crash
    return { ok: false, error: `Email isn't set up correctly here (Ref ${l.requestId.slice(0, 8)}). Use WhatsApp or log a call.` };
  }
  let built;
  try {
    built = await messageFor(me, clientId, itemIds);
  } catch {
    return { ok: false, error: "Could not build the message. Please try again." };
  }
  if (!built) return { ok: false, error: reminderErrorMessage("ITEMS_INVALID") };

  const supabase = await createClient();
  const begun = await supabase.rpc("begin_email_reminder", { p_client: clientId, p_items: itemIds, p_daily_max: cfg.dailyMax });
  if (begun.error) return dbFailure("begin", begun.error);
  const { id, recipient } = begun.data as { id: string; recipient: string };

  const result = await sendMail({
    to: recipient, subject: built.message.subject, text: built.message.text, html: built.message.html,
    replyTo: { email: me.email, name: me.fullName },
  }, cfg);

  const finish = () => supabase.rpc("finish_email_reminder", {
    p_id: id, p_status: result.status, p_provider_id: result.providerId, p_error_code: result.errorCode,
  });
  let fin = await finish();
  if (fin.error) fin = await finish(); // review N-2: one retry before giving up
  touch(clientId);
  if (fin.error) {
    // The provider's answer couldn't be recorded: the row stays pending (closed as TIMEOUT after 10 minutes).
    // If it was sent, a second send later today would be a real duplicate — say so instead of "Sent".
    const l = logged("finish", fin.error.code);
    return { ok: false, error: result.status === "sent"
      ? `The email was sent, but the vault couldn't record it (Ref ${l.requestId.slice(0, 8)}). Don't send it again today.`
      : `The result couldn't be recorded (Ref ${l.requestId.slice(0, 8)}). Please try again in a few minutes.` };
  }
  return {
    ok: true, status: result.status, at: new Date().toISOString(), to: maskEmail(recipient),
    ...(result.status === "failed" ? { error: `Not sent (${result.errorCode ?? "error"}). You can retry.` } : {}),
  };
}

/** AC-9: record the WhatsApp chat the browser has just opened. Not capped. */
export async function recordWhatsApp(clientId: string, itemIds: string[]): Promise<{ ok: true } | Failure> {
  await requireStaff();
  if (!uuid.safeParse(clientId).success || !ids.safeParse(itemIds).success) return { ok: false, error: reminderErrorMessage("NO_ITEMS") };
  const supabase = await createClient();
  const { error } = await supabase.rpc("record_follow_up", { p_client: clientId, p_items: itemIds, p_channel: "whatsapp" });
  if (error) return dbFailure("whatsapp", error);
  touch(clientId);
  return { ok: true };
}

const callInput = z.object({
  clientId: z.uuid(), itemIds: ids,
  on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  note: z.string().max(300).nullable().optional(),
});

/** AC-11: Log call — date (default today, never future) and an optional note ≤ 300 characters. */
export async function logCall(input: { clientId: string; itemIds: string[]; on?: string | null; note?: string | null }): Promise<{ ok: true } | Failure> {
  await requireStaff();
  const p = callInput.safeParse(input);
  if (!p.success) {
    const tooLong = p.error.issues.some((i) => i.path[0] === "note");
    return { ok: false, error: reminderErrorMessage(tooLong ? "NOTE_TOO_LONG" : "NO_ITEMS") };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("record_follow_up", {
    p_client: p.data.clientId, p_items: p.data.itemIds, p_channel: "phone", p_on: p.data.on ?? null, p_note: p.data.note?.trim() || null,
  });
  if (error) return dbFailure("call", error);
  touch(p.data.clientId);
  return { ok: true };
}

/** AC-12: the client's Reminders list. */
export async function clientReminders(clientId: string): Promise<{ ok: true; entries: ReminderListEntry[] } | Failure> {
  await requireStaff();
  if (!uuid.safeParse(clientId).success) return { ok: false, error: "Invalid request." };
  try {
    return { ok: true, entries: await clientRemindersAs(clientId) };
  } catch {
    return { ok: false, error: "Could not load reminders. Please try again." };
  }
}
