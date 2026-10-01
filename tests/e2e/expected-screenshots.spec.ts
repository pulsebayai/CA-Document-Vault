import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { groupId } from "../support/catalogue";
import { createDocumentOffice, mustCreateDocument, periodId, typeId, uploadObject } from "../support/documents";
import { T, generateAsOf } from "../support/expected";
import { testGstin, testPan } from "../support/test-data";
import { signIn } from "./helpers";

// Feature 04 step 10 — screenshots of 04's screens for the PR next to mockups 03 (Clients, overdue text) and
// 10 (Client › Documents with due/overdue rows), plus Client › Expected and Settings › Collection (no mockup);
// axe at desktop and phone width; no sideways page scroll at 390 px. Screenshots land in test-results/screenshots/.
//
// Test clock (D1): GST + Banking enabled 2026-08-01 (monthly start = Jul 2026), generated 2026-09-17 —
// so "Sales invoices · Aug 2026 · Not received · 13 days late" matches the mockup's example row.

const TODAY = "2026-09-17";
const SHOTS = "test-results/screenshots";
let officeId: string;
let manager: { id: string; email: string };
let clientId: string;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  officeId = await createDocumentOffice("exp-screenshots-ui");
  const admin = await createStaff(officeId, "eshots-admin", "admin");
  manager = await createStaff(officeId, "eshots-manager", "manager");
  const staff = await createStaff(officeId, "eshots-staff", "staff");
  const asAdmin = await signedInClient(admin.email);
  const asStaff = await signedInClient(staff.email);
  await generateAsOf(asAdmin, "2026-08-01");
  const groups = await Promise.all(["GST", "Banking"].map((g) => groupId(officeId, g)));
  const pan = testPan("C", 8201);
  const { data, error } = await asStaff.rpc("create_client", { p: {
    name: "Sankar Software Pvt Ltd", client_type: "private_ltd", pan, incharge_id: staff.id,
    registrations: [{ kind: "gstin", number: testGstin(pan) }], group_ids: groups,
  } });
  if (error) throw error;
  clientId = data.id;
  for (const name of ["Meena Textiles", "Ravi Kumar"]) {
    const r = await asStaff.rpc("create_client", { p: { name, client_type: "individual", incharge_id: staff.id, group_ids: [groups[1]] } });
    if (r.error) throw r.error;
  }
  await generateAsOf(asAdmin, TODAY);
  const file = async (name: string) => ({ storage_path: (await uploadObject(officeId, "pdf")).path, file_name: name });
  await mustCreateDocument(asStaff, { received_as: "soft_copy", channel: "email", client_id: clientId, received_on: "2026-08-03",
    doc_type_id: await typeId(officeId, T.sales), period_id: await periodId(officeId, "2026-07"), file: await file("Jul-2026-invoices.pdf") });
  await mustCreateDocument(asStaff, { received_as: "soft_copy", channel: "whatsapp", client_id: clientId, received_on: "2026-08-06",
    doc_type_id: await typeId(officeId, T.bank), period_id: await periodId(officeId, "2026-07"), file: await file("bank-jul.pdf") });
  await retireStaff([admin.id, staff.id]);
});
test.afterAll(async () => { if (manager) await retireStaff([manager.id]); });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => `${v.id}: ${v.nodes[0]?.target}`);
}
async function shoot(page: Page, name: string) {
  expect(await seriousAxe(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}
const pageWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth);

test("04 screens vs mockups 03 / 10 + Expected tab + Collection, desktop and phone width; no serious/critical axe issues", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await signIn(page, manager.email, baseURL);

  // Mockup 10 — Client › Documents with due/overdue rows (04 AC-14)
  await page.goto(`/clients/${clientId}`);
  await expect(page.getByRole("list", { name: "GST outstanding" }).getByRole("listitem").first()).toContainText("days late");
  await expect(page.getByRole("list", { name: "GST outstanding" })).toContainText(`${T.sales} · Aug 2026`);
  await shoot(page, "10-client-documents-expected");

  // Client › Expected (no mockup; AC-13)
  await page.goto(`/clients/${clientId}?tab=expected`);
  await expect(page.getByRole("list", { name: "GST expected documents" })).toBeVisible();
  await shoot(page, "client-expected");

  // Mockup 03 — Clients with "N overdue · N due today" (AC-15)
  await page.goto("/clients");
  await expect(page.getByRole("list", { name: "Clients" }).getByRole("listitem", { name: "Sankar Software Pvt Ltd" })).toContainText("overdue");
  await shoot(page, "03-clients-overdue");

  // Settings › Collection (no mockup; AC-16)
  await page.goto("/settings/collection");
  await expect(page.getByRole("heading", { name: "Collection" })).toBeVisible();
  await shoot(page, "settings-collection");

  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, name] of [
    [`/clients/${clientId}`, "mobile-10-client-documents-expected"], [`/clients/${clientId}?tab=expected`, "mobile-client-expected"],
    ["/clients", "mobile-03-clients-overdue"], ["/settings/collection", "mobile-settings-collection"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("main")).toBeVisible();
    expect(await pageWidth(page), path).toBeLessThanOrEqual(390);
    await shoot(page, name);
  }
});
