import { expect, test } from "@playwright/test";

test("app serves the Clients screen", async ({ page }) => {
  await page.goto("/clients");
  await expect(page.getByRole("heading", { name: "Clients" })).toBeVisible();
});
