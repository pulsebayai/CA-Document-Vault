import { expect, test } from "./fixtures";

test("app is up and signed-out visitors see the sign-in page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("pages are served with a nonce-based Content-Security-Policy and no console CSP errors", async ({ page }) => {
  const cspErrors: string[] = [];
  page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) cspErrors.push(m.text()); });
  const res = await page.goto("/login");
  expect(res?.headers()["content-security-policy"]).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  await page.getByLabel("Work email").fill("nobody@example.test");
  await page.getByRole("button", { name: "Send code" }).click(); // proves hydration/JS works under CSP
  await expect(page.getByRole("status")).toContainText("If this email has access");
  expect(cspErrors).toEqual([]);
});

// Feature 10 (spec "Smoke-safe for prod"): the public upload page with no token is read-only — it shows only
// "no longer active" and is served private, unindexed and without a referrer.
test("the client upload page without a link shows 'no longer active' with private headers", async ({ page }) => {
  const res = await page.goto("/u");
  expect(res?.status()).toBe(200);
  const h = res?.headers() ?? {};
  expect(h["referrer-policy"]).toBe("no-referrer");
  expect(h["x-robots-tag"]).toMatch(/noindex/);
  expect(h["cache-control"]).toMatch(/no-store/);
  await expect(page).toHaveURL(/\/u$/);
  await expect(page.getByRole("heading", { name: "This link is no longer active" })).toBeVisible();
});

// Feature 10 step 11: the storage sweep refuses a call without the cron secret (prod-safe: nothing is changed).
test("the storage sweep route refuses a call without the cron secret", async ({ request }) => {
  const res = await request.get("/api/cron/storage-sweep", { maxRedirects: 0 });
  expect(res.status()).toBe(401);
  const wrong = await request.get("/api/cron/storage-sweep", { headers: { Authorization: "Bearer not-the-secret-123456" }, maxRedirects: 0 });
  expect(wrong.status()).toBe(401);
});
