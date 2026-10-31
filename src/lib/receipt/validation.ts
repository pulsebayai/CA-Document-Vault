import { z } from "zod";
import { CHANNELS, type Channel } from "@/lib/validation/document";

// Feature 13 (spec AC-13, AC-14) — Log receipt: the fields reception fills in. Pure, so it is unit-tested; the server
// action applies it before calling log_receipt, which checks the same rules again.

export const MAX_RECEIPT_COUNT = 20;
export type ReceiptIssue = { field: "clientId" | "docTypeId" | "periodId" | "count" | "handedOverName" | "receivedOn" | "channel" | "remark"; message: string };
export type ValidReceipt = {
  clientId: string; docTypeId: string | null; periodId: string | null; count: number; handedOverName: string;
  returnable: boolean; receivedOn: string; channel: Channel; remark: string | null;
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const uuid = (v: string) => z.uuid().safeParse(v).success;
const isRealDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export function validateReceipt(input: Record<string, unknown>, today: string): { data: ValidReceipt | null; errors: ReceiptIssue[] } {
  const errors: ReceiptIssue[] = [];
  const clientId = str(input.clientId);
  if (!uuid(clientId)) errors.push({ field: "clientId", message: "Choose the client." });
  const docTypeId = str(input.docTypeId) || null;
  if (docTypeId && !uuid(docTypeId)) errors.push({ field: "docTypeId", message: "Choose a type from the list, or leave it blank." });
  const periodId = docTypeId ? str(input.periodId) || null : null; // a period only goes with a type
  if (periodId && !uuid(periodId)) errors.push({ field: "periodId", message: "Choose a period from the list." });
  const countText = typeof input.count === "number" ? String(input.count) : str(input.count);
  const count = /^\d{1,2}$/.test(countText) ? Number(countText) : NaN;
  if (!(count >= 1 && count <= MAX_RECEIPT_COUNT)) errors.push({ field: "count", message: `How many: 1 to ${MAX_RECEIPT_COUNT}.` });
  const handedOverName = str(input.handedOverName);
  if (!handedOverName) errors.push({ field: "handedOverName", message: "Say who handed it over." });
  else if (handedOverName.length > 120) errors.push({ field: "handedOverName", message: "Too long (120 characters max)." });
  const receivedOn = str(input.receivedOn) || today;
  if (!isRealDate(receivedOn)) errors.push({ field: "receivedOn", message: "Enter a valid date." });
  else if (receivedOn > today) errors.push({ field: "receivedOn", message: "Received on can't be in the future." });
  const channel = (str(input.channel) || "hand_delivery") as Channel;
  if (!CHANNELS.some((c) => c.value === channel)) errors.push({ field: "channel", message: "Choose the channel." });
  const remark = str(input.remark);
  if (remark.length > 500) errors.push({ field: "remark", message: "Remark is too long (500 characters max)." });
  if (errors.length) return { data: null, errors };
  return { data: { clientId, docTypeId, periodId, count, handedOverName, returnable: input.returnable === true, receivedOn, channel, remark: remark || null }, errors };
}

/** The paper reference to write on each sheet (Sankar #6): client code + DOC-ID. */
export const paperReference = (clientCode: string, docCode: string) => `${clientCode} · ${docCode}`;
