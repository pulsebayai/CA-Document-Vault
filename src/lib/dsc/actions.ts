"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";
import { istDate } from "@/lib/documents/period";
import {
  validateArchiveReason, validateCustody, validateDsc, validatePassword, validateRemindDays,
  type CustodyField, type DscField,
} from "@/lib/validation/dsc";
import { decryptSecret, encryptSecret } from "./crypto";
import { dscErrorMessage } from "./messages";

// Feature 14 — DSC server actions (spec AC-2 … AC-10, FR). Every action calls a dsc_* function as the signed-in user;
// the database re-checks role, client visibility and archive state and writes the activity row.
//
// The password: encrypted here (crypto.ts) before it leaves the server; decrypted here only after dsc_reveal has
// checked the role and client and logged the reveal (T5). The plain value is returned only in the reveal response
// body. It is never logged, never put in an error, never revalidated into a page. Errors are code + request ID only.

type Fail<F extends string = string> = { ok: false; error: string; fieldErrors?: Partial<Record<F, string>> };
const uuid = z.uuid();

function logFail(op: string, code: string | undefined) {
  console.error(`dsc.${op}_failed`, { code: code ?? "unknown", requestId: randomUUID() });
}
const refresh = (clientId: string) => {
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/today");
};
const KEY_DOWN = "Passwords can't be saved or shown right now. Ask your Admin to check the DSC key setting.";

/** Encrypts, or reports the key problem without its details (fails closed). */
function encrypt(plain: string): { ct: string } | { error: string } {
  try {
    return { ct: encryptSecret(plain) };
  } catch (e) {
    logFail("encrypt", (e as { code?: string }).code);
    return { error: KEY_DOWN };
  }
}

export type SaveDscInput = {
  id?: string; clientId: string; holderName: string; expiresOn: string; password?: string;
  dscClass?: string; issuer?: string; tokenNote?: string;
};

