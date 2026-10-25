import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ValidFile } from "@/lib/validation/document";

// Spec 03 AC-2, AC-13 (architecture change 1). Storage operations, parameterised by client so the DB test
// suite can exercise them; the app calls them only through ./storage.ts (server-only, service role) and only
// after an RLS-checked lookup as the signed-in user. Nothing here decides who may see what.

export const BUCKET = "documents";
/** AC-13: view/download links live at most 60 seconds. */
export const MAX_LINK_SECONDS = 60;

/** D2: office/<office_id>/doc/<document_id>/<version_id>.<ext> — IDs only, never names, PAN or GSTIN. */
export function objectPathFor(officeId: string, documentId: string, ext: string, versionId: string = randomUUID()) {
  return `office/${officeId}/doc/${documentId}/${versionId}.${ext}`;
}

/** `signedUrl` takes a raw PUT of the file with Content-Type = contentType (the browser does this with XHR for
 *  progress; a FormData upload would store the browser's declared type instead of ours). */
export type UploadTicket = { documentId: string; path: string; token: string; signedUrl: string; contentType: string; fileName: string };

/** Signed upload URL for one new object (no overwrite). The browser uploads straight to Storage with it. */
export async function createUploadTicket(
  admin: SupabaseClient, officeId: string, documentId: string, file: ValidFile,
): Promise<UploadTicket> {
  const path = objectPathFor(officeId, documentId, file.ext);
  const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new Error("UPLOAD_TICKET_FAILED");
  return { documentId, path: data.path, token: data.token, signedUrl: data.signedUrl, contentType: file.mime, fileName: file.fileName };
}

/**
 * Before saving: the object exists with the size and type the browser declared (a friendlier check than the
 * database's; the DB still reads size/type from Storage itself — D1). Returns a user message or null.
 */
export async function verifyStoredObject(
  admin: SupabaseClient, path: string, expected: { size: number; mime: string },
): Promise<string | null> {
  const { data, error } = await admin.storage.from(BUCKET).info(path);
  if (error || !data) return "The upload didn't finish. Please add the file again.";
  if (data.size !== expected.size || (data.contentType ?? "") !== expected.mime) {
    return "The uploaded file doesn't match the one you chose. Please add it again.";
  }
  return null;
}

/** Short-lived link to one stored file. `download` sets Content-Disposition to the stored (sanitised) name. */
export async function createFileLink(
  admin: SupabaseClient, path: string, fileName: string, mode: "view" | "download", seconds = MAX_LINK_SECONDS,
): Promise<string> {
  const ttl = Math.max(1, Math.min(seconds, MAX_LINK_SECONDS));
  const { data, error } = await admin.storage.from(BUCKET)
    .createSignedUrl(path, ttl, { download: mode === "download" ? fileName : false });
  if (error || !data) throw new Error("FILE_LINK_FAILED");
  return data.signedUrl;
}

export type VersionForLink = {
  id: string; documentId: string; storagePath: string; fileName: string; mimeType: string; isCurrent: boolean;
};

/**
 * AC-12/13: the authorisation step — runs as the signed-in user, so RLS decides. null = not visible (or absent).
 */
export async function lookupVersion(asUser: SupabaseClient, versionId: string): Promise<VersionForLink | null> {
  const { data } = await asUser.from("document_version")
    .select("id, document_id, storage_path, file_name, mime_type, document:document_id (current_version_id)")
    .eq("id", versionId)
    .maybeSingle();
  if (!data) return null;
  const doc = data.document as unknown as { current_version_id: string | null } | null;
  return {
    id: data.id, documentId: data.document_id, storagePath: data.storage_path, fileName: data.file_name,
    mimeType: data.mime_type, isCurrent: doc?.current_version_id === data.id,
  };
}

/**
 * 10 step 11: removes stored files no document version points at (uploads never registered), oldest first, in
 * batches of 100. The database lists them (orphan_objects, service role); Storage's API deletes them (SQL can't).
 * Returns how many were removed. A file younger than `olderThanHours` is never touched: tickets live 2 hours.
 */
export async function removeOrphanObjects(admin: SupabaseClient, olderThanHours = 24, limit = 500): Promise<number> {
  const { data, error } = await admin.rpc("orphan_objects", { p_older_than_hours: Math.max(olderThanHours, 24), p_limit: limit });
  if (error) throw new Error("ORPHAN_LIST_FAILED");
  const names = ((data ?? []) as Array<{ name: string }>).map((r) => r.name);
  let removed = 0;
  for (let i = 0; i < names.length; i += 100) {
    const { data: gone, error: e } = await admin.storage.from(BUCKET).remove(names.slice(i, i + 100));
    if (e) throw new Error("ORPHAN_REMOVE_FAILED");
    removed += gone?.length ?? 0;
  }
  return removed;
}
