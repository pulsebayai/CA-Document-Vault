import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { groupId } from "../support/catalogue";
import { createDocumentOffice, TINY } from "../support/documents";
import { testGstin, testPan } from "../support/test-data";
import { defaultPeriod, istDate } from "@/lib/documents/period";
import { appAlert, signIn } from "./helpers";

// Feature 03 step 5 — Add document (mockup 12; spec AC-1 … AC-5, AC-15). Own is_test office; its Storage
// objects are removed and its rows reset at the start of every run.

let officeId: string;
let staff: { id: string; email: string };
let clientId: string;
let lastMonthLabel: string;
let lastMonthCode: string;
let lastMonthId: string;
const DOC_ID = /DOC-FY\d{2}-\d{2}-\d{5}/;

test.beforeAll(async () => {
  officeId = await createDocumentOffice("add-doc-ui");
  staff = await createStaff(officeId, "adddoc-staff", "staff");
  const asStaff = await signedInClient(staff.email);
  const pan = testPan("P", 7101);
  const { data, error } = await asStaff.rpc("create_client", { p: {
    name: "Sankar Software", client_type: "proprietorship", pan, incharge_id: staff.id,
    registrations: [{ kind: "gstin", number: testGstin(pan) }], group_ids: [await groupId(officeId, "GST")],
  } });
  if (error) throw error;
  clientId = data.id;
  lastMonthCode = defaultPeriod("monthly", istDate())!.code;
  const { data: p } = await adminClient().from("period").select("id, label").eq("office_id", officeId).eq("code", lastMonthCode).single();
  lastMonthLabel = p!.label as string;
  lastMonthId = p!.id as string;
});
test.afterAll(async () => { if (staff) await retireStaff([staff.id]); });
test.describe.configure({ mode: "serial" });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id);
}
const latestDocument = async () => {
  const { data, error } = await adminClient().from("document")
    .select("id, doc_code, client_id, doc_type_id, period_id, registration_id, received_as, classified_at, version_count, current_version_id")
    .eq("office_id", officeId).order("created_at", { ascending: false }).limit(1).single();
  if (error) throw error;
  return data;
};

