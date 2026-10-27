"use server";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sanitiseFileName, validateFile } from "@/lib/validation/document";
import { LinkError, linkRegister, linkTicket, openLink, type LinkCode, type LinkPage } from "@/lib/upload-links/public";

// Feature 10 — public server actions for /u (no session). The token travels in the POST body only (it comes from
// the page's URL fragment, which browsers never send). Errors return a code; the server logs a code, never a token.

const uuid = z.uuid();
const LINK_EXTS = new Set(["pdf", "jpg", "jpeg", "png", "heic", "xlsx", "xls", "csv", "docx"]); // D3: no zip

export type OpenResult = { ok: true; page: LinkPage } | { ok: false; code: LinkCode };
export type StartResult =
  | { ok: true; signedUrl: string; path: string; contentType: string; fileName: string }
  | { ok: false; code: LinkCode; message?: string };
export type FinishResult = { ok: true } | { ok: false; code: LinkCode }; // no DOC-ID goes back to the client (AC-6)

function fail(where: string, e: unknown): LinkCode {
  const code = e instanceof LinkError ? e.code : "UPLOAD_FAILED";
  if (!(e instanceof LinkError)) console.error(`upload-link ${where}`, { error: e instanceof Error ? e.name : "error", requestId: randomUUID() });
  return code;
}

export async function openUploadLink(token: string): Promise<OpenResult> {
  try {
    return { ok: true, page: await openLink(token) };
  } catch (e) {
    return { ok: false, code: fail("open", e) };
  }
}

export async function startLinkUpload(token: string, itemId: string, file: { name: string; size: number; type: string }): Promise<StartResult> {
  if (!uuid.safeParse(itemId).success) return { ok: false, code: "ITEM_NOT_ON_LINK" };
  const v = validateFile({ name: String(file?.name ?? ""), size: Number(file?.size), type: String(file?.type ?? "") });
  if (!v.data) return { ok: false, code: "FILE_TYPE_NOT_ALLOWED", message: v.error ?? undefined };
  if (!LINK_EXTS.has(v.data.ext)) return { ok: false, code: "FILE_TYPE_NOT_ALLOWED" };
  try {
    const t = await linkTicket(token, itemId, v.data);
    return { ok: true, signedUrl: t.signedUrl, path: t.path, contentType: t.contentType, fileName: t.fileName };
  } catch (e) {
    return { ok: false, code: fail("ticket", e) };
  }
}

const PATH = /^office\/[0-9a-f-]{36}\/doc\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z]+$/;

export async function finishLinkUpload(
  token: string, itemId: string, upload: { path: string; fileName: string; size: number; contentType: string; warned?: boolean },
): Promise<FinishResult> {
  if (!uuid.safeParse(itemId).success || !PATH.test(String(upload?.path ?? ""))) return { ok: false, code: "UPLOAD_FAILED" };
  const ext = String(upload.path).slice(String(upload.path).lastIndexOf(".") + 1);
  try {
    // The browser's name is only a suggestion: cleaned here, and the database forces the object's extension (B1).
    await linkRegister(token, itemId, {
      path: upload.path, fileName: sanitiseFileName(String(upload?.fileName ?? ""), ext), warned: upload?.warned === true,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, code: fail("register", e) };
  }
}
