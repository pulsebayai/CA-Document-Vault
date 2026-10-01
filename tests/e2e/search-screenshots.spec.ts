import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { groupId } from "../support/catalogue";
import { createDocumentOffice, mustCreateDocument, periodId, typeId, uploadObject } from "../support/documents";
import { testGstin, testPan } from "../support/test-data";
import { signIn } from "./helpers";

// Feature 03b step 8 — screenshots of the header search (mockup 01 header) and /documents (no mockup; agreed deviation
// in ui-reference.md) for the PR; axe at desktop and phone width; no sideways page scroll at 390 px.
// Screenshots land in test-results/screenshots/ (CI evidence artifact).

let admin: { id: string; email: string };
const SHOTS = "test-results/screenshots";
const TEXT_KEY = "cdv:documents-search-text";

test.beforeAll(async () => {
  test.setTimeout(90_000); // fixture set-up from a US runner to the Mumbai DB (see document-screenshots.spec.ts)
  const officeId = await createDocumentOffice("search-shots-ui");
  admin = await createStaff(officeId, "sshots-admin", "admin");
  const staff = await createStaff(officeId, "sshots-staff", "staff");
  const as = await signedInClient(admin.email);
  const asStaff = await signedInClient(staff.email);
  const pan = testPan("C", 8201);
  const { data, error } = await as.rpc("create_client", { p: {
    name: "Meenakshi Textiles Pvt Ltd", client_type: "private_ltd", pan, incharge_id: staff.id,
    registrations: [{ kind: "gstin", number: testGstin(pan) }],
    group_ids: await Promise.all(["GST", "Income Tax"].map((g) => groupId(officeId, g))),
  } });
  if (error) throw error;
  const file = async (name: string) => ({ storage_path: (await uploadObject(officeId, "pdf")).path, file_name: name });
  const t = async (n: string) => typeId(officeId, n);
  const p = async (c: string) => periodId(officeId, c);
  await mustCreateDocument(asStaff, { received_as: "soft_copy", channel: "email", client_id: data.id, received_on: "2026-09-12",
    doc_type_id: await t("Sales invoices / sales register"), period_id: await p("2026-08"), file: await file("Meenakshi-sales-Aug-2026.pdf") });
  await mustCreateDocument(asStaff, { received_as: "soft_copy", channel: "whatsapp", client_id: data.id, received_on: "2026-08-10",
    doc_type_id: await t("Purchase invoices / purchase register"), period_id: await p("2026-07"), file: await file("meenakshi purchases jul.pdf") });
  await mustCreateDocument(asStaff, { received_as: "original", channel: "hand_delivery", client_id: data.id, received_on: "2026-06-20",
    doc_type_id: await t("Form 16 from employer"), period_id: await p("2026-27"), remark: "Meenakshi — director's Form 16" });
  await mustCreateDocument(as, { received_as: "hard_copy", channel: "courier", remark: "Meenakshi courier, sender unclear" });
  await retireStaff([staff.id]);
});
test.afterAll(async () => { if (admin) await retireStaff([admin.id]); });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => `${v.id}: ${v.nodes[0]?.target}`);
}
async function shoot(page: Page, name: string) {
  expect(await seriousAxe(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}
const pageWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth);
const box = (page: Page) => page.getByRole("combobox", { name: "Search clients and documents" });
const results = (page: Page) => page.getByRole("list", { name: "Documents" }).getByRole("listitem");

test("header search and /documents, desktop and phone width; no serious/critical axe issues", async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await signIn(page, admin.email, baseURL);

  // Mockup 01 header — search with the dropdown open (Clients · Documents · See all)
  await box(page).fill("meenakshi");
  await expect(page.getByRole("group", { name: "Documents" }).getByRole("option")).toHaveCount(4);
  await expect(page.getByRole("group", { name: "Clients" }).getByRole("option")).toHaveCount(1);
  await shoot(page, "01-header-search");

  // /documents — results for the text, then with a filter chip
  await box(page).press("Enter");
  await page.waitForURL(/\/documents$/);
  await expect(results(page)).toHaveCount(4);
  await shoot(page, "documents-results");
  await page.getByRole("combobox", { name: "Channel" }).selectOption("email");
  await page.waitForURL(/channel=email/);
  await expect(results(page)).toHaveCount(1);
  await shoot(page, "documents-filtered");

  // Empty state
  await page.getByRole("searchbox", { name: "Search documents" }).fill("meenakshi nothing-matches-this");
  await expect(page.getByText("No documents match.")).toBeVisible();
  await shoot(page, "documents-empty");

  // Phone width: header search button → full-width field; /documents with the filter panel open.
  await page.evaluate((k) => window.sessionStorage.setItem(k, "meenakshi"), TEXT_KEY);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/documents");
  await expect(results(page)).toHaveCount(4);
  expect(await pageWidth(page)).toBeLessThanOrEqual(390);
  await shoot(page, "mobile-documents");
  await page.getByRole("button", { name: /^Filters/ }).click();
  await expect(page.getByRole("combobox", { name: "Channel" })).toBeVisible();
  expect(await pageWidth(page)).toBeLessThanOrEqual(390);
  await shoot(page, "mobile-documents-filters");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.keyboard.type("meenakshi");
  await expect(page.getByRole("group", { name: "Documents" }).getByRole("option")).toHaveCount(4);
  expect(await pageWidth(page)).toBeLessThanOrEqual(390);
  await shoot(page, "mobile-header-search");
});
