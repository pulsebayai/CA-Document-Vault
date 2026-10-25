import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ValidFile } from "@/lib/validation/document";
import * as core from "./storage-core";

// The only app module that signs Storage URLs (service role). Callers must first confirm, as the signed-in
// user (RLS), that the document may be seen or changed — see ./actions.ts.

export const issueUploadTicket = (officeId: string, documentId: string, file: ValidFile) =>
  core.createUploadTicket(createAdminClient(), officeId, documentId, file);

export const verifyUpload = (path: string, expected: { size: number; mime: string }) =>
  core.verifyStoredObject(createAdminClient(), path, expected);

export const signFileLink = (path: string, fileName: string, mode: "view" | "download") =>
  core.createFileLink(createAdminClient(), path, fileName, mode);

/** 10 step 11: the daily storage sweep (unregistered uploads older than 24 hours). Called only by the cron route. */
export const sweepOrphanObjects = () => core.removeOrphanObjects(createAdminClient());
