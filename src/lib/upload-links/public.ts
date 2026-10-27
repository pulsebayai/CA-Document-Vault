import "server-only";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { createUploadTicket, type UploadTicket } from "@/lib/documents/storage-core";
import type { ValidFile } from "@/lib/validation/document";
import { TOKEN_PATTERN, hashToken } from "./token";

// Feature 10 — the server side of the public upload page (spec AC-6…AC-10; architecture "Client upload links").
// The ONLY module that calls link_open / link_ticket / link_register (service role; ESLint allow-list). The raw
// token arrives in a POST body, is hashed here and never logged; the IP is hashed with LINK_IP_SALT and never
// stored in clear. Errors are reduced to a code; nothing else about a token or a link leaves this module.

export type LinkItem = {
  id: string; kind: "scheduled" | "ad_hoc"; group: string; type: string; period?: string;
  state_code?: string; reg_kind?: "gstin" | "tan"; needed_by?: string; note?: string; received: boolean; files: number;
  /** 11 (spec AC-9, AC-12): formats this item prefers; absent when none apply. */
  preferred?: string[];
};
export type LinkPage =
  | { active: false }
  | { active: true; firm: string; requester: string; sent_on: string; open_until: string;
      files_count: number; max_files: number; bytes_total: number; max_bytes: number; items: LinkItem[] };

/** Codes the page may show a message for; anything else becomes "UPLOAD_FAILED". */
export const LINK_CODES = [
  "NOT_ACTIVE", "ITEM_NOT_ON_LINK", "FILE_TYPE_NOT_ALLOWED", "FILE_EMPTY", "FILE_TOO_LARGE", "CAP_REACHED",
  "RATE_LIMITED", "OBJECT_MISSING", "UPLOAD_FAILED",
] as const;
export type LinkCode = (typeof LINK_CODES)[number];

export class LinkError extends Error {
  constructor(public code: LinkCode) { super(code); }
}

function codeOf(message: string | undefined): LinkCode {
  const code = /^([A-Z_]+):/.exec(message ?? "")?.[1];
  return (LINK_CODES as readonly string[]).includes(code ?? "") ? (code as LinkCode) : "UPLOAD_FAILED";
}

function ipSalt(): string {
  const salt = process.env.LINK_IP_SALT;
  if (salt && salt.length >= 16) return salt;
  // Review N5: fail closed wherever real clients could arrive (prod, a Vercel production deploy, real email).
  if (process.env.APP_ENV === "production" || process.env.VERCEL_ENV === "production" || process.env.MAIL_TRANSPORT === "brevo") {
    throw new Error("LINK_IP_SALT is not set");
  }
  return "dev-only-link-ip-salt"; // dev, CI and previews only; staging and prod set their own (R1 env checklist)
}

/** SHA-256 of the client's IP with a server secret. The IP itself is never stored or logged. */
export async function ipHash(): Promise<string> {
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || "unknown";
  return createHash("sha256").update(`${ipSalt()}|${ip}`).digest("hex");
}

/** The token's hash, or null for anything that isn't a well-formed token (treated as "not active"). */
export function tokenHashOf(token: unknown): string | null {
  return typeof token === "string" && TOKEN_PATTERN.test(token) ? hashToken(token) : null;
}

export async function openLink(token: unknown): Promise<LinkPage> {
  const hash = tokenHashOf(token);
  const ip = await ipHash();
  const { data, error } = await createAdminClient().rpc("link_open", { p_token_hash: hash ?? "x", p_ip_hash: ip });
  if (error) throw new LinkError(codeOf(error.message));
  return data as LinkPage;
}

export async function linkTicket(token: unknown, itemId: string, file: ValidFile): Promise<UploadTicket> {
  const hash = tokenHashOf(token);
  if (!hash) throw new LinkError("NOT_ACTIVE");
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("link_ticket", {
    p_token_hash: hash, p_item_id: itemId, p_file: { ext: file.ext, size: file.size }, p_ip_hash: await ipHash(),
  });
  if (error) throw new LinkError(codeOf(error.message));
  if ((data as { error?: string }).error) throw new LinkError("NOT_ACTIVE"); // returned, not raised (AC-9 log kept)
  const t = data as { office_id: string; document_id: string };
  return createUploadTicket(admin, t.office_id, t.document_id, file);
}

export async function linkRegister(
  token: unknown, itemId: string, upload: { path: string; fileName: string; warned?: boolean },
): Promise<{ docCode: string }> {
  const hash = tokenHashOf(token);
  if (!hash) throw new LinkError("NOT_ACTIVE");
  // No storage call before the database has checked the token (review N2): link_register reads the object's size
  // and type from storage.objects itself, and forces the stored name's extension to the object's (review B1).
  const { data, error } = await createAdminClient().rpc("link_register", {
    p_token_hash: hash, p_item_id: itemId, p_ip_hash: await ipHash(),
    // 11 (spec AC-13): whether the page warned about the format — untrusted, kept for the metric only.
    p_file: { storage_path: upload.path, file_name: upload.fileName, warned: upload.warned === true },
  });
  if (error) throw new LinkError(codeOf(error.message));
  if ((data as { error?: string }).error) throw new LinkError("NOT_ACTIVE");
  return { docCode: String((data as { doc_code: string }).doc_code) };
}
