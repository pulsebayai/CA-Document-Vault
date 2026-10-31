"use server";

import { setPlanTypeAnyFormat } from "@/lib/plan/actions";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { documentDbError } from "./db-messages";
import { requireStaff } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";
import {
  MIME_BY_EXTENSION, canView, extensionOf, sanitiseFileName, validateDocumentMeta, validateFile, validateHandedOver, viewBlockedForLink,
  type AllowedExtension, type DocumentMetaInput,
} from "@/lib/validation/document";
import { istDate } from "./period";
import { typesForClient, type ClientTypes, type TypeOption } from "./queries";
import { lookupVersion, type UploadTicket } from "./storage-core";
import { issueUploadTicket, signFileLink, verifyUpload } from "./storage";

// Spec 03 — upload, save, types and file links (plan steps 4–5).
const uuid = z.uuid();
const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** office/<office>/doc/<document>/<version>.<ext> of this office (and document, when given) — checked before any service-role call. */
const ownPath = (path: unknown, officeId: string, documentId = UUID_RE) =>
  typeof path === "string" && new RegExp(`^office/${officeId}/doc/${documentId}/${UUID_RE}\\.[a-z]+$`).test(path);

export type StartUploadResult = ({ ok: true } & UploadTicket) | { ok: false; error: string };

/**
 * Step 1 of the upload flow (spec "Functional requirements"): validate, then hand the browser a signed upload
 * URL for a fresh path. For a new version, the document must be visible to the user (RLS) and not archived.
 */
export async function startUpload(input: { name: string; size: number; type: string; documentId?: string | null }): Promise<StartUploadResult> {
  const me = await requireStaff();
  const v = validateFile({ name: String(input?.name ?? ""), size: Number(input?.size), type: String(input?.type ?? "") });
  if (!v.data) return { ok: false, error: v.error ?? "This file can't be added." };

  let documentId = randomUUID();
  if (input.documentId) {
    if (!z.uuid().safeParse(input.documentId).success) return { ok: false, error: "Document not found." };
    const supabase = await createClient();
    const { data: doc } = await supabase.from("document").select("id, archived_at").eq("id", input.documentId).maybeSingle();
    if (!doc) return { ok: false, error: "Document not found." };
    if (doc.archived_at) return { ok: false, error: "Unarchive the document before adding a new version." };
    documentId = doc.id;
  }
  try {
    return { ok: true, ...(await issueUploadTicket(me.officeId, documentId, v.data)) };
  } catch {
    return { ok: false, error: "Couldn't start the upload. Please try again." };
  }
}

export type FileLinkResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * AC-11/13: a ≤ 60 s link to the **current** file of a document the user can see (RLS lookup first).
 * View is offered for PDF and browser images only; Download uses the stored (sanitised) file name.
 */
export async function getFileLink(versionId: string, mode: "view" | "download"): Promise<FileLinkResult> {
  await requireStaff();
  if (!z.uuid().safeParse(versionId).success || (mode !== "view" && mode !== "download")) {
    return { ok: false, error: "File not found." };
  }
  const v = await lookupVersion(await createClient(), versionId);
  if (!v || !v.isCurrent) return { ok: false, error: "File not found." };
  if (mode === "view" && !canView(v.mimeType)) return { ok: false, error: "This file can't be shown in the browser. Download it instead." };
  if (mode === "view") {
    // 10 (D3): a file a client sent by link isn't opened in the browser until someone has reviewed it.
    const { data: doc } = await (await createClient()).from("document").select("channel, status").eq("id", v.documentId).maybeSingle();
    if (!doc || viewBlockedForLink(doc)) return { ok: false, error: "Sent by the client — review it before opening it in the browser, or download it." };
  }
  try {
    return { ok: true, url: await signFileLink(v.storagePath, v.fileName, mode) };
  } catch {
    return { ok: false, error: "Couldn't open the file. Please try again." };
  }
}

