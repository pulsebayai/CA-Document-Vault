import type { BrowserContext } from "@playwright/test";

/**
 * Vercel Deployment Protection puts previews behind vercel.com/login. When the regression run targets a
 * deployed preview, VERCEL_AUTOMATION_BYPASS_SECRET (Vercel › Deployment Protection › Protection Bypass for
 * Automation) is sent once, to the app's own origin only, and Vercel answers with a bypass cookie that the
 * browser context keeps. The secret never goes to other hosts (Supabase, wa.me), never into a URL, and is a
 * no-op for local runs (CI's own production build) or when the secret is not set.
 *
 * Every request to that origin also carries `x-vercel-skip-toolbar: 1`: Vercel injects its feedback toolbar
 * (vercel.live) into previews, and our CSP rightly blocks its inline styles and frame, which the smoke test
 * reports as CSP errors (run 36455393633). Humans browsing previews keep the toolbar.
 */
const primed = new WeakSet<BrowserContext>();

export async function allowPreview(context: BrowserContext, baseURL: string | undefined) {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!secret || !baseURL || primed.has(context)) return;
  const origin = new URL(baseURL);
  if (origin.protocol !== "https:") return; // local runs (http://localhost) are never protected
  await context.route((url) => url.origin === origin.origin, (route) =>
    route.continue({ headers: { ...route.request().headers(), "x-vercel-skip-toolbar": "1" } }));
  const res = await context.request.get(new URL("/login", origin).toString(), {
    headers: { "x-vercel-protection-bypass": secret, "x-vercel-set-bypass-cookie": "true" },
    maxRedirects: 0,
  });
  if (res.status() === 401 || res.status() === 403) {
    throw new Error(`Vercel preview protection refused the bypass secret (HTTP ${res.status()}). Check VERCEL_AUTOMATION_BYPASS_SECRET.`);
  }
  primed.add(context);
}
