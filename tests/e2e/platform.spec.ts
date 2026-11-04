import AxeBuilder from "@axe-core/playwright";
import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { insertClient } from "../support/catalogue";
import { createDocumentOffice } from "../support/documents";
import { testPan, uniqueTestEmail } from "../support/test-data";
import { createPlatformAdmin } from "../support/platform";
import { appAlert, signIn, signInPlatform } from "./helpers";

// Feature 19 (spec AC-2, AC-3, AC-5, AC-7–AC-9, AC-13; plan step 8). A `.test` super admin (test firms only, plan D1)
// sets up a firm, opens read access to another, reads a client with its PII, and the firm's Admin sees it in Activity
// and the bell; then a suspension locks the firm's staff out until it is reactivated.

const marker = `XE${randomBytes(3).toString("hex")}`;
const clientName = `${marker} Client`;
const pan = testPan("P", 1931); // 4th letter P = individual (client_pan_fits_type)
let firm: string;
let admin: { id: string; email: string };
let staff: { id: string; email: string };
let sa: { id: string; email: string };

test.describe.configure({ mode: "serial" }); // the second test suspends the firm the first one read

test.beforeAll(async () => {
  firm = await createDocumentOffice("e2e-platform");
  admin = await createStaff(firm, "e2e-platform-admin", "admin");
  staff = await createStaff(firm, "e2e-platform-staff", "staff");
  const c = await insertClient(await signedInClient(admin.email), firm, { name: clientName, client_type: "individual", incharge_id: staff.id, pan });
  if (c.error) throw c.error;
  sa = await createPlatformAdmin("e2e-platform-sa");
});
test.afterAll(async () => {
  await adminClient().from("office").update({ suspended_at: null, suspended_by: null, suspend_reason: null }).eq("id", firm);
  await adminClient().from("platform_access").update({ closed_at: new Date().toISOString() }).eq("admin_id", sa?.id).is("closed_at", null);
  await retireStaff([admin?.id, staff?.id].filter(Boolean) as string[]);
});

const axeClean = async (page: Page) => {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
};

test("AC-2/3/5/8/9/13: sign in → firms → create a firm → open access → read a client → the firm sees it → close", async ({ page, browser, baseURL }) => {
  test.slow(); // two sign-ins and a firm bootstrap against the database
  // AC-2, AC-3: the email sign-in lands a super admin on /platform, with no firm header; a staff page sends them back
  await signInPlatform(page, sa.email, baseURL);
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  await page.goto("/today");
  await expect(page).toHaveURL(/\/platform$/);
  await axeClean(page);

  // AC-5: a new (test) firm with its first Admin invited
  await page.getByRole("link", { name: "+ New firm" }).click();
  const name = `e2e office platform ${marker}`;
  const firstAdmin = uniqueTestEmail("e2e-platform-first");
  await page.getByLabel("Firm name").fill(name);
  await page.getByLabel("Name", { exact: true }).fill("First Admin");
  await page.getByLabel("Work email").fill(firstAdmin);
  await page.getByRole("button", { name: "Create firm and send invite" }).click();
  await expect(page).toHaveURL(/\/platform\/firms\/[0-9a-f-]{36}\?created=1$/, { timeout: 60_000 });
  await expect(page.getByText("Firm created and the first Admin invited.")).toBeVisible();
  const created = page.url().match(/firms\/([0-9a-f-]{36})/)![1];
  await expect.poll(async () => (await adminClient().from("staff_user").select("role, status").eq("office_id", created).eq("email", firstAdmin).maybeSingle()).data)
    .toEqual({ role: "admin", status: "invited" });

  // AC-8: the read views stay shut until access is opened with a reason
  await page.goto(`/platform/firms/${firm}/clients`);
  await expect(page.getByText("Read access to this firm isn't open.")).toBeVisible();
  await page.goto(`/platform/firms/${firm}`);
  await page.getByLabel("Reason").first().fill(`Ticket ${marker}: client says a GST file is missing`);
  await page.getByRole("button", { name: "Open read access" }).click();
  await expect(page.getByText("Read-only support access")).toBeVisible();
  await expect(page.getByRole("status").getByText("Read access open for 60 minutes.")).toBeVisible();

  // AC-9: read-only, PII in full
  await page.getByRole("navigation", { name: "Firm" }).getByRole("link", { name: "Clients" }).click();
  const row = page.getByRole("row", { name: new RegExp(clientName) });
  await expect(row).toContainText(pan);
  await row.getByRole("link", { name: clientName }).click();
  await expect(page.getByText(pan)).toBeVisible();
  await expect(page.getByRole("button", { name: /edit|delete|archive|download/i })).toHaveCount(0);
  await axeClean(page);

  // AC-13: the firm's Admin sees it in Activity and in the bell
  const ctx = await browser.newContext();
  const firmPage = await ctx.newPage();
  await signIn(firmPage, admin.email, baseURL);
  await firmPage.goto("/activity");
  await expect(firmPage.getByText(`Pulsebay support viewed ${clientName}`)).toBeVisible();
  await expect(firmPage.getByText("Pulsebay support opened read-only access to the firm's data for 60 minutes")).toBeVisible();
  await expect(firmPage.getByText(marker.concat(":"))).toHaveCount(0); // the reason never reaches the firm
  // the "Support access" filter (decided 2026-11-04) shows them on their own
  await firmPage.getByRole("combobox", { name: "Action", exact: true }).selectOption({ label: "Action: Support access" });
  await expect(firmPage.getByText(`Pulsebay support viewed ${clientName}`)).toBeVisible();
  await firmPage.getByRole("button", { name: /^Notifications, \d+ unread$/ }).click();
  await expect(firmPage.getByRole("region", { name: "Notifications" }))
    .toContainText("Pulsebay support opened read-only access to your firm's data for 60 minutes.");
  await ctx.close();

  // close: the banner goes and the views shut again
  await page.getByRole("button", { name: "Close access" }).click();
  await expect(page.getByText("Read-only support access")).toHaveCount(0);
  await page.goto(`/platform/firms/${firm}/clients`);
  await expect(page.getByText("Read access to this firm isn't open.")).toBeVisible();
});