// ── Save (AC-1, AC-4) ────────────────────────────────────────────────────────
export type UploadedFile = { path: string; size: number; mime: string; fileName: string };
export type SaveDocumentInput = DocumentMetaInput & {
  target: "vault" | "inbox"; file?: UploadedFile | null;
  /** 10 (Client › Requested "Upload"): file it for this ad-hoc item — client and type come from the item. */
  requestItemId?: string | null;
};
export type SaveDocumentResult =
  | { ok: true; id: string; docCode: string }
  | { ok: false; error: string; fieldErrors: Record<string, string> };


/**
 * Step 3 of the upload flow: re-validate everything, confirm the uploaded object (size + type), then one
 * create_document call assigns the DOC-ID and writes document + version + activity atomically.
 */
export async function saveDocument(input: SaveDocumentInput): Promise<SaveDocumentResult> {
  const me = await requireStaff();
  const target = input?.target === "vault" ? "vault" : "inbox";
  const file = input?.file ?? null;
  const v = validateDocumentMeta(input ?? {}, { target, hasFile: !!file, today: istDate() });
  // 12 (AC-14, R2): every staff screen asks who handed a new hard copy in.
  // Legacy "original" input is a hard copy too (review N-2): it needs Handed over by like any new hard copy.
  const h = validateHandedOver({ receivedAs: input?.receivedAs === "original" ? "hard_copy" : input?.receivedAs, handedOverName: input?.handedOverName }, { existing: null });
  if (!v.data || !h.data) {
    return { ok: false, error: "Check the highlighted fields.", fieldErrors: Object.fromEntries([...v.errors, ...h.errors].map((e) => [e.field, e.message])) };
  }
  let filePayload: { storage_path: string; file_name: string } | null = null;
  if (file) {
    const ext = extensionOf(String(file.path ?? "")) as AllowedExtension;
    const mime = MIME_BY_EXTENSION[ext];
    const ours = ownPath(file.path, me.officeId);
    if (!ours || !mime || file.mime !== mime) return { ok: false, error: "The upload didn't finish. Please add the file again.", fieldErrors: { file: "Add the file again." } };
    const problem = await verifyUpload(file.path, { size: Number(file.size), mime });
    if (problem) return { ok: false, error: problem, fieldErrors: { file: problem } };
    filePayload = { storage_path: file.path, file_name: sanitiseFileName(String(file.fileName ?? ""), ext) };
  }
  const d = v.data;
  const supabase = await createClient();
  const p = {
    received_as: d.receivedAs, channel: d.channel, received_on: d.receivedOn, remark: d.remark,
    client_id: d.clientId, doc_type_id: d.docTypeId, period_id: d.periodId, registration_id: d.registrationId,
    file: filePayload,
    returnable: d.returnable, handed_over_name: h.data.handedOverName, // 12
  };
  const itemId = input?.requestItemId && uuid.safeParse(input.requestItemId).success ? input.requestItemId : null;
  const { data, error } = itemId
    ? await supabase.rpc("create_document_for_item", { p_item: itemId, p })  // 10: one transaction, item linked
    : await supabase.rpc("create_document", { p });
  if (error) {
    console.error("documents.save_failed", { code: error.code });
    return { ok: false, ...documentDbError(error.message) };
  }
  const saved = data as { id: string; doc_code: string };
  revalidatePath("/inbox");
  if (d.clientId) revalidatePath(`/clients/${d.clientId}`);
  return { ok: true, id: saved.id, docCode: saved.doc_code };
}

// ── Types for the chosen client (AC-3), suggestions and proposed types (AC-15) ──
export type TypesResult = ({ ok: true } & ClientTypes) | { ok: false; error: string };

export async function loadClientTypes(clientId: string | null): Promise<TypesResult> {
  await requireStaff();
  if (clientId && !uuid.safeParse(clientId).success) return { ok: false, error: "Client not found." };
  try {
    return { ok: true, ...(await typesForClient(clientId)) };
  } catch {
    return { ok: false, error: "Couldn't load document types. Please try again." };
  }
}

export type Suggestion = { id: string; name: string; groupName: string; inPlan: boolean; proposed: boolean };

