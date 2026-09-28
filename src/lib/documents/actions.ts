"use server";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";
import { canView, validateFile } from "@/lib/validation/document";
import { lookupVersion, type UploadTicket } from "./storage-core";
import { issueUploadTicket, signFileLink } from "./storage";

// Spec 03 — upload and file links (plan step 4). Saving documents arrives in step 5.

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
  try {
    return { ok: true, url: await signFileLink(v.storagePath, v.fileName, mode) };
  } catch {
    return { ok: false, error: "Couldn't open the file. Please try again." };
  }
}
