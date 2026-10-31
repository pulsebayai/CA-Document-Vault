"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";
import { signFileLink } from "@/lib/documents/storage";
import { MAX_LINKS_PER_CALL, MAX_ZIP_FILES, signLinks, zipManifest, type SignedLink, type ZipEntry, type ZipMissing } from "./links-core";

// Feature 08 AC-2 … AC-4 — bulk actions on selected documents. Every call reads as the signed-in user (RLS), and
// the server re-checks every ID it is given. Document bytes never pass through here: the browser fetches each file
// from Storage with a ≤ 60 s link signed by storage.ts (the only signer). Errors are logged as a code + request ID.

const ids = (max: number) => z.array(z.uuid()).min(1).max(max);
const logFail = (op: string, code?: string) => console.error(`bulk.${op}_failed`, { code: code ?? "unknown", requestId: randomUUID() });

export type ManifestResult =
  | { ok: true; entries: ZipEntry[]; missing: ZipMissing[]; totalBytes: number }
  | { ok: false; error: string };

const CAP_MESSAGE = "Up to 100 files / 300 MB per zip; narrow the filter.";

/** The selection's current files (whole selection, so the 100-file / 300 MB cap is checked here too). */
export async function getZipManifest(documentIds: string[]): Promise<ManifestResult> {
  await requireStaff();
  const parsed = z.array(z.uuid()).max(MAX_ZIP_FILES).safeParse(documentIds);
  if (!parsed.success) return { ok: false, error: Array.isArray(documentIds) && documentIds.length > MAX_ZIP_FILES ? CAP_MESSAGE : "Invalid request." };
  const m = await zipManifest(await createClient(), parsed.data);
  if (m.ok) return m;
  if (m.error === "FAILED") { logFail("manifest"); return { ok: false, error: "Couldn't prepare the zip. Please try again." }; }
  return { ok: false, error: CAP_MESSAGE };
}

export type LinksResult = { ok: true; links: SignedLink[] } | { ok: false; error: string };

/** ≤ 10 download links, asked for just before the browser fetches them (each lives ≤ 60 s). */
export async function getFileLinks(versionIds: string[]): Promise<LinksResult> {
  await requireStaff();
  const parsed = ids(MAX_LINKS_PER_CALL).safeParse(versionIds);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const sign = async (path: string, name: string) => signFileLink(path, name, "download");
  try {
    // A failed signature for one file shouldn't sink the batch: that file is reported as failed.
    const safeSign = (path: string, name: string) => sign(path, name).catch(() => "");
    const links = await signLinks(await createClient(), safeSign, parsed.data);
    return { ok: true, links: links.map((l) => ({ ...l, url: l.url || null })) };
  } catch {
    logFail("links");
    return { ok: false, error: "Couldn't get the files. Please try again." };
  }
}

export type BulkReviewItem = {
  id: string; result: "reviewed" | "skipped";
  reason: null | "already_reviewed" | "needs_correction" | "in_inbox" | "archived" | "not_found";
};
export type BulkReviewResult = { ok: true; results: BulkReviewItem[] } | { ok: false; error: string };

/** One chunk (≤ 200) of Mark reviewed: 07's review per document, in its own sub-transaction (AC-3). */
export async function markReviewedBulk(documentIds: string[]): Promise<BulkReviewResult> {
  await requireStaff();
  const parsed = ids(200).safeParse(documentIds);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("review_documents", { p_ids: parsed.data });
  if (error) {
    logFail("review", error.code);
    return { ok: false, error: "Couldn't mark these documents reviewed. Please try again." };
  }
  revalidatePath("/documents");
  revalidatePath("/clients/[id]", "page");
  revalidatePath("/today");
  return { ok: true, results: (data ?? []) as BulkReviewItem[] };
}

export type BulkCustodyResult = { ok: true; done: string[]; skipped: Array<{ id: string; reason: string }> } | { ok: false; error: string };

/** 13 (spec AC-9): one chunk (≤ 200) of Mark in office / Ready to dispatch; each document done or skipped with a reason. */
export async function markCustodyBulk(documentIds: string[], step: "in_office" | "ready"): Promise<BulkCustodyResult> {
  await requireStaff();
  const parsed = ids(200).safeParse(documentIds);
  if (!parsed.success || (step !== "in_office" && step !== "ready")) return { ok: false, error: "Invalid request." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("set_custody", { p_ids: parsed.data, p_step: step });
  if (error) {
    logFail("custody", error.code);
    return { ok: false, error: "Couldn't update these documents. Please try again." };
  }
  revalidatePath("/documents");
  revalidatePath("/clients/[id]", "page");
  revalidatePath("/today");
  const r = data as { done: string[]; skipped: Array<{ id: string; reason: string }> };
  return { ok: true, done: r.done, skipped: r.skipped };
}