/** Add (password required) or edit / renew (no password: AC-4). */
export async function saveDsc(input: SaveDscInput): Promise<{ ok: true; id: string } | Fail<DscField>> {
  await requireStaff();
  const create = !input?.id;
  if (!create && !uuid.safeParse(input.id).success) return { ok: false, error: "DSC not found." };
  if (!uuid.safeParse(input?.clientId).success) return { ok: false, error: "Client not found." };
  const v = validateDsc(input as unknown as Record<string, unknown>, { create });
  if (!v.data) return { ok: false, error: "Check the highlighted fields.", fieldErrors: Object.fromEntries(v.errors.map((e) => [e.field, e.message])) };
  const d = v.data;
  const p: Record<string, unknown> = {
    holder_name: d.holderName, expires_on: d.expiresOn, dsc_class: d.dscClass, issuer: d.issuer, token_note: d.tokenNote,
  };
  if (create) {
    const e = encrypt(d.password!);
    if ("error" in e) return { ok: false, error: e.error };
    p.client_id = d.clientId;
    p.password_ct = e.ct;
  } else {
    p.id = input.id;
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("dsc_save", { p });
  if (error) {
    logFail("save", error.code);
    return { ok: false, error: dscErrorMessage(error.message) };
  }
  refresh(input.clientId);
  return { ok: true, id: data as string };
}

/** Change password (AC-4): typed twice, encrypted here, never pre-filled. */
export async function changeDscPassword(input: { id: string; clientId: string; password: string; confirm: string }): Promise<{ ok: true } | Fail> {
  await requireStaff();
  if (!uuid.safeParse(input?.id).success || !uuid.safeParse(input?.clientId).success) return { ok: false, error: "DSC not found." };
  const v = validatePassword(input.password, input.confirm);
  if (!v.value) return { ok: false, error: v.error!, fieldErrors: { password: v.error! } };
  const e = encrypt(v.value);
  if ("error" in e) return { ok: false, error: e.error };
  const supabase = await createClient();
  const { error } = await supabase.rpc("dsc_save", { p: { id: input.id, password_ct: e.ct } });
  if (error) {
    logFail("password", error.code);
    return { ok: false, error: dscErrorMessage(error.message) };
  }
  refresh(input.clientId);
  return { ok: true };
}

/**
 * Reveal (AC-7, T5): dsc_reveal checks role + client, logs, then returns the ciphertext; decrypted here and returned
 * in this response only. Server actions are POST responses, which browsers and Vercel never cache.
 */
export async function revealDscPassword(input: { id: string }): Promise<{ ok: true; password: string } | Fail> {
  const me = await requireStaff();
  if (me.role === "limited") return { ok: false, error: "Only Staff, Managers and Admins can see DSC passwords." };
  if (!uuid.safeParse(input?.id).success) return { ok: false, error: "DSC not found." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("dsc_reveal", { p_id: input.id });
  if (error) {
    logFail("reveal", error.code);
    return { ok: false, error: dscErrorMessage(error.message) };
  }
  try {
    return { ok: true, password: decryptSecret(data as string) };
  } catch (e) {
    logFail("decrypt", (e as { code?: string }).code);
    return { ok: false, error: KEY_DOWN };
  }
}

/** Given to / Received back from (AC-8). */
export async function logDscCustody(input: {
  dscId: string; clientId: string; direction: "out" | "in"; personName: string; onDate?: string; note?: string;
}): Promise<{ ok: true } | Fail<CustodyField>> {
  await requireStaff();
  if (!uuid.safeParse(input?.dscId).success || !uuid.safeParse(input?.clientId).success) return { ok: false, error: "DSC not found." };
  if (input.direction !== "out" && input.direction !== "in") return { ok: false, error: "Invalid request." };
  const v = validateCustody(input as unknown as Record<string, unknown>, istDate());
  if (!v.data) return { ok: false, error: "Check the highlighted fields.", fieldErrors: Object.fromEntries(v.errors.map((e) => [e.field, e.message])) };
  const supabase = await createClient();
  const { error } = await supabase.rpc("dsc_custody_log", { p: {
    dsc_id: input.dscId, direction: input.direction, person_name: v.data.personName, on_date: v.data.onDate, note: v.data.note,
  } });
  if (error) {
    logFail("custody", error.code);
    return { ok: false, error: dscErrorMessage(error.message) };
  }
  refresh(input.clientId);
  return { ok: true };
}

export async function archiveDsc(input: { id: string; clientId: string; reason: string }): Promise<{ ok: true } | Fail> {
  await requireStaff();
  if (!uuid.safeParse(input?.id).success || !uuid.safeParse(input?.clientId).success) return { ok: false, error: "DSC not found." };
  const v = validateArchiveReason(input.reason);
  if (!v.value) return { ok: false, error: v.error!, fieldErrors: { reason: v.error! } };
  const supabase = await createClient();
  const { error } = await supabase.rpc("dsc_archive", { p_id: input.id, p_reason: v.value });
  if (error) {
    logFail("archive", error.code);
    return { ok: false, error: dscErrorMessage(error.message) };
  }
  refresh(input.clientId);
  return { ok: true };
}

export async function unarchiveDsc(input: { id: string; clientId: string }): Promise<{ ok: true } | Fail> {
  await requireStaff();
  if (!uuid.safeParse(input?.id).success || !uuid.safeParse(input?.clientId).success) return { ok: false, error: "DSC not found." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("dsc_unarchive", { p_id: input.id });
  if (error) {
    logFail("unarchive", error.code);
    return { ok: false, error: dscErrorMessage(error.message) };
  }
  refresh(input.clientId);
  return { ok: true };
}

/** Client › Settings: remind N days before DSC expiry (AC-10). */
export async function setDscRemindDays(input: { clientId: string; days: string | number }): Promise<{ ok: true; days: number } | Fail> {
  await requireStaff();
  if (!uuid.safeParse(input?.clientId).success) return { ok: false, error: "Client not found." };
  const v = validateRemindDays(input.days);
  if (v.value === null) return { ok: false, error: v.error!, fieldErrors: { days: v.error! } };
  const supabase = await createClient();
  const { error } = await supabase.rpc("dsc_set_remind_days", { p_client_id: input.clientId, p_days: v.value });
  if (error) {
    logFail("remind_days", error.code);
    return { ok: false, error: dscErrorMessage(error.message) };
  }
  refresh(input.clientId);
  return { ok: true, days: v.value };
}
