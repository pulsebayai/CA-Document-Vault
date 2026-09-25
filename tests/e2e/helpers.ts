import { expect, type Page } from "@playwright/test";
import { adminClient } from "../support/db";

/** Real UI sign-in; the 6-digit code comes from the admin API instead of an inbox. */
export async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("status")).toContainText("If this email has access");
  const { data, error } = await adminClient().auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw error;
  await page.getByLabel("6-digit code").fill(data.properties.email_otp);
  await page.getByRole("button", { name: "Verify and sign in" }).click();
}
