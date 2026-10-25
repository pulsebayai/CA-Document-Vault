import { z } from "zod";
import type { FieldIssue } from "./client";

// Spec 03 AC-1, AC-2, AC-4. Mirrors the database: private.mime_for_extension, the document_version checks
// and the `documents` bucket allow-list (migration 20260928105415). Change them together.

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** The one type each allowed extension is stored as (upload Content-Type, bucket allow-list, DB check). */
export const MIME_BY_EXTENSION = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  zip: "application/zip",
} as const;
export type AllowedExtension = keyof typeof MIME_BY_EXTENSION;
export const ALLOWED_EXTENSIONS = Object.keys(MIME_BY_EXTENSION) as AllowedExtension[];

/** Other types browsers/OSes declare for the same files. An empty declared type is accepted: many systems
 *  send none for HEIC, CSV or Office files; the stored type is set by us from the extension anyway. */
const ALSO_DECLARED: Partial<Record<AllowedExtension, readonly string[]>> = {
  jpg: ["image/pjpeg"],
  jpeg: ["image/pjpeg"],
  heic: ["image/heif", "image/heic-sequence"],
  csv: ["application/vnd.ms-excel", "application/csv", "text/plain", "text/x-csv"],
  zip: ["application/x-zip-compressed", "application/x-zip", "multipart/x-zip"],
  xls: ["application/excel", "application/x-excel"],
};

/** File types a browser can show inline (View); everything else is Download only. */
const VIEWABLE = new Set<string>(["application/pdf", "image/jpeg", "image/png"]);
export const canView = (mime: string) => VIEWABLE.has(mime);

export const ACCEPT_ATTRIBUTE = ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(",");
const ACCEPTED_LIST = "PDF, JPG, PNG, HEIC, XLSX, XLS, CSV, DOCX or ZIP";

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 || (i === 0 && name.length > 1) ? name.slice(i + 1).toLowerCase() : "";
}

export type FileFacts = { name: string; size: number; type: string };
export type ValidFile = { ext: AllowedExtension; mime: string; size: number; fileName: string };

/** AC-2. Messages never repeat the file name (it may carry a client's name). */
export function validateFile(f: FileFacts): { data: ValidFile | null; error: string | null } {
  const ext = extensionOf(f.name);
  if (!(ext in MIME_BY_EXTENSION)) return { data: null, error: `This file type isn't accepted. Use ${ACCEPTED_LIST}.` };
  const e = ext as AllowedExtension;
  const mime = MIME_BY_EXTENSION[e];
  const declared = (f.type ?? "").toLowerCase();
  if (declared && declared !== mime && !(ALSO_DECLARED[e] ?? []).includes(declared)) {
    return { data: null, error: `This file's type doesn't match its .${e} extension. Save it again as a real .${e} file.` };
  }
  if (!Number.isFinite(f.size) || f.size <= 0) return { data: null, error: "This file is empty." };
  if (f.size > MAX_FILE_BYTES) return { data: null, error: "This file is larger than 25 MB. Split it or reduce its size." };
  return { data: { ext: e, mime, size: f.size, fileName: sanitiseFileName(f.name, e) }, error: null };
}

const MAX_NAME = 180;

/**
 * Stored/download name (AC-2, DB checks document_version_file_name/_format): path separators, control and
 * format (bidi) characters
 * removed (tabs/newlines become spaces), spaces tidied, no leading dots, ≤ 180 characters keeping the extension.
 */
