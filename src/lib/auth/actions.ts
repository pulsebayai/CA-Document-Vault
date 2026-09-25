"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { finishSignIn } from "./finish";
import { clearFailures, isLocked, recordFailure } from "./lockout";
import { normaliseEmail } from "./roles";

export type LoginState =
  | { step: "email"; error?: string }
  | { step: "code"; email: string; message: string; error?: string };

const NEUTRAL = "If this email has access, we've emailed a sign-in link. Open it in this browser. Or enter the sign-in code from the email below.";
const LOCKED = "Too many wrong codes. Try again in 15 minutes.";
const emailSchema = z.email({ message: "Enter a valid email address." });
// Supabase issues 6–8 digit codes depending on project settings; accept either.
const codeSchema = z.string().regex(/^\d{6,8}$/, "Enter the sign-in code from the email.");

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
  // Never spend the (small) email quota on reserved test domains (RFC 2606 ".test") — CI uses them.
  const isTestAddress = email.endsWith(".test");
  if (staff && staff.status !== "deactivated" && !isTestAddress) {
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: `${await appOrigin()}/auth/callback` },
    });
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
  if ((await finishSignIn(supabase, "code")) === "removed") {
    return { step: "email", error: "Your access has been removed. Contact your administrator." };
  }
  redirect("/clients");
}

/** Link sign-in (PKCE): exchange the one-time code from the email link for a session. */
export async function completeLinkSignIn(code: string): Promise<{ error: string }> {
  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return { error: LINK_FAILED };
  if ((await finishSignIn(supabase, "link")) === "removed") redirect("/login?reason=removed");
  redirect("/clients");
}

/** Invite link: the browser has stored the session from the URL fragment; finish on the server. */
export async function completeInviteSignIn(): Promise<{ error: string }> {
  const supabase = await createClient();
  const result = await finishSignIn(supabase, "invite");
  redirect(result === "removed" ? "/login?reason=removed" : "/clients");
}

const LINK_FAILED = "This sign-in link has expired, was already used, or was opened in a different browser. Request a new link on this device.";

/** Origin of the current request (used for email redirect links). Supabase also checks it against the allow-list. */
async function appOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
