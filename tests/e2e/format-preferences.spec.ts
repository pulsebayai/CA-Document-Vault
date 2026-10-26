import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, TINY } from "../support/documents";
import { T, bankOnlyClient } from "../support/expected";
import { signIn } from "./helpers";

// Feature 11 step 4–6 — preferred formats on the staff side (spec AC-1, AC-3, AC-5, AC-16, AC-19, AC-20, AC-21).
// Own is_test office, reset every run; test offices start with no preferences (migration C), so the Admin sets
// Bank statement's list in the catalogue first and the rest of the file builds on it (serial).

let officeId: string;
let admin: { id: string; email: string };
let staff: { id: string; email: string };
let clientId: string;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  officeId = await createDocumentOffice("formats-ui");
  admin = await createStaff(officeId, "fui-admin", "admin");
  staff = await createStaff(officeId, "fui-staff", "staff");
  clientId = await bankOnlyClient(await signedInClient(staff.email), officeId, { name: "Format Mills", incharge_id: staff.id });
});
test.afterAll(async () => { await retireStaff([staff?.id, admin?.id].filter(Boolean) as string[]); });
test.describe.configure({ mode: "serial" });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => `${v.id}: ${v.nodes.length}`);
}
const warning = (page: Page) => page.getByText(`${T.bank} is preferred as Excel or CSV for this client. You can still save this file.`);

async function addPdf(page: Page) {
  await page.goto(`/documents/new?client=${clientId}`);
  await expect(page.getByRole("button", { name: "Save to vault" })).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles({ name: "statement.pdf", mimeType: "application/pdf", buffer: TINY.pdf.bytes });
  await expect(page.getByText("Uploaded", { exact: true })).toBeVisible();
  await page.getByLabel("Document type").selectOption({ label: `${T.bank} · Banking` });
}

test("AC-1, AC-3: the Admin sets preferred formats on a type; the catalogue row shows them", async ({ page, baseURL }) => {
  await signIn(page, admin.email, baseURL);
  await page.goto("/settings/catalogue");
  const banking = page.getByRole("region", { name: "Banking", exact: true });
  await banking.getByRole("button", { name: `Edit ${T.bank}` }).click();
  const dialog = page.getByRole("dialog", { name: `Edit ${T.bank}` });
  const formats = dialog.getByRole("group", { name: /Preferred formats/ });
  await expect(formats).toContainText("Nothing is refused.");
  for (const f of ["XLSX", "XLS", "CSV"]) await formats.getByRole("checkbox", { name: f, exact: true }).check();
  expect(await seriousAxe(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(banking.getByRole("row", { name: new RegExp(`^${T.bank}`) })).toContainText("Excel or CSV preferred");
  const { data } = await adminClient().from("doc_type").select("preferred_formats").eq("office_id", officeId).eq("name", T.bank).single();
  expect([...(data!.preferred_formats as string[])].sort()).toEqual(["csv", "xls", "xlsx"]);
});

test("AC-19, AC-16: staff are warned about a PDF, save it anyway, and the document is flagged", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await addPdf(page);
  await expect(warning(page)).toBeVisible();
  expect(await seriousAxe(page)).toEqual([]);
  await page.getByRole("button", { name: "Save to vault" }).click(); // never blocked
  await page.waitForURL(new RegExp(`/clients/${clientId}\\?saved=`));
  const banking = page.getByRole("region", { name: "Banking", exact: true });
  await expect(banking.getByRole("listitem").filter({ hasText: "Not preferred format" })).toHaveCount(1);

  const { data: doc } = await adminClient().from("document").select("id, format_ok").eq("client_id", clientId)
    .order("created_at", { ascending: false }).limit(1).single();
  expect(doc!.format_ok).toBe(false);
  await page.goto(`/documents/${doc!.id}`);
  await expect(page.getByRole("main").getByText("Not preferred format")).toBeVisible();
  await expect(page.getByText("PDF · Excel or CSV preferred")).toBeVisible();
});

test("AC-21: /documents filters to documents not in a preferred format", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto("/documents");
  await page.getByRole("combobox", { name: "Format" }).selectOption("not_preferred");
  await expect(page.getByRole("list", { name: "Active filters" })).toContainText("Format: Not preferred");
  await expect(page.getByText("statement.pdf")).toBeVisible();
  await expect(page.getByRole("main").getByText("Not preferred format").first()).toBeVisible();
});

test("AC-5, AC-20: a per-client exception removes the warning; the plan row says so", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/clients/${clientId}?tab=settings`);
  const banking = page.getByRole("region", { name: "Banking", exact: true });
  await expect(banking).toContainText("Excel or CSV preferred");
  await banking.getByRole("switch", { name: `Any format is fine for ${T.bank} for this client` }).click();
  await expect(banking).toContainText("Any format (exception)");
  await addPdf(page);
  await expect(warning(page)).toHaveCount(0);
});

test("AC-24: Settings › Collection shows the preferred-format figures and the exceptions by type; axe; 390 px", async ({ page, baseURL }) => {
  await signIn(page, admin.email, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/collection");
  const section = page.getByRole("region", { name: "Preferred formats" });
  const figures = section.locator('dl[aria-label="Preferred format figures"]');
  // The staff PDF above was filed under the preference (flagged); the client's exception came later, and the second
  // Add document was never saved. No link uploads in this office.
  await expect(figures).toContainText("Staff filings in a preferred format");
  await expect(figures).toContainText("0 of 1 staff filings");
  await expect(figures).toContainText("no link uploads");
  await expect(section.getByRole("list", { name: "Clients allowed any format, by type" })).toContainText(`${T.bank} · 1 client`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await seriousAxe(page)).toEqual([]);
});
