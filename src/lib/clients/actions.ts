"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { canManageCatalogue } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";
import { logActivity } from "@/lib/activity";
import { parseClientSearch } from "@/lib/validation/client-search";
import { validateClient } from "@/lib/validation/client";
import { searchClientsAs, type ClientSearchResult } from "./queries";
import { clientErrorMessage, clientInputFromForm } from "./form";
import { loadImportContext, rawRowsSchema } from "./import";
import {
  CHUNK_SIZE, MAX_ROWS, issuesText, validateImportRows, type ImportCounts, type ImportPayload, type PreviewRow, type RawRow,
} from "@/lib/csv/parse";

export type SearchResult = ({ ok: true } & ClientSearchResult) | { ok: false; error: string };

/**
 * Spec AC-7: search runs as a server action (POST), so search text and filters never appear in the URL,
 * browser history or access logs.
 */
export async function searchClients(input: {
  query?: string; clientType?: string | null; inchargeId?: string | null; includeArchived?: boolean; page?: number;
}): Promise<SearchResult> {
  await requireStaff();
  try {
    return { ok: true, ...(await searchClientsAs(parseClientSearch(input ?? {}))) };
  } catch {
    return { ok: false, error: "Could not load clients. Please try again." };
  }
}

// ── Add / edit (AC-8 … AC-10) ────────────────────────────────────────────────
export type ClientFormState = {
  error: string;
  fieldErrors: Record<string, string>;
  warnings: Record<string, string>;
  /** Warnings only (e.g. society PAN letter): the form offers "Save anyway". */
  needsConfirm?: boolean;
} | null;

/** Incharge and archive are Admin/Manager only (AC-10/11) — same people who manage the catalogue. */
const canManageClients = canManageCatalogue;
const uuid = z.uuid();

function prepare(fd: FormData) {
  const input = clientInputFromForm(fd);
  const v = validateClient(input);
  const fieldErrors = Object.fromEntries(v.errors.map((e) => [e.field.startsWith("registrations") ? "registrations" : e.field, e.message]));
  const warnings = Object.fromEntries(v.warnings.map((w) => [w.field, w.message]));
  return { input, v, fieldErrors, warnings, confirmed: fd.get("confirmWarnings") === "1" };
}

function payload(d: NonNullable<ReturnType<typeof validateClient>["data"]>) {
  return {
    name: d.name, client_type: d.clientType, pan: d.pan, previous_reference: d.previousReference, email: d.email,
    mobile: d.mobile, registrations: d.registrations.map((r) => ({ kind: r.kind, number: r.number })),
  };
}

export async function createClientAction(_prev: ClientFormState, fd: FormData): Promise<ClientFormState> {
  const me = await requireStaff();
  if (me.role === "limited") return { error: "You don't have permission to add clients.", fieldErrors: {}, warnings: {} };
  const { input, v, fieldErrors, warnings, confirmed } = prepare(fd);
  if (!v.data) return { error: "Please fix the highlighted fields.", fieldErrors, warnings };
  if (Object.keys(warnings).length && !confirmed) return { error: "Please check the warnings below.", fieldErrors: {}, warnings, needsConfirm: true };
  const groupIds = input.groupIds.filter((g) => uuid.safeParse(g).success);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_client", { p: { ...payload(v.data), incharge_id: v.data.inchargeId, group_ids: groupIds } });
  if (error || !data?.id) {
    const e = clientErrorMessage(error?.message);
    console.error("clients.create_failed", { code: error?.code });
    return { error: e.message, fieldErrors: e.field ? { [e.field]: e.message } : {}, warnings };
  }
  revalidatePath("/clients");
  // Lands on Settings (details card + plan): Documents became the default client tab in 04 (AC-14).
  redirect(`/clients/${data.id}?tab=settings`);
}

export async function updateClientAction(_prev: ClientFormState, fd: FormData): Promise<ClientFormState> {
  const me = await requireStaff();
  const id = String(fd.get("id") ?? "");
  if (me.role === "limited" || !uuid.safeParse(id).success) return { error: "You don't have permission to edit this client.", fieldErrors: {}, warnings: {} };
  const { v, fieldErrors, warnings, confirmed } = prepare(fd);
  if (!v.data) return { error: "Please fix the highlighted fields.", fieldErrors, warnings };
  if (Object.keys(warnings).length && !confirmed) return { error: "Please check the warnings below.", fieldErrors: {}, warnings, needsConfirm: true };

  const supabase = await createClient();
  // Staff can't change incharge (AC-10): don't even send it; the DB trigger rejects it anyway.
  const p = { ...payload(v.data), ...(canManageClients(me.role) ? { incharge_id: v.data.inchargeId } : {}) };
  const { error } = await supabase.rpc("update_client", { p_client_id: id, p });
  if (error) {
    const e = clientErrorMessage(error.message);
    console.error("clients.update_failed", { code: error.code });
    return { error: e.message, fieldErrors: e.field ? { [e.field]: e.message } : {}, warnings };
  }
  revalidatePath("/clients");
  revalidatePath(`/clients/${id}`);
  redirect(`/clients/${id}?tab=settings`); // back to the details just edited (04 AC-14 made Documents the default)
}

// ── Archive / unarchive (AC-11) ──────────────────────────────────────────────
export type ArchiveResult = { ok: true } | { ok: false; error: string };

