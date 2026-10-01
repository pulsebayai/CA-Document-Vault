import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "./db";
import { createCatalogueOffice, resetTestOffice } from "./catalogue";

// Feature 03 fixtures. Storage objects live outside Postgres, so reset_test_office cannot remove them:
// the test office's objects are removed through the Storage API first, then the office is reset.

export const BUCKET = "documents";
export const MAX_BYTES = 25 * 1024 * 1024;

/** Canonical MIME types the bucket accepts (the server maps each extension to exactly one of these). */
export const ALLOWED_MIME = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/zip",
] as const;

// Tiny synthetic files — never real client documents.
export const TINY = {
  pdf: { bytes: Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"), mime: "application/pdf" },
  png: {
    bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
    mime: "image/png",
  },
  csv: { bytes: Buffer.from("date,amount\n2026-08-01,100\n"), mime: "text/csv" },
} as const;
export type TinyKind = keyof typeof TINY;

/** Get-or-create a test office, remove its storage objects, then reset its rows (catalogue re-seeded, counters at 0). */
export async function createDocumentOffice(label: string): Promise<string> {
  const officeId = await createCatalogueOffice(label, { reset: false });
  await purgeTestStorage(officeId);
  await resetTestOffice(officeId);
  return officeId;
}

/** Removes every object under office/<id>/ (test offices only — callers pass fixture offices). */
export async function purgeTestStorage(officeId: string) {
  const { data: office } = await adminClient().from("office").select("is_test").eq("id", officeId).single();
  if (!office?.is_test) throw new Error("purgeTestStorage: refusing an office that is not flagged is_test");
  const store = adminClient().storage.from(BUCKET);
  const root = `office/${officeId}/doc`;
  const { data: folders, error } = await store.list(root, { limit: 1000 });
  if (error) {
    if (/not found/i.test(error.message)) return; // bucket not created yet (before the 03 migration)
    throw error;
  }
  // Folders are listed in parallel and objects removed in bulk: a sequential list + remove per folder cost
  // ~40 round trips US→Mumbai for ~20 folders and pushed beforeAll past its 60 s limit (CI 36606177619).
  const names = (folders ?? []).map((f) => f.name);
  const paths: string[] = [];
  for (let i = 0; i < names.length; i += 10) {
    const lists = await Promise.all(names.slice(i, i + 10).map((n) => store.list(`${root}/${n}`, { limit: 1000 })));
    lists.forEach((r, k) => {
      if (r.error) throw r.error;
      for (const x of r.data ?? []) paths.push(`${root}/${names[i + k]}/${x.name}`);
    });
  }
  for (let i = 0; i < paths.length; i += 100) {
    const { error: e3 } = await store.remove(paths.slice(i, i + 100));
    if (e3) throw e3;
  }
}

/** The path shape the server issues: office/<office_id>/doc/<document_uuid>/<version_uuid>.<ext> — IDs only. */
export function objectPath(officeId: string, ext: string, documentId: string = randomUUID()) {
  return { path: `office/${officeId}/doc/${documentId}/${randomUUID()}.${ext}`, documentId };
}

/** Uploads a tiny synthetic object as the service role (stands in for the browser's signed upload). */
export async function uploadObject(officeId: string, kind: TinyKind = "pdf", documentId?: string) {
  const { path, documentId: docId } = objectPath(officeId, kind, documentId);
  const { bytes, mime } = TINY[kind];
  const { error } = await adminClient().storage.from(BUCKET).upload(path, bytes, { contentType: mime, upsert: false });
  if (error) throw error;
  return { path, documentId: docId, size: bytes.length, mime };
}

export type NewDocument = {
  client_id?: string | null;
  doc_type_id?: string | null;
  period_id?: string | null;
  registration_id?: string | null;
  received_as?: "soft_copy" | "hard_copy" | "original";
  channel?: "whatsapp" | "email" | "hand_delivery" | "courier" | "portal" | "other";
  received_on?: string;
  remark?: string | null;
  file?: { storage_path: string; file_name: string } | null;
  test_added_at?: string; // honoured only in is_test offices (fixed-date DOC-ID tests)
};

/** Calls create_document as `as` (RLS applies). Returns { data: { id, doc_code }, error }. */
export async function createDocument(as: SupabaseClient, doc: NewDocument) {
  const body = { received_as: "hard_copy", channel: "hand_delivery", ...doc };
  const res = await as.rpc("create_document", { p: body });
  return res as { data: { id: string; doc_code: string } | null; error: { message: string } | null };
}

export async function mustCreateDocument(as: SupabaseClient, doc: NewDocument) {
  const { data, error } = await createDocument(as, doc);
  if (error) throw new Error(error.message);
  return data!;
}

/** Soft copy with a freshly uploaded tiny file. */
export async function createSoftCopy(as: SupabaseClient, officeId: string, doc: NewDocument = {}, kind: TinyKind = "pdf") {
  const obj = await uploadObject(officeId, kind);
  const created = await mustCreateDocument(as, { ...doc, received_as: "soft_copy", file: { storage_path: obj.path, file_name: `statement.${kind}` } });
  return { ...created, object: obj };
}

export async function documentRow(id: string) {
  const { data, error } = await adminClient().from("document").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Record<string, unknown> & {
    id: string; doc_code: string; fy_code: string; client_id: string | null; doc_type_id: string | null;
    period_id: string | null; registration_id: string | null; received_as: string; classified_at: string | null;
    current_version_id: string | null; version_count: number; archived_at: string | null; received_by: string;
  };
}

export async function typeId(officeId: string, name: string): Promise<string> {
  const { data, error } = await adminClient().from("doc_type").select("id").eq("office_id", officeId).eq("name", name).single();
  if (error) throw error;
  return data.id as string;
}

export async function periodId(officeId: string, code: string): Promise<string> {
  const { data, error } = await adminClient().from("period").select("id").eq("office_id", officeId).eq("code", code).single();
  if (error) throw error;
  return data.id as string;
}

export async function activityFor(officeId: string, entityId: string) {
  const { data, error } = await adminClient().from("activity").select("action, actor_id, data")
    .eq("office_id", officeId).eq("entity_id", entityId).order("created_at");
  if (error) throw error;
  return data as Array<{ action: string; actor_id: string; data: Record<string, unknown> }>;
}

/** "DOC-FY26-27-00001" → { fy: "26-27", n: 1 } */
export function parseDocCode(code: string) {
  const m = /^DOC-FY(\d{2}-\d{2})-(\d{5,})$/.exec(code);
  if (!m) throw new Error(`not a DOC-ID: ${code}`);
  return { fy: m[1], n: Number(m[2]) };
}

/** "26-27": the Indian FY containing `now` (the FY of the date a document is added), as written in a DOC-ID. */
export function currentFyYY(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const y = ist.getUTCFullYear() - (ist.getUTCMonth() < 3 ? 1 : 0);
  const two = (n: number) => String(n % 100).padStart(2, "0");
  return `${two(y)}-${two(y + 1)}`;
}

// ── Feature 07: review & dispatch (additions only) ─────────────────────────────
// Contract under test (plan step 2 implements it):
//   review_document(p_id uuid, p_outcome text 'reviewed'|'needs_correction', p_reason text default null) → void
//   undo_review(p_id uuid, p_reason text) → void                                   (Admin/Manager)
//   add_document_version(p_document_id uuid, p_file jsonb, p_received_on date default null) → { version_id, version_no }
//       p_received_on replaces the document's received on only when it Needs correction (ignored otherwise).
//   create_dispatch(p jsonb { client_id, document_ids[], dispatched_on, method, courier_name?, tracking_no?,
//       recipient_name }) → { id }                                                 (one packet, all-or-nothing)
//   undo_dispatch_item(p_document_id uuid, p_reason text) → void                    (Admin/Manager)
//   tables document_review, dispatch, dispatch_item; document.reviewed_by / reviewed_at / correction_reason.
//   search_documents / search_document_facets: filter `return` ('ready' | 'dispatched'), facet "return".

export type ReviewOutcome = "reviewed" | "needs_correction";

export async function reviewDocument(as: SupabaseClient, id: string, outcome: ReviewOutcome = "reviewed", reason: string | null = null) {
  const { error } = await as.rpc("review_document", { p_id: id, p_outcome: outcome, p_reason: reason });
  return { error: error as { message: string } | null };
}

export async function mustReview(as: SupabaseClient, id: string, outcome: ReviewOutcome = "reviewed", reason: string | null = null) {
  const { error } = await reviewDocument(as, id, outcome, reason);
  if (error) throw new Error(error.message);
}

export async function undoReview(as: SupabaseClient, id: string, reason: string) {
  const { error } = await as.rpc("undo_review", { p_id: id, p_reason: reason });
  return { error: error as { message: string } | null };
}

/** An original (hard copy that must go back), optionally already reviewed by `reviewer`. */
export async function mustCreateOriginal(as: SupabaseClient, doc: NewDocument, reviewer?: SupabaseClient) {
  const created = await mustCreateDocument(as, { ...doc, received_as: "original" });
  if (reviewer) await mustReview(reviewer, created.id);
  return created;
}

export type NewDispatch = {
  client_id: string; document_ids: string[]; dispatched_on?: string; method?: "courier" | "hand_delivery" | "client_collected" | "other";
  courier_name?: string | null; tracking_no?: string | null; recipient_name?: string;
};

export async function createDispatch(as: SupabaseClient, p: NewDispatch) {
  const body = { method: "hand_delivery", recipient_name: "Test recipient", ...p };
  const res = await as.rpc("create_dispatch", { p: body });
  return res as { data: { id: string } | null; error: { message: string } | null };
}

export async function mustDispatch(as: SupabaseClient, p: NewDispatch) {
  const { data, error } = await createDispatch(as, p);
  if (error) throw new Error(error.message);
  return data!;
}

/** Review history of a document as the service role sees it, oldest first. */
export async function reviewHistory(documentId: string) {
  const { data, error } = await adminClient().from("document_review").select("*").eq("document_id", documentId).order("created_at").order("id");
  if (error) throw error;
  return data as Array<{ id: string; office_id: string; document_id: string; outcome: string; reason: string | null; actor_id: string | null; created_at: string }>;
}

/** The live (not removed) packet item of a document, or null. */
export async function liveDispatchItem(documentId: string) {
  const { data, error } = await adminClient().from("dispatch_item").select("*, dispatch:dispatch_id(*)")
    .eq("document_id", documentId).is("removed_at", null).maybeSingle();
  if (error) throw error;
  return data as null | { id: string; dispatch_id: string; document_id: string; removed_at: string | null;
    dispatch: { id: string; client_id: string; dispatched_on: string; method: string; courier_name: string | null;
      tracking_no: string | null; recipient_name: string; created_by: string } };
}
