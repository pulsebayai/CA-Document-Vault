import type { SupabaseClient } from "@supabase/supabase-js";
import { lookupVersion } from "@/lib/documents/storage-core";

// Feature 08 AC-2 — what goes into a bulk zip, and the just-in-time links for it. Parameterised by client so the
// DB tests run it as each role; the app calls it only through ./actions.ts (signed-in user + storage.ts's signer).
// Everything here reads as the signed-in user, so RLS decides what is listed and what is signed.
//
// The browser asks for a manifest of the whole selection once (the cap needs the whole selection), then for links
// in batches of ≤ 10 just before it fetches them, so no link outlives its 60 s unused.

export const MAX_ZIP_FILES = 100;
export const MAX_ZIP_BYTES = 300 * 1024 * 1024;
export const MAX_LINKS_PER_CALL = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ZipEntry = {
  documentId: string; docCode: string; versionId: string; fileName: string; size: number; entryName: string;
};
export type ZipMissing = { documentId: string; reason: "not_found" | "no_file" };
export type ZipManifest =
  | { ok: true; entries: ZipEntry[]; missing: ZipMissing[]; totalBytes: number }
  | { ok: false; error: "TOO_MANY" | "TOO_LARGE" | "FAILED" };

/** Entry name inside the zip: "<DOC-ID> <stored file name>" (DOC-IDs are unique, so names never clash). */
export const zipEntryName = (docCode: string, fileName: string) => `${docCode} ${fileName}`;

/** The cap, as the browser and the server both check it. */
export function zipCapError(count: number, totalBytes: number): "TOO_MANY" | "TOO_LARGE" | null {
  if (count > MAX_ZIP_FILES) return "TOO_MANY";
  if (totalBytes > MAX_ZIP_BYTES) return "TOO_LARGE";
  return null;
}

export async function zipManifest(asUser: SupabaseClient, documentIds: string[]): Promise<ZipManifest> {
  const ids = [...new Set(documentIds)];
  if (ids.length > MAX_ZIP_FILES) return { ok: false, error: "TOO_MANY" };
  const valid = ids.filter((id) => UUID.test(id));

  const docs = new Map<string, { doc_code: string; current_version_id: string | null }>();
  const versions = new Map<string, { id: string; file_name: string; size_bytes: number }>();
  if (valid.length) {
    const { data, error } = await asUser.from("document").select("id, doc_code, current_version_id").in("id", valid);
    if (error) return { ok: false, error: "FAILED" };
    for (const d of data ?? []) docs.set(d.id as string, d as { doc_code: string; current_version_id: string | null });
    const current = [...docs.values()].map((d) => d.current_version_id).filter((v): v is string => !!v);
    if (current.length) {
      const { data: vs, error: e2 } = await asUser.from("document_version").select("id, file_name, size_bytes").in("id", current);
      if (e2) return { ok: false, error: "FAILED" };
      for (const v of vs ?? []) versions.set(v.id as string, v as { id: string; file_name: string; size_bytes: number });
    }
  }

  const entries: ZipEntry[] = [];
  const missing: ZipMissing[] = [];
  for (const id of ids) {
    const d = docs.get(id);
    if (!d) { missing.push({ documentId: id, reason: "not_found" }); continue; }
    const v = d.current_version_id ? versions.get(d.current_version_id) : undefined;
    if (!v) { missing.push({ documentId: id, reason: "no_file" }); continue; }
    entries.push({
      documentId: id, docCode: d.doc_code, versionId: v.id, fileName: v.file_name, size: Number(v.size_bytes),
      entryName: zipEntryName(d.doc_code, v.file_name),
    });
  }
  const totalBytes = entries.reduce((n, e) => n + e.size, 0);
  const cap = zipCapError(entries.length, totalBytes);
  if (cap) return { ok: false, error: cap };
  return { ok: true, entries, missing, totalBytes };
}

export type Signer = (storagePath: string, fileName: string) => Promise<string>;
export type SignedLink = { versionId: string; url: string | null };

/** ≤ 10 download links for current versions the user can see (RLS lookup first); null for any other ID. */
export async function signLinks(asUser: SupabaseClient, sign: Signer, versionIds: string[]): Promise<SignedLink[]> {
  if (versionIds.length > MAX_LINKS_PER_CALL) throw new Error("TOO_MANY");
  return Promise.all(versionIds.map(async (versionId) => {
    if (!UUID.test(versionId)) return { versionId, url: null };
    const v = await lookupVersion(asUser, versionId);
    if (!v || !v.isCurrent) return { versionId, url: null };
    return { versionId, url: await sign(v.storagePath, v.fileName) };
  }));
}
