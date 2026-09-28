import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";
import "../support/setup-env";
import { adminClient, createStaff, createTestOffice, retireStaff } from "../support/db";
import { uniqueTestEmail } from "../support/test-data";
import { appAlert, signIn } from "./helpers";

let officeId: string;
let admin: { id: string; email: string };
let staff: { id: string; email: string };

test.beforeAll(async () => {
  officeId = await createTestOffice("e2e-users");
  admin = await createStaff(officeId, "users-admin", "admin");
  staff = await createStaff(officeId, "users-staff", "staff");
});
test.afterAll(async () => { await retireStaff([staff?.id, admin?.id].filter(Boolean) as string[]); });

// Retargeted in 02 (decision D3, approved by Raja 2026-09-27): Settings is now visible to all staff for the
// read-only catalogue (02 AC-6), so the check moves from the Settings link to the Users and roles link.
test("AC-10: non-admins do not see Users and roles; the URL shows Not Found and no staff data", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto("/settings/catalogue");
  await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Users and roles" })).toHaveCount(0);
  await page.goto("/settings/users");
  // Streaming responses keep HTTP 200; what matters is that nothing admin-only renders.
  await expect(page.getByText(/could not be found/i)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Users and roles" })).toHaveCount(0);
  await expect(page.getByText(admin.email)).toHaveCount(0);
});

test("AC-7, AC-9, AC-11: admin changes a role; last admin controls are disabled; changes are logged", async ({ page, baseURL }) => {
  await signIn(page, admin.email, baseURL);
  await page.goto("/settings/users");
  await expect(page.getByRole("heading", { name: "Users and roles" })).toBeVisible();
  await expect(page.getByLabel(`Role for Test users-admin`)).toBeDisabled();
  await page.getByLabel("Role for Test users-staff").selectOption("manager");
  await expect.poll(async () => (await adminClient().from("staff_user").select("role").eq("id", staff.id).single()).data?.role).toBe("manager");
  // The audit row is written right after the update; wait for it rather than racing.
  await expect.poll(async () => {
    const { data: log } = await adminClient().from("activity").select("action").eq("office_id", officeId).eq("entity_id", staff.id);
    return log?.map((l) => l.action) ?? [];
  }).toContain("staff.role_changed");
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
});

test("AC-8: a deactivated user is removed on their next request", async ({ browser, baseURL }) => {
  const victim = await createStaff(officeId, "users-victim", "staff");
  const ctx = await browser.newContext();
  const victimPage = await ctx.newPage();
  await signIn(victimPage, victim.email, baseURL);
  await expect(victimPage).toHaveURL(/\/clients$/);

  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await signIn(adminPage, admin.email, baseURL);
  await adminPage.goto("/settings/users");
  adminPage.once("dialog", (d) => d.accept());
  await adminPage.getByRole("row", { name: /Test users-victim/ }).getByRole("button", { name: "Deactivate" }).click();
  await expect(adminPage.getByRole("row", { name: /Test users-victim/ })).toContainText("Deactivated");

  await victimPage.reload();
  await expect(victimPage).toHaveURL(/\/login\?reason=removed$/);
  await expect(appAlert(victimPage)).toContainText("Your access has been removed");
  await ctx.close(); await adminCtx.close();
});

test("AC-5, AC-6, AC-11: admin invites a person, who signs in and becomes Active", async ({ browser, baseURL }) => {
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await signIn(adminPage, admin.email, baseURL);
  await adminPage.goto("/settings/users");
  const email = uniqueTestEmail("invitee"); // a brand-new person each run (invites refuse existing accounts)
  await adminPage.getByRole("button", { name: "+ Invite a person" }).click();
  const dialog = adminPage.getByRole("dialog", { name: "Invite a person" });
  await dialog.getByLabel("Name").fill("Test users-invitee");
  await dialog.getByLabel("Work email").fill(email);
  await dialog.getByLabel("Role").selectOption("limited");
  await dialog.getByRole("button", { name: "Send invite" }).click();
  await expect(dialog.getByRole("status")).toContainText(`Invite sent to ${email}`);

  const { data: row } = await adminClient().from("staff_user").select("id, status, role, office_id").eq("email", email).single();
  expect(row).toMatchObject({ status: "invited", role: "limited", office_id: officeId });

  const inviteeCtx = await browser.newContext();
  const inviteePage = await inviteeCtx.newPage();
  await signIn(inviteePage, email, baseURL);
  await expect.poll(async () => (await adminClient().from("staff_user").select("status").eq("id", row!.id).single()).data?.status).toBe("active");
  const { data: log } = await adminClient().from("activity").select("action").eq("entity_id", row!.id);
  expect(log?.map((l) => l.action)).toEqual(expect.arrayContaining(["staff.invited", "staff.activated"]));
  await retireStaff([row!.id]);
  await adminCtx.close(); await inviteeCtx.close();
});
