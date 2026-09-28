import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import "../support/setup-env";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, mustCreateDocument, periodId, typeId, uploadObject, TINY } from "../support/documents";
import { signIn } from "./helpers";

// Feature 03 step 7 — Client › Documents (mockup 10, received only) and the document page (spec AC-10 … AC-13).

let officeId: string;
let staff: { id: string; email: string };
let manager: { id: string; email: string };
let limited: { id: string; email: string };
let clientId: string;
let form16: { id: string; doc_code: string };
let original: { id: string; doc_code: string };

test.beforeAll(async () => {
  officeId = await createDocumentOffice("client-docs-ui");
  staff = await createStaff(officeId, "cdocs-staff", "staff");
  manager = await createStaff(officeId, "cdocs-manager", "manager");
  limited = await createStaff(officeId, "cdocs-limited", "limited");
  const asStaff = await signedInClient(staff.email);
  const { data, error } = await asStaff.rpc("create_client", { p: { name: "Documents Client", client_type: "individual", incharge_id: staff.id } });
  if (error) throw error;
  clientId = data.id;
  const obj = await uploadObject(officeId, "pdf");
  form16 = await mustCreateDocument(asStaff, {
    received_as: "soft_copy", channel: "email", client_id: clientId, doc_type_id: await typeId(officeId, "Form 16 from employer"),
    period_id: await periodId(officeId, "2025-26"), file: { storage_path: obj.path, file_name: "Form16 FY25-26.pdf" },
  });
  original = await mustCreateDocument(asStaff, {
    received_as: "original", channel: "hand_delivery", client_id: clientId,
    doc_type_id: await typeId(officeId, "Sales invoices / sales register"), period_id: await periodId(officeId, "2026-08"),
  });
});
test.afterAll(async () => { await retireStaff([staff?.id, manager?.id, limited?.id].filter(Boolean) as string[]); });
test.describe.configure({ mode: "serial" });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id);
}

test("AC-10: Documents tab groups by group → type → period with FY and group filters; View and Download", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/clients/${clientId}`);
  const tabs = page.getByRole("navigation", { name: "Client sections" });
  await expect(tabs.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page"); // still the default
  await tabs.getByRole("link", { name: /Documents\s*2/ }).click();
  await expect(tabs.getByRole("link", { name: /Documents/ })).toHaveAttribute("aria-current", "page");

  // Current FY (2026-27): the original received for Aug 2026.
  const gst = page.getByRole("list", { name: "GST documents" });
  await expect(gst.getByRole("listitem")).toHaveCount(1);
  await expect(gst.getByRole("listitem").first()).toContainText("Sales invoices / sales register · Aug 2026");
  await expect(gst.getByRole("listitem").first()).toContainText(original.doc_code);
  await expect(gst.getByRole("listitem").first()).toContainText("Original");
  await expect(page.getByRole("list", { name: "Income Tax documents" })).toHaveCount(0);
  expect(await seriousAxe(page)).toEqual([]);

  // FY 2025-26: Form 16, with its file.
  await page.getByLabel("Financial year").selectOption("2025-26");
  const it = page.getByRole("list", { name: "Income Tax documents" });
  await expect(it.getByRole("listitem").first()).toContainText("Form 16 from employer · FY 2025-26");
  const downloadP = page.waitForEvent("download");
  await it.getByRole("button", { name: `Download ${form16.doc_code}` }).click();
  expect((await downloadP).suggestedFilename()).toBe("Form16 FY25-26.pdf");
  // View: a new tab (opened inside the click) requests a fresh signed link without "download".
  // Headless Chromium has no PDF viewer, so the tab itself can't be asserted as loaded — the request can.
  const popupP = page.waitForEvent("popup");
  const viewReq = page.context().waitForEvent("request", (r) => /\/storage\/v1\/object\/sign\/documents\//.test(r.url()));
  await it.getByRole("button", { name: `View ${form16.doc_code}` }).click();
  const popup = await popupP;
  const req = await viewReq;
  expect(req.frame().page()).toBe(popup);
  expect(new URL(req.url()).searchParams.has("download")).toBe(false);
  await popup.close();

  // Group filter + empty state.
  await page.getByLabel("Group").selectOption({ label: "GST" });
  await expect(page.getByText("No documents received for FY 2025-26 in this group yet.")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("AC-11: document page — details, current file, a new version keeps the DOC-ID and becomes current", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/documents/${form16.id}`);
  await expect(page.getByRole("heading", { name: "Form 16 from employer · FY 2025-26" })).toBeVisible();
  await expect(page.getByText(form16.doc_code).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Archive" })).toHaveCount(0); // Admin/Manager only
  expect(await seriousAxe(page)).toEqual([]);

  await page.locator('input[type="file"]').setInputFiles({ name: "Form16 FY25-26 revised.png", mimeType: "image/png", buffer: TINY.png.bytes });
  await expect(page.getByText("New version saved.")).toBeVisible();
  const versions = page.getByRole("list", { name: "Versions" });
  await expect(versions.getByRole("listitem")).toHaveCount(2);
  await expect(versions.getByRole("listitem").first()).toContainText("Version 2");
  await expect(versions.getByRole("listitem").first()).toContainText("Current");
  await expect(page.getByText("Form16 FY25-26 revised.png").first()).toBeVisible();
  const { data } = await adminClient().from("document").select("doc_code, version_count").eq("id", form16.id).single();
  expect(data).toEqual({ doc_code: form16.doc_code, version_count: 2 });
  await expect(page.getByText("uploaded a new version")).toBeVisible(); // activity summary
});

test("AC-11: a manager archives with a reason; it leaves the client's list; unarchive brings it back", async ({ page, baseURL }) => {
  await signIn(page, manager.email, baseURL);
  await page.goto(`/documents/${original.id}`);
  await page.getByRole("button", { name: "Archive" }).click();
  const dialog = page.getByRole("dialog", { name: `Archive ${original.doc_code}?` });
  await dialog.getByRole("button", { name: "Archive document" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Give a reason");
  await dialog.getByLabel("Reason").fill("Duplicate of an earlier upload");
  await dialog.getByRole("button", { name: "Archive document" }).click();
  await expect(page.getByRole("status").filter({ hasText: "archived" })).toContainText("Duplicate of an earlier upload");

  await page.goto(`/clients/${clientId}?tab=documents`);
  await expect(page.getByText(original.doc_code)).toHaveCount(0);

  await page.goto(`/documents/${original.id}`);
  await page.getByRole("button", { name: "Unarchive" }).click();
  await expect(page.getByRole("status").filter({ hasText: "archived" })).toHaveCount(0);
});

test("AC-12: a Limited user gets Not Found for a document of a client they can't see", async ({ page, baseURL }) => {
  await signIn(page, limited.email, baseURL);
  await page.goto(`/documents/${form16.id}`);
  await expect(page.getByText(/not found|could not be found/i).first()).toBeVisible();
  await expect(page.getByText(form16.doc_code)).toHaveCount(0);
});
