import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "./db";
import { BUCKET, mustCreateDocument, type NewDocument } from "./documents";

// Feature 11 — preferred file formats (spec AC-1…AC-24). Shared by format-preferences / format-check / format-reads.
//
// Contract under test (plan: migration A + B):
//   doc_type.preferred_formats text[] | null         subset of FORMAT_CHOICES, distinct, non-empty; null unless approved
//   client_doc_type.any_format boolean (default false) Staff+ only (RLS on client_doc_type + column grant)
//   document.format_preferred text[] | null           snapshot of the preference that applied at filing
//   document.format_ok boolean | null                 current version's format ∈ snapshot; null when none applied
//   public.format_label(text[]) → text                 service role only (TS mirror: src/lib/validation/formats.ts)
//   public.format_of_path(text) → text | null          service role only; extension, jpeg → jpg
//   public.test_seed_preferred_formats(uuid) → int     service role only, is_test offices only (NOT_TEST_OFFICE)
//   format_metric(p_from date, p_to date) → FormatMetric (Admin/Manager; ROLE_REQUIRED otherwise)

export const FORMAT_CHOICES = ["pdf", "jpg", "png", "heic", "xlsx", "xls", "csv", "docx"] as const;
export const EXCEL = ["xlsx", "xls", "csv"];
export const PDF_OR_EXCEL = ["pdf", "xlsx", "xls", "csv"];

/** Seed names exactly as in 02's catalogue (20260927070427_seed_catalogue.sql). */
export const SEEDED: Record<string, string[]> = {
  "Bank statement": EXCEL,
  "Salary register / attendance": EXCEL,
  "Salary paid to employees (for TDS)": EXCEL,
  "Payments to vendors / contractors / rent / professionals": EXCEL,
  "Capital gains statement from broker / fund house": PDF_OR_EXCEL,
  "Loans & deposits outstanding at 31 Mar (lender list, amounts)": PDF_OR_EXCEL,
};

/**
 * Test offices start with no preferences (migration C: they are fixtures, so 10's tests see 10's behaviour).
 * 11's tests switch on the real office's seed explicitly. Returns how many types got a list.
 */
export async function seedPreferences(officeId: string): Promise<number> {
  const { data, error } = await adminClient().rpc("test_seed_preferred_formats", { p_office_id: officeId });
  if (error) throw new Error(error.message);
  return data as number;
}

const MIME: Record<string, string> = {
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
};

/** Uploads a tiny synthetic object with the canonical type for `ext` (stands in for the browser's signed upload). */
export async function uploadAs(officeId: string, ext: string, documentId: string = randomUUID()) {
  const path = `office/${officeId}/doc/${documentId}/${randomUUID()}.${ext}`;
  const bytes = Buffer.from(`synthetic ${ext} ${randomUUID()}\n`);
  const { error } = await adminClient().storage.from(BUCKET).upload(path, bytes, { contentType: MIME[ext], upsert: false });
  if (error) throw error;
  return { path, documentId, size: bytes.length };
}

/** A soft copy filed by `as` with a file of extension `ext`. */
export async function fileAs(as: SupabaseClient, officeId: string, ext: string, doc: NewDocument = {}) {
  const obj = await uploadAs(officeId, ext);
  const created = await mustCreateDocument(as, {
    channel: "email", ...doc, received_as: "soft_copy", file: { storage_path: obj.path, file_name: `statement.${ext}` },
  });
  return { ...created, path: obj.path };
}

/** Adds a version with a file of extension `ext`. */
export async function addVersionAs(as: SupabaseClient, officeId: string, documentId: string, ext: string) {
  const obj = await uploadAs(officeId, ext, documentId);
  const { error } = await as.rpc("add_document_version", { p_document_id: documentId, p_file: { storage_path: obj.path, file_name: `v2.${ext}` } });
  if (error) throw new Error(error.message);
}

export type FormatCheck = { format_preferred: string[] | null; format_ok: boolean | null };
export async function formatCheck(documentId: string): Promise<FormatCheck> {
  const { data, error } = await adminClient().from("document").select("format_preferred, format_ok").eq("id", documentId).single();
  if (error) throw error;
  return data as FormatCheck;
}

const sorted = (xs: string[] | null) => (xs ? [...xs].sort() : xs);
/** Expect the snapshot (order-free) and the ok flag. */
export function same(check: FormatCheck, preferred: string[] | null, ok: boolean | null) {
  return JSON.stringify([sorted(check.format_preferred), check.format_ok]) === JSON.stringify([sorted(preferred), ok]);
}

export async function setPreferred(officeId: string, typeName: string, formats: string[] | null) {
  const { error } = await adminClient().from("doc_type").update({ preferred_formats: formats }).eq("office_id", officeId).eq("name", typeName);
  if (error) throw new Error(error.message);
}

export async function preferredOf(officeId: string, typeName: string): Promise<string[] | null> {
  const { data, error } = await adminClient().from("doc_type").select("preferred_formats").eq("office_id", officeId).eq("name", typeName).single();
  if (error) throw error;
  return (data as { preferred_formats: string[] | null }).preferred_formats;
}
