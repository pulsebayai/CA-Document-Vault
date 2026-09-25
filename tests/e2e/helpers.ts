import { expect, type Locator, type Page } from "@playwright/test";
import { adminClient } from "../support/db";

/** The app's own alert (excludes Next.js's hidden route announcer, which also has role="alert"). */
export function appAlert(page: Page): Locator {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)');
}

/** Real UI sign-in; the 6-digit code comes from the admin API instead of an inbox. */
export async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("status")).toContainText("If this email has access");
  const { data, error } = await adminClient().auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw new Error(`generateLink failed: ${error.message}`);
  await page.getByLabel("6-digit code").fill(data.properties.email_otp);
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  // Either we land in the app, or the page shows why not (fail with that text).
  await Promise.race([
    page.waitForURL(/\/clients$/, { timeout: 20_000 }),
    appAlert(page).first().waitFor({ timeout: 20_000 }).then(async () => {
      throw new Error(`Sign-in failed for ${email}: ${await appAlert(page).first().innerText()}`);
    }),
  ]);
}
