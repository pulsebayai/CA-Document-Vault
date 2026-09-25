import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import "../support/setup-env";
import { adminClient, createStaff, createTestOffice, retireStaff } from "../support/db";
import { testEmail } from "../support/test-data";
import { appAlert, signIn } from "./helpers";

let officeId: string;
let admin: { id: string; email: string };
let staff: { id: string; email: string };

test.beforeAll(async () => {
  officeId = await createTestOffice("e2e-auth");
  admin = await createStaff(officeId, "auth-admin", "admin");
  staff = await createStaff(officeId, "auth-staff", "staff");
});
test.afterAll(async () => { await retireStaff([staff?.id, admin?.id].filter(Boolean) as string[]); });

test("AC-14: signed-out users are sent to /login", async ({ page }) => {
  await page.goto("/clients");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("AC-2: unknown email gets the same neutral message and no user is created", async ({ page }) => {
  const email = testEmail("nobody");
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("status")).toContainText("If this email has access");
  const { data } = await adminClient().auth.admin.listUsers({ perPage: 1000 });
  expect(data.users.some((u) => u.email === email)).toBe(false);
});

test("AC-1 (link), AC-12, AC-13, AC-4: admin signs in, sees the shell and empty Clients, signs out", async ({ page }) => {
  await signIn(page, admin.email);
  await expect(page).toHaveURL(/\/clients$/);
  await expect(page.getByRole("heading", { name: "Clients" })).toBeVisible();
  await expect(page.getByText("No clients yet")).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Clients" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Settings" })).toBeVisible();
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);

  await page.getByLabel(/Account menu/).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/clients");
  await expect(page).toHaveURL(/\/login$/);
});

test("AC-3: wrong code shows an error; five wrong codes lock the email", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(staff.email);
  await page.getByRole("button", { name: "Send code" }).click();
  const verify = page.getByRole("button", { name: "Verify and sign in" });
  for (let i = 0; i < 5; i++) {
    await expect(verify).toBeEnabled(); // wait for the previous attempt (and form reset) to finish
    await page.getByLabel("6-digit code").fill("000000");
    await expect(page.getByLabel("6-digit code")).toHaveValue("000000");
    await verify.click();
    await expect(appAlert(page)).toContainText(/wrong|Too many/);
  }
  await expect(appAlert(page)).toContainText("Too many wrong codes");
});

test("login page is accessible", async ({ page }) => {
  await page.goto("/login");
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
});

test("AC-1 (link): the emailed sign-in link signs an invited user in and activates them", async ({ page, baseURL }) => {
  const invitee = await createStaff(officeId, "auth-invitee", "staff", "invited");
  const { data, error } = await adminClient().auth.admin.generateLink({
    type: "magiclink", email: invitee.email, options: { redirectTo: `${baseURL}/auth/callback` },
  });
  if (error) throw error;
  await page.goto(data.properties.action_link);
  await expect(page).toHaveURL(/\/clients$/);
  await expect.poll(async () => (await adminClient().from("staff_user").select("status").eq("id", invitee.id).single()).data?.status).toBe("active");
  await retireStaff([invitee.id]);
});

test("a used or foreign link shows a clear message", async ({ page }) => {
  await page.goto("/auth/callback?code=not-a-real-code");
  await expect(appAlert(page)).toContainText("opened in a different browser");
});
