import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import "../support/setup-env";
import { adminClient, createStaff, createTestOffice, retireStaff } from "../support/db";
import { signIn } from "./helpers";

let officeId: string;
let admin: { id: string; email: string };
let staff: { id: string; email: string };

test.beforeAll(async () => {
  officeId = await createTestOffice("e2e-users");
  admin = await createStaff(officeId, "users-admin", "admin");
  staff = await createStaff(officeId, "users-staff", "staff");
});
test.afterAll(async () => { await retireStaff([staff.id, admin.id]); });

test("AC-10: non-admins do not see Settings and get 404 on the URL", async ({ page }) => {
  await signIn(page, staff.email);
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" })).toHaveCount(0);
  const res = await page.goto("/settings/users");
  expect(res?.status()).toBe(404);
});

test("AC-7, AC-9, AC-11: admin changes a role; last admin controls are disabled; changes are logged", async ({ page }) => {
  await signIn(page, admin.email);
  await page.goto("/settings/users");
  await expect(page.getByRole("heading", { name: "Users and roles" })).toBeVisible();
  await expect(page.getByLabel(`Role for Test users-admin`)).toBeDisabled();
  await page.getByLabel("Role for Test users-staff").selectOption("manager");
  await expect.poll(async () => (await adminClient().from("staff_user").select("role").eq("id", staff.id).single()).data?.role).toBe("manager");
  const { data: log } = await adminClient().from("activity").select("action").eq("office_id", officeId).eq("entity_id", staff.id);
  expect(log?.map((l) => l.action)).toContain("staff.role_changed");
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
});

test("AC-8: a deactivated user is removed on their next request", async ({ browser }) => {
  const victim = await createStaff(officeId, "users-victim", "staff");
  const ctx = await browser.newContext();
  const victimPage = await ctx.newPage();
  await signIn(victimPage, victim.email);
  await expect(victimPage).toHaveURL(/\/clients$/);

  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await signIn(adminPage, admin.email);
  await adminPage.goto("/settings/users");
  adminPage.once("dialog", (d) => d.accept());
  await adminPage.getByRole("row", { name: /Test users-victim/ }).getByRole("button", { name: "Deactivate" }).click();
  await expect(adminPage.getByRole("row", { name: /Test users-victim/ })).toContainText("Deactivated");

  await victimPage.reload();
  await expect(victimPage).toHaveURL(/\/login\?reason=removed$/);
  await expect(victimPage.getByRole("alert")).toContainText("Your access has been removed");
  await ctx.close(); await adminCtx.close();
});

// AC-5/AC-6 (invite by email) needs an email provider that can deliver to real addresses.
// Supabase's built-in email on dev only delivers to project team members — see plan.md risks.
test.fixme("AC-5, AC-6: admin invites a person who then signs in and becomes Active", async () => {});