test("AC-7: suspending a firm locks its staff out at once; reactivating lets them back in", async ({ page, browser, baseURL }) => {
  test.slow();
  const ctx = await browser.newContext();
  const staffPage = await ctx.newPage();
  await signIn(staffPage, staff.email, baseURL);
  await expect(staffPage).toHaveURL(/\/clients$/);

  await signInPlatform(page, sa.email, baseURL);
  await page.goto(`/platform/firms/${firm}`);
  await page.getByLabel("Reason").nth(1).fill(`Unpaid since October ${marker}`);
  await page.getByRole("button", { name: "Suspend firm" }).click();
  await expect(page.getByRole("status").getByText(/Firm suspended/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Reactivate firm" })).toBeVisible();

  // the staff member's next request: signed out, with the paused notice (never the reason)
  await staffPage.reload();
  await expect(staffPage).toHaveURL(/\/login\?reason=paused$/);
  await expect(appAlert(staffPage)).toContainText("This firm's access is paused. Contact your firm's administrator.");
  await expect(staffPage.getByText(marker)).toHaveCount(0);
  await axeClean(staffPage);

  await page.getByRole("button", { name: "Reactivate firm" }).click();
  await expect(page.getByRole("status").getByText("Firm reactivated.")).toBeVisible();
  await signIn(staffPage, staff.email, baseURL, { fresh: true });
  await expect(staffPage).toHaveURL(/\/clients$/);
  await ctx.close();
});

test("AC-3: a staff member opening /platform gets Not Found and nothing of the console", async ({ page, baseURL }) => {
  await signIn(page, admin.email, baseURL);
  await page.goto("/platform");
  await expect(page.getByText(/could not be found/i)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Firms" })).toHaveCount(0);
  // every Platform page, not just the list: a firm page, a read view, the audit log
  for (const path of [`/platform/firms/${firm}`, `/platform/firms/${firm}/clients`, "/platform/firms/new", "/platform/audit"]) {
    await page.goto(path);
    await expect(page.getByText(/could not be found/i), path).toBeVisible();
    await expect(page.getByText(clientName), path).toHaveCount(0);
  }
});
