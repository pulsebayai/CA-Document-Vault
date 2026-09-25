"use client";
import { createBrowserClient } from "@supabase/ssr";

/** Browser client — used only to accept tokens from an invite link (URL fragment). */
export function createClient() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
}