export async function archiveClient(id: string, reason: string): Promise<ArchiveResult> {
  const me = await requireStaff();
  if (!canManageClients(me.role)) return { ok: false, error: "Only an Admin or Manager can archive clients." };
  if (!uuid.safeParse(id).success) return { ok: false, error: "Invalid request." };
  const r = (typeof reason === "string" ? reason.trim() : "").slice(0, 200) || null;
  const supabase = await createClient();
  const { data, error } = await supabase.from("client")
    .update({ archived_at: new Date().toISOString(), archive_reason: r }).eq("id", id).is("archived_at", null).select("id");
  if (error || !data?.length) {
    console.error("clients.archive_failed", { code: error?.code });
    return { ok: false, error: clientErrorMessage(error?.message ?? "NOT_FOUND").message };
  }
  // Reason stays on the client; activity holds field names and IDs only (AC-23).
  await logActivity({ officeId: me.officeId, actorId: me.id, action: "client.archived", entityType: "client", entityId: id, data: { reason_given: !!r } });
  revalidatePath("/clients");
  revalidatePath(`/clients/${id}`);
  return { ok: true };
}

export async function unarchiveClient(id: string): Promise<ArchiveResult> {
  const me = await requireStaff();
  if (!canManageClients(me.role)) return { ok: false, error: "Only an Admin or Manager can unarchive clients." };
  if (!uuid.safeParse(id).success) return { ok: false, error: "Invalid request." };
  const supabase = await createClient();
  const { data, error } = await supabase.from("client").update({ archived_at: null }).eq("id", id).not("archived_at", "is", null).select("id");
  if (error || !data?.length) {
    if (/client_pan_active_key/.test(error?.message ?? "")) {
      return { ok: false, error: "Can't unarchive: another active client now has the same PAN. Archive or correct that client first." };
    }
    console.error("clients.unarchive_failed", { code: error?.code });
    return { ok: false, error: clientErrorMessage(error?.message ?? "NOT_FOUND").message };
  }
  await logActivity({ officeId: me.officeId, actorId: me.id, action: "client.unarchived", entityType: "client", entityId: id });
  revalidatePath("/clients");
  revalidatePath(`/clients/${id}`);
  return { ok: true };
}

// ── CSV import (AC-14 … AC-16) ───────────────────────────────────────────────
// The browser parses the file (Papa Parse) and sends the rows. File content is never stored or logged.
export type PreviewResult = { ok: true; preview: PreviewRow[]; counts: ImportCounts } | { ok: false; error: string };

/** Validation only: nothing is written (AC-14). */
export async function previewImport(rows: RawRow[]): Promise<PreviewResult> {
  const me = await requireStaff();
  if (me.role === "limited") return { ok: false, error: "You don't have permission to import clients." };
  const parsed = rawRowsSchema(MAX_ROWS).safeParse(rows);
  if (!parsed.success) return { ok: false, error: "The file could not be read. Check it against the template and try again." };
  try {
    const supabase = await createClient();
    const { preview, counts } = validateImportRows(parsed.data, await loadImportContext(supabase));
    return { ok: true, preview, counts };
  } catch {
    return { ok: false, error: "Could not check the file against existing clients. Please try again." };
  }
}

export type ChunkResult =
  | { ok: true; created: { row: number; code: string }[]; skipped: { row: number; reason: string }[]; rejected: { row: number; reason: string }[] }
  | { ok: false; error: string };

/**
 * Imports one chunk (≤ 200 rows, file order). The server validates every row again against the database as it
 * is now — earlier chunks are already committed, so a PAN repeated across chunks is caught as a duplicate here.
 * The chunk goes to import_clients in one transaction; if the database refuses it (e.g. a clash created since
 * the preview), the chunk is retried row by row so good rows still import and the bad one gets a reason.
 */
export async function importClientsChunk(rows: RawRow[]): Promise<ChunkResult> {
  const me = await requireStaff();
  if (me.role === "limited") return { ok: false, error: "You don't have permission to import clients." };
  const parsed = rawRowsSchema(CHUNK_SIZE).safeParse(rows);
  if (!parsed.success) return { ok: false, error: "Invalid import request." };

  const supabase = await createClient();
  let v: ReturnType<typeof validateImportRows>;
  try {
    v = validateImportRows(parsed.data, await loadImportContext(supabase));
  } catch {
    return { ok: false, error: "Could not check the rows against existing clients. Please try again." };
  }
  const skipped = v.preview.filter((p) => p.status === "duplicate").map((p) => ({ row: p.row, reason: issuesText(p.issues) }));
  const rejected = v.preview.filter((p) => p.status === "error").map((p) => ({ row: p.row, reason: issuesText(p.issues) }));
  const created: { row: number; code: string }[] = [];

  const call = async (batch: { row: number; payload: ImportPayload }[]) => {
    const { data, error } = await supabase.rpc("import_clients", { p_rows: batch.map((b) => b.payload) });
    if (error) return { error };
    (data as { row: number; code: string }[]).forEach((r) => created.push({ row: batch[r.row - 1].row, code: r.code }));
    return { error: null };
  };

  if (v.ready.length) {
    const whole = await call(v.ready);
    if (whole.error) {
      console.error("clients.import_chunk_failed", { code: whole.error.code, rows: v.ready.length });
      if (/ROLE_REQUIRED|permission denied/.test(whole.error.message)) return { ok: false, error: "You don't have permission to import clients." };
      for (const one of v.ready) {
        const r = await call([one]);
        if (r.error) rejected.push({ row: one.row, reason: clientErrorMessage(r.error.message).message });
      }
    }
  }
  if (created.length) revalidatePath("/clients");
  const byRow = (a: { row: number }, b: { row: number }) => a.row - b.row;
  return { ok: true, created: created.sort(byRow), skipped, rejected: rejected.sort(byRow) };
}
