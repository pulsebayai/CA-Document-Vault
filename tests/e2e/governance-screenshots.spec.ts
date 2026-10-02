import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { groupId } from "../support/catalogue";
import { createDocumentOffice, mustCreateDocument } from "../support/documents";
import { signIn } from "./helpers";

// Feature 05 step 7 — screenshots for the PR next to mockup 05 (Settings › Catalogue, "Proposed by staff"), the four
// decision dialogs, the bell (no mockup) and Settings › Collection's catalogue figure (no mockup); axe at desktop and
// phone width; no sideways page scroll at 390 px. Screenshots land in test-results/screenshots/. Own office, so it
// doesn't depend on type-governance.spec.ts's order.

const SHOTS = "test-results/screenshots";
let staff: { id: string; email: string };
let admin: { id: string; email: string };

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const officeId = await createDocumentOffice("governance-shots");
  staff = await createStaff(officeId, "govshots-staff", "staff");
  admin = await createStaff(officeId, "govshots-admin", "admin");
  const asStaff = await signedInClient(staff.email);
  const client = async (name: string) => {
    const { data, error } = await asStaff.rpc("create_client", { p: { name, client_type: "partnership", incharge_id: staff.id } });
    if (error) throw error;
    return (data as { id: string }).id;
  };
  const a = await client("Sankar Software Pvt Ltd");
  const b = await client("Meena Exports");
  const propose = async (c: string, group: string, name: string) => {
    const { data, error } = await asStaff.rpc("create_proposed_type", { p_client_id: c, p_doc_group_id: await groupId(officeId, group), p_name: name });
    if (error) throw error;
    return (data as { doc_type_id: string }).doc_type_id;
  };
  const s1 = await propose(a, "Payroll", "Salary sheet");
  const s2 = await propose(b, "Payroll", "Salary sheet");
  await propose(a, "Other", "Visiting cards");
  for (const t of [s1, s1, s2]) await mustCreateDocument(asStaff, { client_id: t === s1 ? a : b, doc_type_id: t });
  // A decision the staff member is notified about, for the bell.
  const asAdmin = await signedInClient(admin.email);
  const gate = await propose(a, "Other", "Gate passes");
  const { error } = await asAdmin.rpc("approve_proposed_type", { p: { type_id: gate } });
  if (error) throw error;
});
test.afterAll(async () => { await retireStaff([staff?.id, admin?.id].filter(Boolean) as string[]); });

async function shoot(page: Page, name: string) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}
const pageWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth);
const item = (page: Page, name: string) =>
  page.getByRole("region", { name: /Proposed by staff/ }).getByRole("list", { name: "Proposed types" }).getByRole("listitem")
    .filter({ has: page.getByText(name, { exact: true }) });

for (const [label, width, height] of [["desktop", 1280, 860], ["phone", 390, 844]] as const) {
  test(`05 screens vs mockup 05 + dialogs + bell + collection — ${label}; no serious/critical axe issues`, async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height });
    await signIn(page, admin.email, baseURL);

    await page.goto("/settings/catalogue");
    await expect(page.getByRole("region", { name: /Proposed by staff/ })).toContainText("2 waiting");
    await item(page, "Salary sheet").getByText("Used on 2 clients").click();
    if (width === 390) expect(await pageWidth(page)).toBeLessThanOrEqual(390);
    await shoot(page, `05-catalogue-queue-${label}`);

    await item(page, "Salary sheet").getByRole("button", { name: "Approve Salary sheet", exact: true }).click();
    await expect(page.getByRole("dialog", { name: /Approve “Salary sheet”/ }).getByRole("list", { name: "What will happen" })).toBeVisible();
    await shoot(page, `05-approve-dialog-${label}`);
    await page.keyboard.press("Escape");

    await item(page, "Salary sheet").getByRole("button", { name: "Edit and approve Salary sheet" }).click();
    await expect(page.getByRole("dialog", { name: /Edit & approve “Salary sheet”/ })).toBeVisible();
    await shoot(page, `05-edit-approve-dialog-${label}`);
    await page.keyboard.press("Escape");

    await item(page, "Salary sheet").getByRole("button", { name: "Merge Salary sheet into an approved type" }).click();
    const merge = page.getByRole("dialog", { name: /Merge “Salary sheet”/ });
    await merge.getByRole("searchbox", { name: "Find the approved type" }).fill("salary register");
    await merge.getByRole("radio", { name: /Salary register/ }).first().check();
    await expect(merge.getByRole("list", { name: "What will happen" })).toContainText("3 documents on 2 clients move to");
    await shoot(page, `05-merge-dialog-${label}`);
    await page.keyboard.press("Escape");

    await item(page, "Visiting cards").getByRole("button", { name: "Reject Visiting cards" }).click();
    await expect(page.getByRole("dialog", { name: /Reject “Visiting cards”/ })).toBeVisible();
    await shoot(page, `05-reject-dialog-${label}`);
    await page.keyboard.press("Escape");

    await page.goto("/settings/collection");
    await expect(page.locator('dl[aria-label="Catalogue figures"]')).toContainText("Filed under approved types");
    if (width === 390) expect(await pageWidth(page)).toBeLessThanOrEqual(390);
    await shoot(page, `05-collection-catalogue-${label}`);
  });
}

test("05 bell (no mockup) — desktop and phone; axe", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  for (const [label, width, height] of [["desktop", 1280, 860], ["phone", 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/today");
    await page.getByRole("button", { name: /^Notifications/ }).click();
    await expect(page.getByRole("region", { name: "Notifications" })).toContainText("Gate passes (Other) was approved.");
    if (width === 390) expect(await pageWidth(page)).toBeLessThanOrEqual(390);
    await shoot(page, `05-bell-${label}`);
    await page.keyboard.press("Escape");
  }
});