export function sanitiseFileName(name: string, fallbackExt = ""): string {
  const clean = (s: string) =>
    s.normalize("NFC").replace(/[\t\n\r\v\f]/g, " ").replace(/[/\\\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ");
  const all = clean(name ?? "");
  const i = all.lastIndexOf(".");
  let ext = i >= 0 ? all.slice(i + 1).trim() : "";
  let base = i >= 0 ? all.slice(0, i) : all;
  if (!ext || /\s/.test(ext) || ext.length > 10) { base = all; ext = ""; }
  ext = ext || fallbackExt;
  base = base.replace(/^[\s.]+/, "");
  if (!base.trim()) base = "document";
  const suffix = ext ? `.${ext}` : "";
  const room = MAX_NAME - suffix.length;
  if (base.length > room) base = Array.from(base).slice(0, room).join("").trimEnd();
  return `${base}${suffix}`.slice(0, MAX_NAME);
}

export const RECEIVED_AS = [
  { value: "soft_copy", label: "Soft copy" },
  { value: "hard_copy", label: "Hard copy" },
  { value: "original", label: "Original" },
] as const;
export type ReceivedAs = (typeof RECEIVED_AS)[number]["value"];

export const CHANNELS = [
  { value: "whatsapp", label: "WhatsApp" },
  { value: "email", label: "Email" },
  { value: "hand_delivery", label: "Hand delivery" },
  { value: "courier", label: "Courier" },
  { value: "portal", label: "Portal download" },
  { value: "other", label: "Other" },
] as const;
export type Channel = (typeof CHANNELS)[number]["value"];
/** Every channel a document can have. Staff choose from CHANNELS; "upload_link" is set only by client upload links (10). */
export const DOCUMENT_CHANNELS = [...CHANNELS, { value: "upload_link", label: "Upload link" }] as const;
export type DocumentChannel = (typeof DOCUMENT_CHANNELS)[number]["value"];
export const CHANNEL_LABELS: Readonly<Record<string, string>> = Object.fromEntries(DOCUMENT_CHANNELS.map((c) => [c.value, c.label]));
/** 10 (D3): a file a client sent by link opens only as a download until someone has reviewed it. */
export const viewBlockedForLink = (d: { channel: string; status: string }) => d.channel === "upload_link" && d.status !== "reviewed";

export type DocumentMetaInput = {
  receivedAs?: unknown; channel?: unknown; receivedOn?: unknown; remark?: unknown;
  clientId?: unknown; docTypeId?: unknown; periodId?: unknown; registrationId?: unknown;
};
export type ValidDocumentMeta = {
  receivedAs: ReceivedAs; channel: Channel; receivedOn: string; remark: string | null;
  clientId: string | null; docTypeId: string | null; periodId: string | null; registrationId: string | null;
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const isRealDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/**
 * AC-1/AC-4: the non-file fields of Add document / Assign / Edit. `target` = which button: Save to vault
 * needs client + type; Save to inbox saves whatever is filled. `today` = India date (YYYY-MM-DD).
 */
export function validateDocumentMeta(
  input: DocumentMetaInput,
  ctx: { target: "vault" | "inbox"; hasFile: boolean; today: string },
): { data: ValidDocumentMeta | null; errors: FieldIssue[] } {
  const errors: FieldIssue[] = [];

  const receivedAs = str(input.receivedAs) as ReceivedAs;
  if (!RECEIVED_AS.some((r) => r.value === receivedAs)) errors.push({ field: "receivedAs", message: "Choose how it was received." });
  else if (receivedAs === "soft_copy" && !ctx.hasFile) errors.push({ field: "file", message: "Add the file — a soft copy needs one." });

  const channel = str(input.channel) as Channel;
  if (!CHANNELS.some((c) => c.value === channel)) errors.push({ field: "channel", message: "Choose the channel." });

  const receivedOn = str(input.receivedOn) || ctx.today;
  if (!isRealDate(receivedOn)) errors.push({ field: "receivedOn", message: "Enter a valid date." });
  else if (receivedOn > ctx.today) errors.push({ field: "receivedOn", message: "Received on can't be in the future." });

  const remark = str(input.remark);
  if (remark.length > 500) errors.push({ field: "remark", message: "Remark is too long (500 characters max)." });

  const ids = {} as Record<"clientId" | "docTypeId" | "periodId" | "registrationId", string | null>;
  for (const k of ["clientId", "docTypeId", "periodId", "registrationId"] as const) {
    const v = str(input[k]);
    if (!v) ids[k] = null;
    else if (z.uuid().safeParse(v).success) ids[k] = v;
    else { ids[k] = null; errors.push({ field: k, message: "Choose again from the list." }); }
  }
  if (ctx.target === "vault") {
    if (!ids.clientId && !errors.some((e) => e.field === "clientId")) errors.push({ field: "clientId", message: "Choose a client, or save to inbox." });
    if (!ids.docTypeId && !errors.some((e) => e.field === "docTypeId")) errors.push({ field: "docTypeId", message: "Choose a document type, or save to inbox." });
  }

  if (errors.length) return { data: null, errors };
  return { data: { receivedAs, channel, receivedOn, remark: remark || null, ...ids }, errors };
}

// ── Feature 07: review & dispatch (mirrors review_document / undo_review / create_dispatch) ──────────────
export const MAX_REASON = 500;
export const MAX_RECIPIENT = 120;
export const MAX_COURIER = 100;
export const MAX_TRACKING = 60;

/** Needs correction / Undo reasons: 1–500 characters after trimming. */
export function validateReason(v: unknown): { data: string | null; error: string | null } {
  const r = str(v);
  if (!r) return { data: null, error: "Give a reason." };
  if (r.length > MAX_REASON) return { data: null, error: `Keep the reason to ${MAX_REASON} characters.` };
  return { data: r, error: null };
}

export type DispatchInput = {
  clientId?: unknown; documentIds?: unknown; dispatchedOn?: unknown; method?: unknown;
  courierName?: unknown; trackingNo?: unknown; recipientName?: unknown;
};
export type ValidDispatch = {
  clientId: string; documentIds: string[]; dispatchedOn: string; method: "courier" | "hand_delivery" | "client_collected" | "other";
  courierName: string | null; trackingNo: string | null; recipientName: string;
};
const DISPATCH_METHOD_VALUES = ["courier", "hand_delivery", "client_collected", "other"] as const;

/**
 * AC-8: the dispatch dialog. `today` = India date. `latestReceivedOn` = the newest received on among the ticked
 * originals (the date can't be before it). Courier details are kept only for Courier, as the database does.
 */
export function validateDispatch(input: DispatchInput, ctx: { today: string; latestReceivedOn?: string | null }): { data: ValidDispatch | null; errors: FieldIssue[] } {
  const errors: FieldIssue[] = [];
  const clientId = str(input.clientId);
  if (!z.uuid().safeParse(clientId).success) errors.push({ field: "clientId", message: "Choose the client again." });
  const ids = Array.isArray(input.documentIds) ? [...new Set(input.documentIds.map(str))] : [];
  if (!ids.length) errors.push({ field: "documentIds", message: "Tick at least one original." });
  else if (!ids.every((id) => z.uuid().safeParse(id).success)) errors.push({ field: "documentIds", message: "Refresh and tick the originals again." });
  const dispatchedOn = str(input.dispatchedOn);
  if (!isRealDate(dispatchedOn)) errors.push({ field: "dispatchedOn", message: "Enter the date dispatched." });
  else if (dispatchedOn > ctx.today) errors.push({ field: "dispatchedOn", message: "The dispatch date can't be in the future." });
  else if (ctx.latestReceivedOn && dispatchedOn < ctx.latestReceivedOn) errors.push({ field: "dispatchedOn", message: "The dispatch date can't be before a ticked original was received." });
  const method = str(input.method) as ValidDispatch["method"];
  if (!DISPATCH_METHOD_VALUES.includes(method)) errors.push({ field: "method", message: "Choose how it was dispatched." });
  const courier = method === "courier" ? str(input.courierName) : "";
  const tracking = method === "courier" ? str(input.trackingNo) : "";
  if (courier.length > MAX_COURIER) errors.push({ field: "courierName", message: `Keep the courier name to ${MAX_COURIER} characters.` });
  if (tracking.length > MAX_TRACKING) errors.push({ field: "trackingNo", message: `Keep the tracking number to ${MAX_TRACKING} characters.` });
  const recipientName = str(input.recipientName);
  if (!recipientName) errors.push({ field: "recipientName", message: "Enter who received it." });
  else if (recipientName.length > MAX_RECIPIENT) errors.push({ field: "recipientName", message: `Keep the name to ${MAX_RECIPIENT} characters.` });
  if (errors.length) return { data: null, errors };
  return { data: { clientId, documentIds: ids, dispatchedOn, method, courierName: courier || null, trackingNo: tracking || null, recipientName }, errors };
}
