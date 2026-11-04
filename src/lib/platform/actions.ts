"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "./guard";
import { inviteFirstAdmin, resendFirstAdminInvite } from "./invite";
import { normaliseEmail } from "@/lib/auth/roles";
import { viewClients, type ClientRow, type Page, type ViewResult } from "./queries";

// 19 (spec Y3–Y7): the Platform area's writes. Each runs as the signed-in user; the platform function checks the
// caller, the firm and its own rules, and logs before returning. Error codes are mapped to plain messages here.

export type PlatformResult = { ok: true; message: string } | { ok: false; error: string; fieldErrors?: Record<string, string> };

const id = z.uuid();
const reason = z.string().trim().min(10, "Give a reason of at least 10 characters.").max(500, "Keep the reason under 500 characters.");
const firmSchema = z.object({
  name: z.string().trim().min(1, "Enter the firm's name.").max(120, "Keep the name under 120 characters."),
  branch: z.string().trim().max(120, "Keep the branch under 120 characters.").transform((v) => v || null),
  adminName: z.string().trim().min(1, "Enter the first Admin's name.").max(120, "Keep the name under 120 characters."),
  adminEmail: z.email("Enter a valid email address.").transform(normaliseEmail),
});

function message(code: string | undefined): string {
  if (!code) return "Something went wrong. Please try again.";
  if (code.startsWith("REASON_INVALID")) return "Give a reason of 10–500 characters.";
  if (code.startsWith("ALREADY_SUSPENDED")) return "This firm is already suspended.";
  if (code.startsWith("NOT_SUSPENDED")) return "This firm isn't suspended.";
  if (code.startsWith("NAME_INVALID")) return "Enter the firm's name (1–120 characters).";
  if (code.startsWith("NOT_FOUND")) return "This firm wasn't found.";
  return "Something went wrong. Please try again.";
}

async function rpc(fn: string, args: Record<string, unknown>) {
  const supabase = await createClient();
  return supabase.rpc(fn, args);
}

/** Create a firm (17's bootstrap: catalogue, years, formats) and invite its first Admin (spec Y7, AC-5). */
export async function createFirm(_prev: PlatformResult | null, form: FormData): Promise<PlatformResult> {
  const me = await requirePlatformAdmin();
  const parsed = firmSchema.safeParse({
    name: form.get("name") ?? "", branch: form.get("branch") ?? "", adminName: form.get("adminName") ?? "", adminEmail: form.get("adminEmail") ?? "",
  });
  if (!parsed.success) {
    const fieldErrors = Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message]));
    return { ok: false, error: "Check the highlighted fields.", fieldErrors };
  }
  const f = parsed.data;
  if (me.test !== f.adminEmail.endsWith(".test")) {
    return { ok: false, error: "Check the highlighted fields.", fieldErrors: { adminEmail: me.test ? "A test super admin invites .test addresses only." : "Use a real address for a real firm." } };
  }
  const { data, error } = await rpc("platform_create_firm", { p: { name: f.name, ...(f.branch ? { branch: f.branch } : {}) } });
  if (error || !data) return { ok: false, error: message(error?.message) };
  const officeId = (data as { office_id: string }).office_id;
  const invited = await inviteFirstAdmin({ officeId, firmName: f.name, fullName: f.adminName, email: f.adminEmail });
  revalidatePath("/platform");
  // the firm exists either way; a failed invite is retried from the firm page
  redirect(`/platform/firms/${officeId}?${invited.ok ? "created=1" : "invite=failed"}`);
}

/** Invite the first Admin of a firm that has no staff yet (after a failed invite at creation). */
export async function inviteAdmin(officeId: string, firmName: string, _prev: PlatformResult | null, form: FormData): Promise<PlatformResult> {
  const me = await requirePlatformAdmin();
  if (!id.safeParse(officeId).success) return { ok: false, error: "Invalid request." };
  const parsed = firmSchema.pick({ adminName: true, adminEmail: true }).safeParse({ adminName: form.get("adminName") ?? "", adminEmail: form.get("adminEmail") ?? "" });
  if (!parsed.success) {
    return { ok: false, error: "Check the highlighted fields.", fieldErrors: Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])) };
  }
  if (me.test !== parsed.data.adminEmail.endsWith(".test")) {
    return { ok: false, error: me.test ? "A test super admin invites .test addresses only." : "Use a real address for a real firm." };
  }
  const r = await inviteFirstAdmin({ officeId, firmName, fullName: parsed.data.adminName, email: parsed.data.adminEmail });
  if (!r.ok) return r;
  revalidatePath(`/platform/firms/${officeId}`);
  return { ok: true, message: "Invite sent." };
}

