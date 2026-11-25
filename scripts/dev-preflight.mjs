#!/usr/bin/env node
// Chore test-volume step 2 (2026-11-24): the read-only nightly dev smoke first checks that dev's service-role key
// still works and the database answers (expired key, paused or unreachable DB) — drift the full nightly used to
// catch. One read (`test_lane`, limit 1), no writes, dev only: a URL that isn't the dev project is refused before
// any call. Never prints the key.
//
// Usage in CI: NEXT_PUBLIC_SUPABASE_URL=<dev> SUPABASE_SECRET_KEY=<dev service role> node scripts/dev-preflight.mjs
import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";

/** dev - CA Document Vault (architecture.md › Environments & deploy). */
export const DEV_PROJECT_REF = "ysddbwskljzhbjjohool";
const TIMEOUT_MS = 20_000;

const scrub = (text, secret) => {
  let s = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (secret) s = s.split(secret).join("***");
  return s || "unknown error";
};

const isDevUrl = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === `${DEV_PROJECT_REF}.supabase.co`;
  } catch {
    return false;
  }
};

/** A fetch with a time limit, so a paused database fails the step instead of hanging it. */
const timedFetch = (input, init = {}) => fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS) });

const defaultClient = (url, key) =>
  createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch } });

/**
 * One service-role read of `test_lane` on dev. Never throws.
 * @param {{ env: Record<string, string | undefined>, makeClient?: (url: string, key: string) => any }} p
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function preflight({ env, makeClient = defaultClient }) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = env.SUPABASE_SECRET_KEY?.trim();
  const missing = [!url && "NEXT_PUBLIC_SUPABASE_URL", !key && "SUPABASE_SECRET_KEY"].filter(Boolean);
  if (missing.length) return { ok: false, message: `Dev preflight: missing ${missing.join(", ")}.` };
  if (!isDevUrl(url)) return { ok: false, message: "Dev preflight: NEXT_PUBLIC_SUPABASE_URL is not the dev project; refusing to call it." };
  try {
    const db = makeClient(url, key);
    const { data, error } = await db.from("test_lane").select("lane").limit(1);
    if (error) {
      return { ok: false, message: `Dev preflight: the read failed (${scrub(error.message, key)}${error.code ? `, code ${scrub(error.code, key)}` : ""}). Expired key or paused database?` };
    }
    if (!Array.isArray(data) || data.length === 0) {
      return { ok: false, message: "Dev preflight: test_lane returned no rows (is SUPABASE_SECRET_KEY dev's service-role key?)." };
    }
    return { ok: true, message: "Dev preflight: service-role key works and the database answers." };
  } catch (e) {
    return { ok: false, message: `Dev preflight: dev unreachable (${scrub(e instanceof Error ? e.message : e, key)}). Paused database or network?` };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { ok, message } = await preflight({ env: process.env });
  if (ok) console.log(message);
  else {
    console.error(`::error::${message}`);
    process.exit(1);
  }
}
