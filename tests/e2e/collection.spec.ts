import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { groupId } from "../support/catalogue";
import { createDocumentOffice, mustCreateDocument, periodId, typeId } from "../support/documents";
import { T, generateAsOf } from "../support/expected";
import { signIn } from "./helpers";

// Feature 04 step 8 — Settings › Collection (spec AC-16): metric 1 for the last 30 days; Admin/Manager only.
// Own is_test office, reset every run. Test clock (D1): Banking enabled 2026-06-01 (start May), generated 2026-07-15.
//   Bank statement (+1/1 · +1/7): May overdue from 7 Jun · Jun overdue from 7 Jul. Window = 16 Jun – 15 Jul → the Jun items.
//   Client A: Jun received 3 Jul (on time); May missing.  Client B: May + Jun missing.
//   → due 2 · on time 1 · late 0 · missing 1 · 50% · overdue now 3 (A May, B May, B Jun).
let officeId: string;
const u = {} as Record<"admin" | "manager" | "staff" | "limited", { id: string; email: string }>;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  officeId = await createDocumentOffice("collection-ui");
  u.admin = await createStaff(officeId, "coll-admin", "admin");
  u.manager = await createStaff(officeId, "coll-manager", "manager");
  u.staff = await createStaff(officeId, "coll-staff", "staff");
  u.limited = await createStaff(officeId, "coll-limited", "limited");
  const asAdmin = await signedInClient(u.admin.email);
  const asStaff = await signedInClient(u.staff.email);
  await generateAsOf(asAdmin, "2026-06-01");
  const banking = await groupId(officeId, "Banking");
  const ids: string[] = [];
  for (const name of ["Collection A", "Collection B"]) {
    const { data, error } = await asStaff.rpc("create_client", { p: { name, client_type: "individual", incharge_id: u.staff.id, group_ids: [banking] } });
    if (error) throw error;
    ids.push(data.id);
  }
  await generateAsOf(asAdmin, "2026-07-15");
  await mustCreateDocument(asStaff, {
    client_id: ids[0], doc_type_id: await typeId(officeId, T.bank), period_id: await periodId(officeId, "2026-06"), received_on: "2026-07-03",
  });
});
test.afterAll(async () => { await retireStaff(Object.values(u).map((x) => x.id)); });
test.describe.configure({ mode: "serial" });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id);
}
const figure = (page: Page, label: string) =>
  page.getByRole("definition").filter({ has: page.locator(`xpath=preceding-sibling::dt[1][normalize-space()="${label}"]`) }).first();

test("AC-16: a Manager sees on-time %, counts, the per-group table, Overdue now and the definition; axe; 390 px", async ({ page, baseURL }) => {
  await signIn(page, u.manager.email, baseURL);
  await page.goto("/settings");
  await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Collection" }).click();
  await expect(page).toHaveURL(/\/settings\/collection$/);
  await expect(page.getByRole("heading", { name: "Collection" })).toBeVisible();
  await expect(page.getByText("Last 30 days (16 Jun – 15 Jul)")).toBeVisible();
  await expect(figure(page, "On time")).toHaveText("50%");
  await expect(figure(page, "Received on time")).toHaveText("1");
  await expect(figure(page, "Received late")).toHaveText("0");
  await expect(figure(page, "Still missing")).toHaveText("1");
  await expect(figure(page, "Overdue now")).toHaveText("3");
  const banking = page.getByRole("row", { name: /Banking/ });
  await expect(banking.getByRole("cell")).toHaveText(["2", "1", "0", "1", "50%"]);
  await expect(page.getByRole("note")).toContainText("On time = received before the overdue date");
  await expect(page.getByRole("note")).toContainText("Expected documents last generated:");
  await expect(page.getByRole("note")).not.toContainText("the daily job hasn't run");
  expect(await seriousAxe(page)).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("AC-16: an Admin sees it too", async ({ page, baseURL }) => {
  await signIn(page, u.admin.email, baseURL);
  await page.goto("/settings/collection");
  await expect(figure(page, "On time")).toHaveText("50%");
});

for (const who of ["staff", "limited"] as const) {
  test(`AC-16: ${who} gets no Collection item and Not Found on the URL`, async ({ page, baseURL }) => {
    await signIn(page, u[who].email, baseURL);
    await page.goto("/settings");
    await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Document catalogue" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Collection" })).toHaveCount(0);
    await page.goto("/settings/collection");
    await expect(page.getByText(/not found|could not be found/i).first()).toBeVisible();
    await expect(page.getByText("Received on time")).toHaveCount(0);
  });
}
