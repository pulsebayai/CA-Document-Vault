"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";
import { expectedErrorMessage } from "./shape";

// Feature 04 step 4 — Waive ("Not needed this period", AC-9), Undo (AC-10), Reopen (AC-11).
// Each action pre-checks the role for a clear message, then calls the SQL function as the signed-in user: the function
// re-checks role, status and reason, writes the activity row, and RLS limits it to clients the user can see.
// Errors are logged as a code + request ID only; the reason text is never logged.

export type ExpectedActionResult = { ok: true; message: string } | { ok: false; error: string };

const uuid = z.uuid();
const MAX_REASON = 500;

async function run(op: string, fn: string, args: Record<string, unknown>, clientId: unknown, ok: string): Promise<ExpectedActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc(fn, args);
  if (error) {
    console.error(`expected.${op}_failed`, { code: error.code ?? "unknown", requestId: randomUUID() });
    return { ok: false, error: expectedErrorMessage(error.message) };
  }
  if (typeof clientId === "string" && uuid.safeParse(clientId).success) revalidatePath(`/clients/${clientId}`);
  return { ok: true, message: ok };
}

export async function waiveExpected(input: { id: string; clientId?: string; reason: string }): Promise<ExpectedActionResult> {
  const me = await requireStaff();
  if (me.role === "limited") return { ok: false, error: expectedErrorMessage("ROLE_REQUIRED: Limited") };
  if (!uuid.safeParse(input?.id).success) return { ok: false, error: "Invalid request." };
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 1 || reason.length > MAX_REASON) return { ok: false, error: expectedErrorMessage("REASON_REQUIRED") };
  return run("waive", "waive_expected", { p_id: input.id, p_reason: reason }, input.clientId, "Marked not needed.");
}

export async function undoWaiveExpected(input: { id: string; clientId?: string }): Promise<ExpectedActionResult> {
  const me = await requireStaff();
  if (me.role !== "admin" && me.role !== "manager") return { ok: false, error: expectedErrorMessage("ROLE_REQUIRED: undo") };
  if (!uuid.safeParse(input?.id).success) return { ok: false, error: "Invalid request." };
  return run("undo_waive", "undo_waive_expected", { p_id: input.id }, input.clientId, "“Not needed” undone.");
}

export async function reopenExpected(input: { id: string; clientId?: string }): Promise<ExpectedActionResult> {
  await requireStaff();
  if (!uuid.safeParse(input?.id).success) return { ok: false, error: "Invalid request." };
  return run("reopen", "reopen_expected", { p_id: input.id }, input.clientId, "Reopened.");
}
