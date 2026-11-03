import { expect, test } from "./fixtures";
import "../support/setup-env";
import { createStaff, createTestOffice, retireStaff } from "../support/db";
import { testOfficeName } from "../support/test-data";
import { signIn } from "./helpers";

// Feature 17 — no cross-firm leak at the edges (spec AC-3, AC-12, AC-21, intent metric 1). Two test firms on one
// database; CI and the nightly run in multi mode (TENANCY_MODE unset). The From name per firm is proven in
// tests/unit/mailer.test.ts (the test transport's outbox lives in the server process, out of e2e's reach).

let firmA: string;
let staffA: { id: string; email: string };
let adminB: { id: string; email: string };

test.beforeAll(async () => {
  firmA = await createTestOffice("tenancy-edge-a");
  const firmB = await createTestOffice("tenancy-edge-b");
  staffA = await createStaff(firmA, "edge-a-staff", "staff");
  adminB = await createStaff(firmB, "edge-b-admin", "admin");
});
test.afterAll(async () => { await retireStaff([staffA?.id, adminB?.id].filter(Boolean) as string[]); });

test("AC-3: the login page shows the platform name and no firm's name", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByText("CA Document Vault", { exact: true })).toBeVisible();
  const body = await page.locator("body").innerText();
  for (const firm of [testOfficeName("tenancy-edge-a"), testOfficeName("tenancy-edge-b"), "Kushal Associates"]) {
    expect({ firm, shown: body.includes(firm) }).toEqual({ firm, shown: false });
  }
});

test("AC-12, AC-21: firm B's Admin inviting firm A's staff gets a neutral refusal that names neither firm nor account", async ({ page, baseURL }) => {
  await signIn(page, adminB.email, baseURL);
  await page.goto("/settings/users");
  await page.getByRole("button", { name: "+ Invite a person" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Someone From A");
  await dialog.getByLabel("Work email").fill(staffA.email);
  await dialog.getByRole("button", { name: "Send invite" }).click();
  const alert = dialog.getByRole("alert");
  await expect(alert).toHaveText("This email can't be invited. Use a different address.");
  await expect(alert).not.toContainText(testOfficeName("tenancy-edge-a"));
  await expect(alert).not.toContainText("account");
});
