"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logActivity } from "@/lib/activity";
import { clearFailures, isLocked, recordFailure } from "./lockout";
import { normaliseEmail } from "./roles";

export type LoginState =
  | { step: "email"; error?: string }
  | { step: "code"; email: string; message: string; error?: string };

const NEUTRAL = "If this email has access, we've sent a 6-digit code. It expires in 1 hour.";
const LOCKED = "Too many wrong codes. Try again in 15 minutes.";
const emailSchema = z.email({ message: "Enter a valid email address." });
const codeSchema = z.string().regex(/^\d{6}$/, "Enter the 6-digit code from the email.");

/** Single entry point for the two-step form: intent = "send" | "verify". */
export async function loginStep(prev: LoginState, form: FormData): Promise<LoginState> {
  return form.get("intent") === "verify" ? verifyCode(prev, form) : requestCode(prev, form);
}

/** Step 1 — spec AC-1/AC-2. Same response whether or not the email belongs to staff. */
async function requestCode(_prev: LoginState, form: FormData): Promise<LoginState> {
  const parsed = emailSchema.safeParse(normaliseEmail(String(form.get("email") ?? "")));
  if (!parsed.success) return { step: "email", error: parsed.error.issues[0].message };
  const email = parsed.data;

  if (await isLocked(email)) return { step: "code", email, message: NEUTRAL, error: LOCKED };

  // Only send to staff who are not deactivated. Never create users here.
  const { data: staff } = await createAdminClient()
    .from("staff_user").select("status").eq("email", email).maybeSingle();
  if (staff && staff.status !== "deactivated") {
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    if (error) console.error("auth.otp_send_failed", { code: error.code, status: error.status });
  }
  return { step: "code", email, message: NEUTRAL };
}

/** Step 2 — verify the code, activate invited staff, audit, then enter the app. */
async function verifyCode(prev: LoginState, form: FormData): Promise<LoginState> {
  if (prev.step !== "code") return { step: "email" };
  const email = prev.email; // taken from server-returned state, not from the browser
  const parsed = codeSchema.safeParse(String(form.get("code") ?? "").replace(/\s/g, ""));
  if (!parsed.success) return { ...prev, error: parsed.error.issues[0].message };
  if (await isLocked(email)) return { ...prev, error: LOCKED };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({ email, token: parsed.data, type: "email" });
  if (error || !data.user) {
    const { locked } = await recordFailure(email);
    return { ...prev, error: locked ? LOCKED : "That code is wrong or has expired. Check the latest email or request a new code." };
  }
  await clearFailures(email);

  const admin = createAdminClient();
  const { data: staff } = await admin
    .from("staff_user").select("id, office_id, status").eq("id", data.user.id).maybeSingle();
  if (!staff || staff.status === "deactivated") {
    await supabase.auth.signOut();
    return { step: "email", error: "Your access has been removed. Contact your administrator." };
  }
  if (staff.status === "invited") {
    await admin.from("staff_user").update({ status: "active", activated_at: new Date().toISOString() }).eq("id", staff.id);
    await logActivity({ officeId: staff.office_id, actorId: staff.id, action: "staff.activated", entityType: "staff_user", entityId: staff.id });
  }
  await logActivity({ officeId: staff.office_id, actorId: staff.id, action: "auth.signed_in", entityType: "staff_user", entityId: staff.id });
  redirect("/clients");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
