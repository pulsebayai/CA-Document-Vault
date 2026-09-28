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
  for (const f of folders ?? []) {
    const { data: files, error: e2 } = await store.list(`${root}/${f.name}`, { limit: 1000 });
    if (e2) throw e2;
    const paths = (files ?? []).map((x) => `${root}/${f.name}/${x.name}`);
    if (paths.length) {
      const { error: e3 } = await store.remove(paths);
      if (e3) throw e3;
    }
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