/** POST, so what staff type never reaches a URL. */
export async function suggestTypes(clientId: string | null, query: string): Promise<Suggestion[]> {
  await requireStaff();
  const q = String(query ?? "").trim().slice(0, 120);
  if (q.length < 2 || (clientId && !uuid.safeParse(clientId).success)) return [];
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("suggest_doc_types", { p_client_id: clientId, p_query: q });
  if (error) return [];
  return ((data ?? []) as Array<{ doc_type_id: string; name: string; group_name: string; status: string; in_plan: boolean }>)
    .map((r) => ({ id: r.doc_type_id, name: r.name, groupName: r.group_name, inPlan: r.in_plan, proposed: r.status === "proposed" }));
}

export type ProposeResult = { ok: true; type: TypeOption } | { ok: false; error: string };

/** AC-15 (D5): Staff+ only; the type joins this client's plan at once. */
export async function proposeType(clientId: string, group: { id: string; name: string }, name: string): Promise<ProposeResult> {
  const me = await requireStaff();
  if (me.role === "limited") return { ok: false, error: "Staff and above can add new types. Save as untagged instead." };
  if (!uuid.safeParse(clientId).success || !uuid.safeParse(group?.id).success) return { ok: false, error: "Choose the client and group again." };
  const clean = String(name ?? "").replace(/\s+/g, " ").trim();
  if (clean.length < 1 || clean.length > 120) return { ok: false, error: "A type name has 1–120 characters." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_proposed_type", { p_client_id: clientId, p_doc_group_id: group.id, p_name: clean });
  if (error) {
    if (/DUPLICATE_TYPE/.test(error.message)) return { ok: false, error: "A type with this name already exists in this group. Pick it from the list." };
    // 05 (review I-4): a name merged for this client points to its target. The target's name follows the code (a
    // catalogue name, never personal data).
    const merged = /MERGED_INTO:\s*(.+)$/.exec(error.message);
    if (merged) return { ok: false, error: `“${clean}” was merged into ${merged[1].trim()}. Pick ${merged[1].trim()} from the list.` };
    console.error("documents.propose_failed", { code: error.code });
    return { ok: false, error: "Couldn't add the type. Please try again." };
  }
  revalidatePath(`/clients/${clientId}`);
  return { ok: true, type: {
    id: (data as { doc_type_id: string }).doc_type_id, name: clean, groupId: group.id, groupName: String(group.name ?? ""),
    periodKind: "none", frequency: "as_needed", registrationKind: null, proposed: true,
  } };
}

// ── Assign / edit (AC-8, AC-11): same fields, update_document; classified_at is set the first time ──
export type UpdateDocumentInput = DocumentMetaInput & { id: string; target: "vault" | "inbox" };

export async function updateDocumentAction(input: UpdateDocumentInput): Promise<SaveDocumentResult> {
  await requireStaff();
  if (!uuid.safeParse(input?.id).success) return { ok: false, error: "Document not found.", fieldErrors: {} };
  const supabase = await createClient();
  const { data: doc } = await supabase.from("document")
    .select("id, doc_code, version_count, client_id, channel, received_as, handed_over_name").eq("id", input.id).maybeSingle();
  if (!doc) return { ok: false, error: "Document not found.", fieldErrors: {} };
  const target = input.target === "vault" ? "vault" : "inbox";
  const v = validateDocumentMeta(input, { target, hasFile: doc.version_count > 0, today: istDate(), existingChannel: doc.channel });
  // 12 (AC-14): needed when it becomes a hard copy; once recorded it can be changed, not cleared; older hard copies
  // without it can be edited without it.
  const h = validateHandedOver({ receivedAs: input?.receivedAs === "original" ? "hard_copy" : input?.receivedAs, handedOverName: input?.handedOverName },
    { existing: { receivedAs: doc.received_as, handedOverName: doc.handed_over_name } });
  if (!v.data || !h.data) {
    return { ok: false, error: "Check the highlighted fields.", fieldErrors: Object.fromEntries([...v.errors, ...h.errors].map((e) => [e.field, e.message])) };
  }
  const d = v.data;
  const { error } = await supabase.rpc("update_document", { p_id: doc.id, p: {
    client_id: d.clientId, doc_type_id: d.docTypeId, period_id: d.periodId, registration_id: d.registrationId,
    received_as: d.receivedAs, channel: d.channel, received_on: d.receivedOn, remark: d.remark,
    returnable: d.returnable, handed_over_name: h.data.handedOverName, // 12
  } });
  if (error) {
    console.error("documents.update_failed", { code: error.code });
    return { ok: false, ...documentDbError(error.message) };
  }
  revalidatePath("/inbox");
  revalidatePath(`/documents/${doc.id}`);
  for (const c of new Set([doc.client_id, d.clientId].filter(Boolean))) revalidatePath(`/clients/${c}`);
  return { ok: true, id: doc.id, docCode: doc.doc_code };
}

// ── Document page (AC-11): new version, archive / unarchive ──────────────────
export type SimpleResult = { ok: true } | { ok: false; error: string };

/**
 * 07 AC-4: `receivedOn` = the corrected file's date, sent only for a Needs-correction document (the database
 * ignores it otherwise); it replaces received on, so metric 1 uses when the correct file arrived.
 */
export async function addVersionAction(documentId: string, file: UploadedFile, receivedOn?: string | null): Promise<SimpleResult> {
  const me = await requireStaff();
  if (!uuid.safeParse(documentId).success) return { ok: false, error: "Document not found." };
  const on = receivedOn ? String(receivedOn) : null;
  if (on && (!/^\d{4}-\d{2}-\d{2}$/.test(on) || Number.isNaN(Date.parse(`${on}T00:00:00Z`)) || new Date(`${on}T00:00:00Z`).toISOString().slice(0, 10) !== on)) {
    return { ok: false, error: "Enter a valid date." };
  }
  if (on && on > istDate()) return { ok: false, error: "Received on can't be in the future." };
  const ext = extensionOf(String(file?.path ?? "")) as AllowedExtension;
  const mime = MIME_BY_EXTENSION[ext];
  if (!mime || file.mime !== mime || !ownPath(file.path, me.officeId, documentId)) {
    return { ok: false, error: "The upload didn't finish. Please add the file again." };
  }
  const problem = await verifyUpload(file.path, { size: Number(file.size), mime });
  if (problem) return { ok: false, error: problem };
  const supabase = await createClient();
  const { error } = await supabase.rpc("add_document_version", { p_document_id: documentId, p_file: {
    storage_path: file.path, file_name: sanitiseFileName(String(file.fileName ?? ""), ext),
  }, ...(on ? { p_received_on: on } : {}) });
  if (error) {
    console.error("documents.version_failed", { code: error.code });
    return { ok: false, error: documentDbError(error.message).error };
  }
  revalidatePath(`/documents/${documentId}`);
  return { ok: true };
}

export async function archiveDocumentAction(id: string, reason: string): Promise<SimpleResult> {
  await requireStaff();
  if (!uuid.safeParse(id).success) return { ok: false, error: "Document not found." };
  const r = String(reason ?? "").trim();
  if (!r) return { ok: false, error: "Give a reason for archiving." };
  if (r.length > 300) return { ok: false, error: "Reason is too long (300 characters max)." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("archive_document", { p_id: id, p_reason: r });
  if (error) {
    if (/ROLE_REQUIRED/.test(error.message)) return { ok: false, error: "Only an Admin or Manager can archive documents." };
    return { ok: false, error: "Couldn't archive the document. Please try again." };
  }
  revalidatePath(`/documents/${id}`);
  revalidatePath("/inbox");
  return { ok: true };
}

export async function unarchiveDocumentAction(id: string): Promise<SimpleResult> {
  await requireStaff();
  if (!uuid.safeParse(id).success) return { ok: false, error: "Document not found." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("unarchive_document", { p_id: id });
  if (error) {
    if (/ROLE_REQUIRED/.test(error.message)) return { ok: false, error: "Only an Admin or Manager can unarchive documents." };
    return { ok: false, error: "Couldn't unarchive the document. Please try again." };
  }
  revalidatePath(`/documents/${id}`);
  return { ok: true };
}

/**
 * 11 (spec AC-19): "Allow any format for this client" from the Add document warning. The form imports only this
 * module (already server-action-only), so its unit tests keep mocking one module; the rule lives in plan/actions.
 */
export async function allowAnyFormat(planRowId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await setPlanTypeAnyFormat(planRowId, true);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}
