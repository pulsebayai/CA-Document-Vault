import { expect, test } from "@playwright/test";

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
