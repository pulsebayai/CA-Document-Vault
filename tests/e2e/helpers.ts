import { expect, type Locator, type Page } from "@playwright/test";
import { adminClient } from "../support/db";
import { allowPreview } from "./preview-access";

/** The app's own alert (excludes Next.js's hidden route announcer, which also has role="alert"). */
export function appAlert(page: Page): Locator {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)');
}

/**
 * Signs in the way staff do on dev today: the emailed sign-in link, opened in this browser.
 * The link comes from the admin API instead of an inbox (spec AC-1, link variant).
 */
export async function signIn(page: Page, email: string, baseURL: string | undefined) {
  const { data, error } = await adminClient().auth.admin.generateLink({
    type: "magiclink", email, options: { redirectTo: `${baseURL ?? "http://localhost:3000"}/auth/callback` },
  });
  if (error) throw new Error(`generateLink failed: ${error.message}`);
  await allowPreview(page.context(), baseURL); // contexts a test creates itself (browser.newContext)
  await page.goto(data.properties.action_link);
  await Promise.race([
    page.waitForURL(/\/clients$/, { timeout: 30_000 }),
    appAlert(page).first().waitFor({ timeout: 30_000 }).then(async () => {
      throw new Error(`Sign-in failed for ${email}: ${await appAlert(page).first().innerText()}`);
    }),
  ]);
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}