test("AC-1 … AC-5: from a client page, a soft copy is filed in ≤ 3 clicks after choosing the file", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/clients/${clientId}`);
  await page.getByRole("main").getByRole("link", { name: "Add document", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Add document" })).toBeVisible();
  await expect(page.getByText("Sankar Software")).toBeVisible(); // AC-3: client pre-filled from context
  expect(await seriousAxe(page)).toEqual([]);

  // Choose the file: it uploads straight away (progress, then "Uploaded").
  await page.locator('input[type="file"]').setInputFiles({ name: "Aug-2026-invoices.pdf", mimeType: "application/pdf", buffer: TINY.pdf.bytes });
  await expect(page.getByText("Uploaded", { exact: true })).toBeVisible();

  // AC-5: click 1–2 = pick the type from the client's plan (listed first); click 3 = Save to vault.
  const type = page.getByLabel("Document type");
  await type.selectOption({ label: "Sales invoices / sales register · GST" });
  // AC-3: group shown; period defaults to the month that just ended; the only GSTIN is picked.
  await expect(page.getByText("set from the type")).toContainText("GST");
  await expect(page.getByRole("radio", { name: "Month" })).toBeChecked();
  await expect(page.getByRole("combobox", { name: "Month" })).toHaveValue(lastMonthId);
  await expect(page.getByRole("combobox", { name: "Month" }).locator("option:checked")).toHaveText(lastMonthLabel);
  await expect(page.getByLabel("GSTIN")).not.toHaveValue("");
  await page.getByRole("button", { name: "Save to vault" }).click();

  // Back on the client page with the DOC-ID (AC-4).
  await page.waitForURL(new RegExp(`/clients/${clientId}\\?saved=`));
  await expect(page.getByRole("status").filter({ hasText: "saved" })).toContainText(DOC_ID);
  const d = await latestDocument();
  expect(d).toMatchObject({ client_id: clientId, received_as: "soft_copy", version_count: 1 });
  expect(d.classified_at).not.toBeNull();
  expect(d.registration_id).not.toBeNull();
  const { data: period } = await adminClient().from("period").select("code").eq("id", d.period_id!).single();
  expect(period!.code).toBe(lastMonthCode);
  const { data: v } = await adminClient().from("document_version").select("file_name, mime_type").eq("id", d.current_version_id!).single();
  expect(v).toEqual({ file_name: "Aug-2026-invoices.pdf", mime_type: "application/pdf" });
});

test("AC-1, AC-4: a hard copy with no file goes to the Inbox from the header button", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.getByRole("banner").getByRole("link", { name: "Add document" }).click();
  await page.getByText("Hard copy", { exact: true }).click();
  await page.getByLabel("Channel").selectOption("courier");
  await page.getByRole("button", { name: "Save to inbox" }).click();
  await page.waitForURL(/\/clients\?saved=/);
  await expect(page.getByRole("status").filter({ hasText: "saved" })).toContainText(DOC_ID);
  const d = await latestDocument();
  expect(d).toMatchObject({ client_id: null, received_as: "hard_copy", version_count: 0, classified_at: null });
});

test("AC-1, AC-2, AC-4: errors are inline, in plain words, and nothing is saved", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  const before = (await latestDocument()).id;
  await page.goto(`/documents/new?client=${clientId}`);
  // A soft copy needs a file; Save to vault needs a type.
  await page.getByRole("button", { name: "Save to vault" }).click();
  await expect(appAlert(page).first()).toContainText("Check the highlighted fields");
  await expect(page.getByLabel("Document type")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Add the file — a soft copy needs one.")).toBeVisible();
  // A file that isn't allowed is refused before any upload.
  await page.locator('input[type="file"]').setInputFiles({ name: "setup.exe", mimeType: "application/x-msdownload", buffer: Buffer.from("MZ") });
  await expect(page.getByText(/This file type isn't accepted/)).toBeVisible();
  expect((await latestDocument()).id).toBe(before);
});

test("AC-15: a new type is offered only after the closest existing ones, and joins the client's plan", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/documents/new?client=${clientId}`);
  await page.getByText("Hard copy", { exact: true }).click();
  await page.getByLabel("Document type").selectOption({ label: "+ New type for this client…" });

  const name = page.getByLabel("New type name");
  await name.fill("form 16");
  await expect(page.getByRole("list", { name: "Existing types that match" })).toContainText("Form 16 from employer");

  await name.fill("Crypto exchange statement");
  await page.getByLabel("Group", { exact: true }).selectOption({ label: "Income Tax" });
  await page.getByRole("button", { name: /New type “Crypto exchange statement” for this client/ }).click();
  await expect(page.getByLabel("Document type")).toHaveValue(/[0-9a-f-]{36}/);
  await expect(page.getByText("Proposed — waiting for approval.")).toBeVisible();
  expect(await seriousAxe(page)).toEqual([]);

  await page.getByRole("button", { name: "Save to vault" }).click();
  await page.waitForURL(new RegExp(`/clients/${clientId}\\?saved=`));
  const d = await latestDocument();
  const { data: t } = await adminClient().from("doc_type").select("name, status, proposed_for_client_id").eq("id", d.doc_type_id!).single();
  expect(t).toEqual({ name: "Crypto exchange statement", status: "proposed", proposed_for_client_id: clientId });
  const { data: plan } = await adminClient().from("client_doc_type").select("id").eq("client_id", clientId).eq("doc_type_id", d.doc_type_id!);
  expect(plan!.length).toBe(1);
});

test("NFR: Add document fits a 390 px phone screen", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/documents/new?client=${clientId}`);
  await expect(page.getByRole("heading", { name: "Add document" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
