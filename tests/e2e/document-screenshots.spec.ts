import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { groupId } from "../support/catalogue";
import { createDocumentOffice, mustCreateDocument, periodId, typeId, uploadObject, TINY } from "../support/documents";
import { testGstin, testPan } from "../support/test-data";
import { signIn } from "./helpers";

// Feature 03 step 9 — screenshots of the new screens for the PR next to mockups 02 (Inbox), 10 (Client ›
// Documents, received only) and 12 (Add document), plus the document page; axe at desktop and phone width;
// no sideways page scroll at 390 px. Screenshots land in test-results/screenshots/ (CI evidence artifact).

let officeId: string;
let admin: { id: string; email: string };
let clientId: string;
let docId: string;
const SHOTS = "test-results/screenshots";

test.beforeAll(async () => {
  // Fixture set-up from a US runner to the Mumbai DB (office reset, storage purge, users, client, documents)
  // can pass 30 s on a busy run (run 36455393633); the test's own checks keep their limits.
  test.setTimeout(90_000);
  officeId = await createDocumentOffice("doc-screenshots-ui");
  admin = await createStaff(officeId, "dshots-admin", "admin");
  const staff = await createStaff(officeId, "dshots-staff", "staff");
  const as = await signedInClient(admin.email);
  const asStaff = await signedInClient(staff.email);
  const pan = testPan("C", 8101);
  const { data, error } = await as.rpc("create_client", { p: {
    name: "Sankar Software Pvt Ltd", client_type: "private_ltd", pan, incharge_id: staff.id,
    registrations: [{ kind: "gstin", number: testGstin(pan) }],
    group_ids: await Promise.all(["GST", "Income Tax", "TDS/TCS"].map((g) => groupId(officeId, g))),
  } });
  if (error) throw error;
  clientId = data.id;
  const file = async (name: string) => ({ storage_path: (await uploadObject(officeId, "pdf")).path, file_name: name });
  const t = async (n: string) => typeId(officeId, n);
  const p = async (c: string) => periodId(officeId, c);
  docId = (await mustCreateDocument(asStaff, { received_as: "soft_copy", channel: "email", client_id: clientId,
    doc_type_id: await t("Sales invoices / sales register"), period_id: await p("2026-08"), file: await file("Aug-2026-invoices.pdf") })).id;
  await mustCreateDocument(asStaff, { received_as: "soft_copy", channel: "whatsapp", client_id: clientId,
    doc_type_id: await t("Purchase invoices / purchase register"), period_id: await p("2026-07"), file: await file("purchases-jul.pdf") });
  await mustCreateDocument(asStaff, { received_as: "original", channel: "hand_delivery", client_id: clientId,
    doc_type_id: await t("Form 16 from employer"), period_id: await p("2026-27") });
  // Inbox (mockup 02)
  await mustCreateDocument(asStaff, { received_as: "soft_copy", channel: "whatsapp", file: await file("bank_stmt_aug.pdf") });
  await mustCreateDocument(as, { received_as: "hard_copy", channel: "courier", remark: "from Blue Dart, sender unclear" });
  await mustCreateDocument(asStaff, { received_as: "soft_copy", channel: "email", client_id: clientId, file: await file("scan.pdf") });
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

test("screens vs mockups 02 / 10 / 12 + document page, desktop and phone width; no serious/critical axe issues", async ({ page, baseURL }) => {
  // Time limit only (Raja 2026-10-26): on CI this test took 26–28 s of the 30 s budget before feature 10 (run 40191740304)
  // and varies ±10 s run to run, so it failed at random (PR #3 run 40267263923). Every check is unchanged.
  test.slow();
  await page.setViewportSize({ width: 1280, height: 860 });
  await signIn(page, admin.email, baseURL);

  // Mockup 02 — Inbox
  await page.goto("/inbox");
  await expect(page.getByRole("list", { name: "Untagged documents" }).getByRole("listitem")).toHaveCount(3);
  await shoot(page, "02-inbox");

  // Mockup 10 — Client › Documents (received documents only in 03)
  await page.goto(`/clients/${clientId}?tab=documents`);
  await expect(page.getByRole("list", { name: "GST documents" }).getByRole("listitem")).toHaveCount(2);
  await shoot(page, "10-client-documents");

  // Mockup 12 — Add document, with a file chosen and the type picked
  await page.goto(`/documents/new?client=${clientId}&from=/clients/${clientId}`);
  await page.locator('input[type="file"]').setInputFiles({ name: "Aug-2026-invoices.pdf", mimeType: "application/pdf", buffer: TINY.pdf.bytes });
  await expect(page.getByText("Uploaded", { exact: true })).toBeVisible();
  await page.getByLabel("Document type").selectOption({ label: "Sales invoices / sales register · GST" });
  await shoot(page, "12-add-document");

  // Document page (no mockup)
  await page.goto(`/documents/${docId}`);
  await expect(page.getByRole("heading", { name: /Sales invoices \/ sales register · Aug 2026/ })).toBeVisible();
  await shoot(page, "document-page");

  // Phone width: no sideways page scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, name] of [
    ["/inbox", "mobile-02-inbox"], [`/clients/${clientId}?tab=documents`, "mobile-10-client-documents"],
    [`/documents/new?client=${clientId}`, "mobile-12-add-document"], [`/documents/${docId}`, "mobile-document-page"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("main")).toBeVisible();
    expect(await pageWidth(page), path).toBeLessThanOrEqual(390);
    await shoot(page, name);
  }
});
