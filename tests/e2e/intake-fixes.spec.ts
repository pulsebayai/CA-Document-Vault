import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, createSoftCopy, mustCreateDocument, periodId, typeId } from "../support/documents";
import { T } from "../support/expected";
import { signIn } from "./helpers";

// Feature 12, step 7 — quick file access and Edit entry points (spec AC-18, AC-19).
//   AC-18: View / Download on Untagged rows, /documents rows and Today's To review rows; a hard copy without a file
//          says "No file yet".
//   AC-19: Edit on Client › Documents and /documents rows and on the Needs-correction message.

let officeId: string;
let staff: { id: string; email: string };
let clientId: string;
const docs = {} as Record<"untaggedPdf" | "untaggedPaper" | "filed" | "paper" | "wrong", { id: string; doc_code: string }>;

test.beforeAll(async () => {
  officeId = await createDocumentOffice("intake-fixes");
  staff = await createStaff(officeId, "if-staff", "staff");
  const as = await signedInClient(staff.email);
  const { data: c, error } = await as.rpc("create_client", { p: { name: "Intake Fixes Traders", client_type: "individual", incharge_id: staff.id } });
  if (error) throw error;
  clientId = c.id;
  const bank = await typeId(officeId, T.bank);
  const apr = await periodId(officeId, "2026-04");
  docs.untaggedPdf = await createSoftCopy(as, officeId, {}, "pdf");
  docs.untaggedPaper = await mustCreateDocument(as, { received_as: "hard_copy", channel: "courier", handed_over_name: "Blue Dart" } as never);
  docs.filed = await createSoftCopy(as, officeId, { client_id: clientId, doc_type_id: bank, period_id: apr }, "pdf");
  docs.paper = await mustCreateDocument(as, { client_id: clientId, doc_type_id: bank, period_id: apr, received_as: "hard_copy", channel: "hand_delivery" });
  docs.wrong = await createSoftCopy(as, officeId, { client_id: clientId, doc_type_id: bank, period_id: apr }, "pdf");
  const { error: e2 } = await as.rpc("review_document", { p_id: docs.wrong.id, p_outcome: "needs_correction", p_reason: "Wrong month", p_kind: "details" });
  if (e2) throw e2;
});
test.afterAll(async () => { if (staff) await retireStaff([staff.id]); });
test.describe.configure({ mode: "serial" });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id);
}

test("AC-18: Untagged rows have View and Download; a hard copy without a file says No file yet", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto("/inbox");
  const rows = page.getByRole("list", { name: "Untagged documents" }).getByRole("listitem");
  const pdf = rows.filter({ hasText: docs.untaggedPdf.doc_code });
  await expect(pdf.getByRole("button", { name: `View ${docs.untaggedPdf.doc_code}` })).toBeVisible();
  const download = page.waitForEvent("download");
  await pdf.getByRole("button", { name: `Download ${docs.untaggedPdf.doc_code}` }).click();
  expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
  const paper = rows.filter({ hasText: docs.untaggedPaper.doc_code });
  await expect(paper).toContainText("No file yet");
  await expect(paper).toContainText("handed over by Blue Dart"); // AC-15
  expect(await seriousAxe(page)).toEqual([]);
});

test("AC-18, AC-19: /documents rows have file buttons and Edit; a hard copy without a file says No file yet", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/documents?client=${clientId}`);
  const row = (code: string) => page.getByRole("listitem").filter({ hasText: code });
  await expect(row(docs.filed.doc_code).getByRole("button", { name: `Download ${docs.filed.doc_code}` })).toBeVisible();
  await expect(row(docs.paper.doc_code)).toContainText("No file yet");
  expect(await seriousAxe(page)).toEqual([]);
  await row(docs.filed.doc_code).getByRole("link", { name: `Edit ${docs.filed.doc_code}` }).click();
  await expect(page.getByRole("heading", { name: "Edit document" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/documents/${docs.filed.id}/assign$`));
});

test("AC-19: Edit from Client › Documents saves and comes back to the client", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/clients/${clientId}`);
  await page.getByRole("link", { name: `Edit ${docs.filed.doc_code}` }).click();
  await expect(page.getByRole("heading", { name: "Edit document" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeEnabled(); // form is interactive
  await page.getByLabel("Remark").fill("Checked against the passbook");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(new RegExp(`/clients/${clientId}\\?saved=`));
  await expect(page.getByRole("status").filter({ hasText: "saved" })).toContainText(docs.filed.doc_code);
});

test("AC-19: the Needs-correction message offers Edit details", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/documents/${docs.wrong.id}`);
  await expect(page.getByTestId("review-state")).toContainText("Needs correction · wrong details · Wrong month");
  await page.getByRole("link", { name: "Edit details" }).click();
  await expect(page.getByRole("heading", { name: "Edit document" })).toBeVisible();
});

test("AC-18: Today's To review rows have Download (and View for a PDF)", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto("/today?scope=everyone&show=to_review");
  await expect(page.getByRole("button", { name: `Download ${docs.paper.doc_code}` })).toHaveCount(0); // no file
  await expect(page.getByRole("button", { name: `View ${docs.filed.doc_code}` })).toBeVisible();
  await expect(page.getByRole("button", { name: `Download ${docs.filed.doc_code}` })).toBeVisible();
});
