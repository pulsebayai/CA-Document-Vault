import { expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { adminClient } from "../support/db";
import { allowPreview } from "./preview-access";

/** The app's own alert (excludes Next.js's hidden route announcer, which also has role="alert"). */
export function appAlert(page: Page): Locator {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)');
}

/**
 * Session reuse (speed): after a user's first real sign-in in this worker, their Supabase session cookies are kept
 * and later signIn() calls for the same user restore them instead of repeating the emailed-link flow (~3–5 s each
 * against the Mumbai DB). If the restored session is no longer valid (signed out, deactivated, expired), it falls
 * back to the real flow. Tests about signing in itself pass { fresh: true }.
 */
const sessions = new Map<string, Awaited<ReturnType<BrowserContext["cookies"]>>>();
const AUTH_COOKIE = /^sb-/;

async function onClients(page: Page, timeout: number) {
  try {
    await page.waitForURL(/\/clients$/, { timeout });
    await page.getByRole("navigation", { name: "Main" }).waitFor({ timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Signs in the way staff do on dev today: the emailed sign-in link, opened in this browser.
 * The link comes from the admin API instead of an inbox (spec AC-1, link variant).
 */
export async function signIn(page: Page, email: string, baseURL: string | undefined, opts: { fresh?: boolean } = {}) {
  const base = baseURL ?? "http://localhost:3000";
  const key = `${base}|${email}`;
  const context = page.context();
  await allowPreview(context, baseURL); // contexts a test creates itself (browser.newContext)

  const saved = opts.fresh ? undefined : sessions.get(key);
  if (saved) {
    await context.clearCookies({ name: AUTH_COOKIE }); // keep other cookies (e.g. Vercel's preview bypass)
    await context.addCookies(saved);
    await page.goto(`${base}/clients`);
    if (await onClients(page, 10_000)) {
      await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
      return;
    }
    sessions.delete(key); // stale: fall through to a real sign-in
    await context.clearCookies({ name: AUTH_COOKIE });
  }

  const { data, error } = await adminClient().auth.admin.generateLink({
    type: "magiclink", email, options: { redirectTo: `${base}/auth/callback` },
  });
  if (error) throw new Error(`generateLink failed: ${error.message}`);
  await page.goto(data.properties.action_link);
  await Promise.race([
    page.waitForURL(/\/clients$/, { timeout: 30_000 }),
    appAlert(page).first().waitFor({ timeout: 30_000 }).then(async () => {
      throw new Error(`Sign-in failed for ${email}: ${await appAlert(page).first().innerText()}`);
    }),
  ]);
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  sessions.set(key, (await context.cookies()).filter((c) => AUTH_COOKIE.test(c.name)));
}
