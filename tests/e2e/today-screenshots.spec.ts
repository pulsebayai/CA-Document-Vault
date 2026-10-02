import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice } from "../support/documents";
import { bankOnlyClient, expectedItem, generateAsOf, mustRpc, T } from "../support/expected";
import { signIn } from "./helpers";

// Feature 06 step 10 — screenshots for the PR next to mockup 01 (Today) and 10 (Remind on expected rows), plus the
// Remind and Log call dialogs, the client's Reminders list and Settings › Collection's chasing load (no mockup);
// axe at desktop and phone width; no sideways page scroll at 390 px. Screenshots land in test-results/screenshots/.
//
// Test clock: Bank statement only, enabled 1 Aug 2026 (start Jul), generated 16 Sep 2026 (mockup 01's date):
//   Sankar Software — Jul + Aug overdue, reminded once · Meena Exports — overdue, reminders off ·
//   Sankar Fintech (overdue +1/20) — Jul overdue, Aug due Sat 19 Sep (this week).

const SHOTS = "test-results/screenshots";
let staff: { id: string; email: string };
let manager: { id: string; email: string };
let sankar: string;
const others: string[] = [];

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const officeId = await createDocumentOffice("today-screenshots-ui");
  const admin = await createStaff(officeId, "tshots-admin", "admin");
  manager = await createStaff(officeId, "tshots-manager", "manager");
  staff = await createStaff(officeId, "tshots-staff", "staff");
  others.push(admin.id);
  const asAdmin = await signedInClient(admin.email);
  const asStaff = await signedInClient(staff.email);
  await generateAsOf(asAdmin, "2026-08-01");
  sankar = await bankOnlyClient(asStaff, officeId, { name: "Sankar Software Pvt Ltd", incharge_id: staff.id, email: "sankar@example.test", mobile: "9876543220" });
  const meena = await bankOnlyClient(asStaff, officeId, { name: "Meena Exports", incharge_id: staff.id, email: "meena@example.test", mobile: "9876543221" });
  await bankOnlyClient(asStaff, officeId, { name: "Sankar Fintech Software Pvt Ltd", incharge_id: staff.id, email: null, mobile: "9876543222", overdue: { months: 1, day: 20 } });
  const meenaRow = (await asStaff.from("client_doc_type").select("id").eq("client_id", meena).eq("state", "active").single()).data!;
  const { error } = await asStaff.from("client_doc_type").update({ reminders: false }).eq("id", meenaRow.id);
  if (error) throw error;
  await generateAsOf(asAdmin, "2026-09-16");
  const jul = (await expectedItem(sankar, T.bank, "2026-07")).id;
  await mustRpc(asStaff, "record_follow_up", { p_client: sankar, p_items: [jul], p_channel: "phone", p_on: "2026-09-15", p_note: "Accountant on leave till Monday" });
});
test.afterAll(async () => { await retireStaff([staff.id, manager.id, ...others]); });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id);
}
async function shoot(page: Page, name: string) {
  expect(await seriousAxe(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}
const pageWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth);

test("06 screens vs mockups 01 / 10 + dialogs + Reminders list + chasing load, desktop and phone; no serious/critical axe issues", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await signIn(page, staff.email, baseURL);

  // Mockup 01 — Today
  await page.goto("/today");
  await expect(page.getByText(/Wednesday, 16 September 2026 · 3 clients need something/)).toBeVisible();
  await shoot(page, "01-today");

  // Remind dialog (AC-7) and Log call (AC-11) from a Today row
  const sankarCard = page.getByRole("list", { name: "Clients that need something" }).getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: "Sankar Software Pvt Ltd" }) }).first();
  await sankarCard.getByRole("button", { name: "Remind Sankar Software Pvt Ltd" }).first().click();
  await expect(page.getByRole("dialog", { name: "Remind Sankar Software Pvt Ltd" }).getByRole("region", { name: "Message preview" })).toContainText("Dear Sankar Software Pvt Ltd,");
  await shoot(page, "remind-dialog");
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await sankarCard.getByRole("button", { name: "Log call with Sankar Software Pvt Ltd" }).first().click();
  await expect(page.getByRole("dialog", { name: "Log a call with Sankar Software Pvt Ltd" })).toBeVisible();
  await shoot(page, "log-call-dialog");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

  // Mockup 10 — Client › Documents expected rows with Remind / Log call and history; Expected tab + Reminders list
  await page.goto(`/clients/${sankar}`);
  await expect(page.getByRole("list", { name: "Banking outstanding" })).toContainText("reminded once");
  await shoot(page, "10-client-documents-remind");
  await page.goto(`/clients/${sankar}?tab=expected`);
  await expect(page.getByRole("list", { name: "Reminders, newest first" })).toContainText("Accountant on leave till Monday");
  await shoot(page, "client-expected-reminders");

  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, name] of [["/today", "mobile-01-today"], [`/clients/${sankar}?tab=expected`, "mobile-client-expected-reminders"]] as const) {
    await page.goto(path);
    await expect(page.getByRole("main")).toBeVisible();
    expect(await pageWidth(page), path).toBeLessThanOrEqual(390);
    await shoot(page, name);
  }
  await page.goto("/today");
  await page.getByRole("button", { name: "Remind Sankar Software Pvt Ltd" }).first().click();
  await expect(page.getByRole("dialog", { name: "Remind Sankar Software Pvt Ltd" })).toBeVisible();
  expect(await pageWidth(page)).toBeLessThanOrEqual(390);
  await shoot(page, "mobile-remind-dialog");

  // Settings › Collection with chasing load (Manager)
  await page.setViewportSize({ width: 1280, height: 860 });
  await signIn(page, manager.email, baseURL);
  await page.goto("/settings/collection");
  await expect(page.getByRole("heading", { name: "Chasing load" })).toBeVisible();
  await shoot(page, "settings-collection-chasing");
});
