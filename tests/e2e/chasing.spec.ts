import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, mustCreateDocument, periodId, typeId } from "../support/documents";
import { bankOnlyClient, expectedItem, generateAsOf, mustRpc, T } from "../support/expected";
import { signIn } from "./helpers";

// Feature 06 step 7 — metric 2, chasing load, on Settings › Collection (spec AC-15). The definition itself is proven
// in tests/rls/chasing-metric.test.ts; this checks the figures, the note and the role gate on the page.
// Clock 10 May 2026: Mar + Apr Bank statements open. Apr gets a call and a WhatsApp, then both are received 12 May.

let officeId: string;
const u = {} as Record<"admin" | "manager" | "staff", { id: string; email: string }>;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  officeId = await createDocumentOffice("chasing-ui");
  u.admin = await createStaff(officeId, "chui-admin", "admin");
  u.manager = await createStaff(officeId, "chui-manager", "manager");
  u.staff = await createStaff(officeId, "chui-staff", "staff");
  const asAdmin = await signedInClient(u.admin.email);
  const asStaff = await signedInClient(u.staff.email);
  await generateAsOf(asAdmin, "2026-03-15");
  const client = await bankOnlyClient(asStaff, officeId, { name: "Chasing Co", incharge_id: u.staff.id, email: "chase@example.test", mobile: "9876543213" });
  await generateAsOf(asAdmin, "2026-05-10");
  const apr = (await expectedItem(client, T.bank, "2026-04")).id;
  await mustRpc(asStaff, "record_follow_up", { p_client: client, p_items: [apr], p_channel: "phone" });
  await mustRpc(asStaff, "record_follow_up", { p_client: client, p_items: [apr], p_channel: "whatsapp" });
  await generateAsOf(asAdmin, "2026-05-12");
  for (const p of ["2026-03", "2026-04"]) {
    await mustCreateDocument(asStaff, { client_id: client, doc_type_id: await typeId(officeId, T.bank), period_id: await periodId(officeId, p), received_on: "2026-05-12" });
  }
});
test.afterAll(async () => { await retireStaff(Object.values(u).map((x) => x.id)); });
test.describe.configure({ mode: "serial" });

const figure = (page: Page, label: string) =>
  page.getByRole("definition").filter({ has: page.locator(`xpath=preceding-sibling::dt[1][normalize-space()="${label}"]`) }).first();

test("AC-15: a Manager sees chasing load — per document, share needing a reminder, per channel — and its definition", async ({ page, baseURL }) => {
  await signIn(page, u.manager.email, baseURL);
  await page.goto("/settings/collection");
  const section = page.getByRole("region", { name: "Chasing load" });
  await expect(section.getByRole("heading", { name: "Chasing load" })).toBeVisible();
  await expect(figure(page, "Received")).toHaveText("2");
  await expect(figure(page, "Reminders per document")).toHaveText("1.00");
  await expect(figure(page, "Needed a reminder")).toHaveText("50%");
  await expect(figure(page, "By email")).toHaveText("0");
  await expect(figure(page, "By WhatsApp")).toHaveText("1");
  await expect(figure(page, "By call")).toHaveText("1");
  await expect(page.getByRole("note")).toContainText("Chasing load.");
  await expect(page.getByRole("note")).toContainText("on or before the day it was received");
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id)).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("AC-15: Staff can't open it", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.goto("/settings/collection");
  await expect(page.getByText("Chasing load")).toHaveCount(0);
});