export async function resendInvite(officeId: string, firmName: string): Promise<PlatformResult> {
  await requirePlatformAdmin();
  if (!id.safeParse(officeId).success) return { ok: false, error: "Invalid request." };
  const r = await resendFirstAdminInvite({ officeId, firmName });
  return r.ok ? { ok: true, message: "Invite sent again." } : r;
}

/** Suspend: the firm's staff are locked out at once, client links stop, the nightly job skips it (spec Y6, AC-7). */
export async function suspendFirm(officeId: string, _prev: PlatformResult | null, form: FormData): Promise<PlatformResult> {
  await requirePlatformAdmin();
  if (!id.safeParse(officeId).success) return { ok: false, error: "Invalid request." };
  const r = reason.safeParse(form.get("reason") ?? "");
  if (!r.success) return { ok: false, error: r.error.issues[0].message, fieldErrors: { reason: r.error.issues[0].message } };
  const { error } = await rpc("platform_suspend_firm", { p_office: officeId, p_reason: r.data });
  if (error) return { ok: false, error: message(error.message) };
  revalidatePath("/platform", "layout");
  return { ok: true, message: "Firm suspended. Its staff are signed out on their next request." };
}

export async function reactivateFirm(officeId: string): Promise<PlatformResult> {
  await requirePlatformAdmin();
  if (!id.safeParse(officeId).success) return { ok: false, error: "Invalid request." };
  const { error } = await rpc("platform_reactivate_firm", { p_office: officeId });
  if (error) return { ok: false, error: message(error.message) };
  revalidatePath("/platform", "layout");
  return { ok: true, message: "Firm reactivated." };
}

/** Open read-only support access to one firm for 60 minutes (spec Y4, AC-8). The firm's Admins see it. */
export async function openAccess(officeId: string, _prev: PlatformResult | null, form: FormData): Promise<PlatformResult> {
  await requirePlatformAdmin();
  if (!id.safeParse(officeId).success) return { ok: false, error: "Invalid request." };
  const r = reason.safeParse(form.get("reason") ?? "");
  if (!r.success) return { ok: false, error: r.error.issues[0].message, fieldErrors: { reason: r.error.issues[0].message } };
  const { error } = await rpc("platform_open_access", { p_office: officeId, p_reason: r.data });
  if (error) return { ok: false, error: message(error.message) };
  revalidatePath(`/platform/firms/${officeId}`, "layout");
  return { ok: true, message: "Read access open for 60 minutes." };
}

export async function closeAccess(officeId: string, accessId: string): Promise<PlatformResult> {
  await requirePlatformAdmin();
  if (!id.safeParse(officeId).success || !id.safeParse(accessId).success) return { ok: false, error: "Invalid request." };
  const { error } = await rpc("platform_close_access", { p_access: accessId });
  if (error) return { ok: false, error: message(error.message) };
  revalidatePath(`/platform/firms/${officeId}`, "layout");
  return { ok: true, message: "Read access closed." };
}

/**
 * Clients search for a read view (spec Y5). A server action (POST), so the typed text — often a client's name —
 * never reaches a URL (architecture: search text never in URLs). The database needs the open window and logs the view.
 */
export async function searchClients(officeId: string, query: string, page: number): Promise<ViewResult<Page<ClientRow>>> {
  await requirePlatformAdmin();
  if (!id.safeParse(officeId).success) return { ok: false, reason: "no_access" };
  const q = query.trim().slice(0, 100) || null;
  return viewClients(officeId, q, Math.max(1, Math.min(10_000, Math.trunc(page) || 1)));
}
