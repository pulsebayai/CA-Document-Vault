import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, mustCreateDocument, periodId, typeId, uploadObject } from "../support/documents";
import { signIn } from "./helpers";

// Feature 15 — Client › All documents (spec AC-1…AC-7): the /documents table for one client, current FY by default,
// with Last activity and the expandable row. The K4 timings are RLS tests (k4-volume.test.ts); this spec covers the screen.

let officeId: string;
let staff: { id: string; email: string };
let limited: { id: string; email: string };
let clientId: string;
let otherClientId: string;
let current: { id: string; doc_code: string };
let older: { id: string; doc_code: string };
let otherDoc: { id: string; doc_code: string };

test.beforeAll(async () => {
  officeId = await createDocumentOffice("all-docs-ui");
  staff = await createStaff(officeId, "alldocs-staff", "staff");
  limited = await createStaff(officeId, "alldocs-limited", "limited");
  const asStaff = await signedInClient(staff.email);
  const mk = async (name: string, incharge: string) => {
    const { data, error } = await asStaff.rpc("create_client", { p: { name, client_type: "individual", incharge_id: incharge } });
    if (error) throw error;
    return data.id as string;
  };
  clientId = await mk("All Docs Client", limited.id); // Limited sees this client
  otherClientId = await mk("Other Docs Client", staff.id);
  const obj = await uploadObject(officeId, "pdf");
  current = await mustCreateDocument(asStaff, {
    received_as: "soft_copy", channel: "email", client_id: clientId, doc_type_id: await typeId(officeId, "Sales invoices / sales register"),
    period_id: await periodId(officeId, "2026-08"), file: { storage_path: obj.path, file_name: "sales-aug.pdf" },
  });
  older = await mustCreateDocument(asStaff, {
    received_as: "hard_copy", returnable: false, handed_over_name: "Client's accountant", channel: "hand_delivery", client_id: clientId,
    doc_type_id: await typeId(officeId, "Form 16 from employer"), period_id: await periodId(officeId, "2025-26"),
  } as never);
  otherDoc = await mustCreateDocument(asStaff, {
    received_as: "hard_copy", returnable: false, handed_over_name: "Courier", channel: "courier", client_id: otherClientId,
    doc_type_id: await typeId(officeId, "Sales invoices / sales register"), period_id: await periodId(officeId, "2026-08"),
  } as never);
  // A later event on the current document, so its Last activity and expanded row show more than "added".
  const { error } = await asStaff.rpc("review_document", { p_id: current.id, p_outcome: "reviewed" });
  if (error) throw error;
});
test.afterAll(async () => { await retireStaff([staff?.id, limited?.id].filter(Boolean) as string[]); });
test.describe.configure({ mode: "serial" });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id);
}

test("AC-1, AC-2: the tab after Documents shows this client's current FY; All years is kept in the URL", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/clients/${clientId}`);
  const tabs = page.getByRole("navigation", { name: "Client sections" });
  await expect(tabs.getByRole("link", { name: /^Documents/ })).toHaveAttribute("aria-current", "page"); // still the default
  await expect(tabs.getByRole("listitem").nth(1)).toHaveText(/All documents\s*2/);
  await tabs.getByRole("link", { name: /All documents/ }).click();
  await expect(page).toHaveURL(new RegExp(`/clients/${clientId}\\?tab=all$`));

  const rows = page.getByRole("list", { name: "Documents" });
  await expect(rows.getByRole("listitem")).toHaveCount(1);
  await expect(rows).toContainText(current.doc_code);
  await expect(page.getByRole("searchbox", { name: "Client" })).toHaveCount(0); // the client is fixed
  await expect(page.getByRole("combobox", { name: "FY" })).toHaveValue(/.+/); // the current FY is chosen

  await page.getByRole("combobox", { name: "FY" }).selectOption({ label: "FY: All years" });
  await expect(page).toHaveURL(new RegExp(`/clients/${clientId}\\?tab=all&fy=all$`));
  await expect(rows.getByRole("listitem")).toHaveCount(2);
  await expect(rows).toContainText(older.doc_code);
  await expect(rows).not.toContainText(otherDoc.doc_code); // another client's document never shows
  expect(page.url()).not.toContain("client=");
});

test("AC-5, AC-7: Last activity per row; Show activity lists the latest events with See all", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/clients/${clientId}?tab=all`);
  const row = page.getByRole("list", { name: "Documents" }).getByRole("listitem").filter({ hasText: current.doc_code });
  await expect(row).toContainText(/Last activity: Test · reviewed Sales invoices \/ sales register · (just now|\d+ min ago)/);

  const toggle = row.getByRole("button", { name: `Show activity for ${current.doc_code}` });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const events = page.getByRole("list", { name: `Activity of ${current.doc_code}` });
  await expect(events.getByRole("listitem")).toHaveCount(2); // added, reviewed
  await expect(events.getByRole("listitem").first()).toContainText("reviewed");
  expect(await seriousAxe(page)).toEqual([]);
  await page.getByRole("link", { name: `See all activity for ${current.doc_code}` }).click();
  await expect(page).toHaveURL(new RegExp(`/activity\\?document=${current.id}$`));
});

test("AC-3: selection and the bulk bar work on the tab", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/clients/${clientId}?tab=all&fy=all`); // a fresh load of an All years link keeps All years (AC-2)
  await expect(page.getByRole("list", { name: "Documents" }).getByRole("listitem")).toHaveCount(2);
  await page.getByRole("checkbox", { name: `Select ${older.doc_code}` }).check();
  await expect(page.getByTestId("selection-count")).toHaveText("1 selected");
});

test("AC-1: a Limited user sees the tab for a client they can see; 390 px fits", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, limited.email, baseURL);
  await page.goto(`/clients/${clientId}?tab=all&fy=all`);
  await expect(page.getByRole("list", { name: "Documents" }).getByRole("listitem")).toHaveCount(2);
  await expect(page.getByText(/^Last activity/).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await seriousAxe(page)).toEqual([]);
  // Another client is not visible to the Limited user: the page is Not Found, as every client tab (02 AC-12).
  await page.goto(`/clients/${otherClientId}?tab=all`);
  await expect(page.getByRole("heading", { name: "Other Docs Client" })).toHaveCount(0);
});
