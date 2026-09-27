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
  redirect(`/clients/${data.id}`);
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
  redirect(`/clients/${id}`);
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
