"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";
import { istDate } from "@/lib/documents/period";
import { validateReceipt, type ReceiptIssue } from "./validation";

// Feature 13 (spec AC-13 … AC-15) — Log receipt: N hard copies with no file in one call to log_receipt (03's
// create_document per paper, all or nothing). The handed-over name is never logged; errors are code + request ID.

export type LogReceiptResult =
  | { ok: true; clientCode: string; documents: Array<{ id: string; docCode: string }> }
  | { ok: false; error: string; fieldErrors: Partial<Record<ReceiptIssue["field"], string>> };

const DB_MESSAGES: Array<[RegExp, string]> = [
  [/CLIENT_ARCHIVED/, "This client is archived."],
  [/NOT_FOUND: client|row-level security|CLIENT_OFFICE/, "Choose a client you can see."],
  [/TYPE_NOT_OFFERED|TYPE_OFFICE/, "This type isn't offered for this client. Choose another, or leave it blank."],
  [/PERIOD_KIND|PERIOD_OFFICE/, "This period doesn't fit the type. Choose another."],
  [/RECEIVED_ON_FUTURE/, "Received on can't be in the future."],
  [/ROLE_REQUIRED/, "Your session has ended. Sign in again."],
];

export async function logReceipt(input: Record<string, unknown>): Promise<LogReceiptResult> {
  await requireStaff();
  const v = validateReceipt(input ?? {}, istDate());
  if (!v.data) {
    return { ok: false, error: "Check the highlighted fields.", fieldErrors: Object.fromEntries(v.errors.map((e) => [e.field, e.message])) };
  }
  const d = v.data;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("log_receipt", { p: {
    client_id: d.clientId, doc_type_id: d.docTypeId, period_id: d.periodId, count: d.count, handed_over_name: d.handedOverName,
    returnable: d.returnable, received_on: d.receivedOn, channel: d.channel, remark: d.remark,
  } });
  if (error) {
    console.error("receipt.log_failed", { code: error.code ?? "unknown", requestId: randomUUID() });
    return { ok: false, error: DB_MESSAGES.find(([re]) => re.test(error.message))?.[1] ?? "Couldn't save. Please try again.", fieldErrors: {} };
  }
  const r = data as { client_code: string; documents: Array<{ id: string; doc_code: string }> };
  revalidatePath("/inbox");
  revalidatePath(`/clients/${d.clientId}`);
  revalidatePath("/today");
  return { ok: true, clientCode: r.client_code, documents: r.documents.map((x) => ({ id: x.id, docCode: x.doc_code })) };
}
