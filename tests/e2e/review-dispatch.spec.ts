import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import {
  createSoftCopy, createDocumentOffice, mustCreateDocument, mustCreateOriginal, mustDispatch, mustReview, periodId, typeId,
} from "../support/documents";
import { T } from "../support/expected";
import { signIn } from "./helpers";

// Feature 07 steps 5–8 — Client › Documents rows (AC-1, AC-2, AC-11, AC-12), the dispatch dialog (AC-8), the
// document page's Review and Dispatch panels (AC-4, AC-5, AC-10, AC-13) and /documents Status + Return (AC-14);
// axe, ≤ 390 px, screenshots next to mockup 10 (test-results/screenshots/).

const SHOTS = "test-results/screenshots";
let officeId: string;
const u = {} as Record<"staff" | "manager", { id: string; email: string }>;
let clientId: string;
const doc = {} as Record<"toReview" | "fix" | "orig1" | "orig2" | "soft" | "sent", { id: string; doc_code: string }>;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  officeId = await createDocumentOffice("review-dispatch-ui");
  u.staff = await createStaff(officeId, "rdui-staff", "staff");
  u.manager = await createStaff(officeId, "rdui-manager", "manager");
  const asStaff = await signedInClient(u.staff.email);
  const { data, error } = await asStaff.rpc("create_client", { p: { name: "Review Dispatch Client", client_type: "individual", incharge_id: u.staff.id } });
  if (error) throw error;
  clientId = data.id;
  const bank = await typeId(officeId, T.bank);
  const form16 = await typeId(officeId, T.form16);
  const aug = await periodId(officeId, "2026-08");
  const jul = await periodId(officeId, "2026-07");
  const fy = await periodId(officeId, "2025-26");
  doc.toReview = await mustCreateDocument(asStaff, { client_id: clientId, doc_type_id: bank, period_id: aug, received_as: "hard_copy", received_on: "2026-09-03" });
  doc.fix = await mustCreateDocument(asStaff, { client_id: clientId, doc_type_id: bank, period_id: jul, received_as: "hard_copy", received_on: "2026-08-04" });
  doc.orig1 = await mustCreateOriginal(asStaff, { client_id: clientId, doc_type_id: form16, period_id: fy, received_on: "2026-06-12" }, asStaff);
  doc.orig2 = await mustCreateOriginal(asStaff, { client_id: clientId, doc_type_id: form16, period_id: fy, received_on: "2026-06-20", remark: "Second copy" }, asStaff);
  doc.soft = await createSoftCopy(asStaff, officeId, { client_id: clientId, doc_type_id: bank, period_id: await periodId(officeId, "2026-06"), received_on: "2026-07-02" });
  await mustReview(asStaff, doc.soft.id, "needs_correction", "Wrong account number");
  doc.sent = await mustCreateOriginal(asStaff, { client_id: clientId, doc_type_id: form16, period_id: fy, received_on: "2026-05-02" }, asStaff);
  await mustDispatch(asStaff, { client_id: clientId, document_ids: [doc.sent.id], dispatched_on: "2026-05-10", method: "hand_delivery", recipient_name: "Client's accountant" });
});
test.afterAll(async () => { await retireStaff([u.staff?.id, u.manager?.id].filter(Boolean) as string[]); });
test.describe.configure({ mode: "serial" });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id);
}
const rowOf = (page: Page, code: string) => page.getByRole("listitem").filter({ hasText: code });
async function noSidewaysScroll(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
}

test("AC-1, AC-2, AC-11, AC-12: rows show their state and the next action; Mark reviewed and Needs correction", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.goto(`/clients/${clientId}?tab=documents`);
  await expect(rowOf(page, doc.toReview.doc_code)).toContainText("To review");
  await page.getByLabel("Financial year").selectOption("2025-26");
  await expect(rowOf(page, doc.orig1.doc_code)).toContainText("Ready to dispatch");
  await expect(rowOf(page, doc.orig1.doc_code)).toContainText(/Held \d+ days/);
  await expect(rowOf(page, doc.sent.doc_code)).toContainText("Dispatched 10 May · Hand delivery");
  await expect(rowOf(page, doc.sent.doc_code)).not.toContainText("Held");
  await expect(rowOf(page, doc.sent.doc_code).getByRole("button")).toHaveCount(0);
  await page.getByLabel("Financial year").selectOption("2026-27");
  expect(await seriousAxe(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/07-client-documents.png`, fullPage: true });

  // AC-1: one click.
  await rowOf(page, doc.toReview.doc_code).getByRole("button", { name: /Mark reviewed/ }).click();
  await expect(rowOf(page, doc.toReview.doc_code)).toContainText(/Reviewed \d+ \w+ by Test rdui-staff/);
  await expect(rowOf(page, doc.toReview.doc_code).getByRole("button", { name: /Mark reviewed/ })).toHaveCount(0);

  // AC-2: Needs correction needs a reason; keyboard-reachable.
  const fix = rowOf(page, doc.fix.doc_code);
  await fix.getByRole("button", { name: new RegExp(`^Needs correction: .*${doc.fix.doc_code}`) }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: /Needs correction/ });
  await dialog.getByRole("button", { name: "Mark needs correction" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Give a reason");
  await dialog.getByLabel("Reason").fill("Statement is for the wrong account");
  await dialog.getByRole("button", { name: "Mark needs correction" }).click();
  await expect(rowOf(page, doc.fix.doc_code)).toContainText("Needs correction · Statement is for the wrong account");
  await expect(rowOf(page, doc.fix.doc_code).getByRole("button", { name: /Mark reviewed/ })).toBeVisible();
  await noSidewaysScroll(page);
});

test("AC-8: Mark dispatched lists the client's ready originals and saves one packet", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.goto(`/clients/${clientId}?tab=documents`);
  await page.getByLabel("Financial year").selectOption("2025-26");
  await rowOf(page, doc.orig1.doc_code).getByRole("button", { name: /Mark dispatched/ }).click();
  const dialog = page.getByRole("dialog", { name: "Mark originals dispatched" });
  const one = dialog.getByRole("checkbox", { name: new RegExp(doc.orig1.doc_code) });
  const two = dialog.getByRole("checkbox", { name: new RegExp(doc.orig2.doc_code) });
  await expect(one).toBeChecked();
  await expect(two).not.toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: new RegExp(doc.sent.doc_code) })).toHaveCount(0);
  await two.check();
  await dialog.getByRole("radio", { name: "Courier" }).check();
  await dialog.getByLabel("Courier (optional)").fill("Blue Dart");
  await dialog.getByLabel("Tracking number (optional)").fill("BD-77812");
  expect(await seriousAxe(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/07-dispatch-dialog.png` });
  await dialog.getByRole("button", { name: "Mark 2 dispatched" }).click();
  await expect(dialog.getByText("Enter who received it.")).toBeVisible();
  await dialog.getByLabel("Recipient").fill("Ramesh (office manager)");
  await page.setViewportSize({ width: 390, height: 844 });
  const box = await dialog.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
  await dialog.getByRole("button", { name: "Mark 2 dispatched" }).click();
  await expect(dialog).toBeHidden();
  for (const d of [doc.orig1, doc.orig2]) await expect(rowOf(page, d.doc_code)).toContainText(/Dispatched \d+ \w+ · Courier/);
  const { data } = await adminClient().from("dispatch_item").select("dispatch_id").in("document_id", [doc.orig1.id, doc.orig2.id]).is("removed_at", null);
  expect(new Set(data!.map((r) => r.dispatch_id)).size).toBe(1);
});

test("AC-13, AC-5, AC-10: the document page's Review and Dispatch panels; Admin/Manager undo", async ({ page, baseURL }) => {
  // Staff sees the panels without the undo actions.
  await signIn(page, u.staff.email, baseURL);
  await page.goto(`/documents/${doc.orig1.id}`);
  const dispatch = page.getByRole("region", { name: "Dispatch" });
  await expect(dispatch).toContainText("Courier");
  await expect(dispatch).toContainText("BD-77812");
  await expect(dispatch).toContainText("Ramesh (office manager)");
  await expect(dispatch).toContainText(`Also in this packet: ${doc.orig2.doc_code}`);
  // 12 (AC-24, approved 2026-10-31): Staff may undo a review; Undo dispatch stays Admin/Manager only.
  await expect(page.getByRole("button", { name: /Undo dispatch/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo review" })).toBeVisible();

  await signIn(page, u.manager.email, baseURL);
  await page.goto(`/documents/${doc.orig1.id}`);
  const review = page.getByRole("region", { name: "Review" });
  await expect(review.getByRole("list", { name: "Review history" })).toContainText("Test rdui-staff marked it reviewed");
  expect(await seriousAxe(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/07-document-panels.png`, fullPage: true });

  await page.getByRole("button", { name: /Undo dispatch/ }).click();
  const undo = page.getByRole("dialog", { name: /Undo dispatch/ });
  await undo.getByLabel("Reason").fill("Courier returned it");
  await undo.getByRole("button", { name: "Undo dispatch" }).click();
  await expect(page.getByRole("region", { name: "Dispatch" })).toContainText("Ready to dispatch");
  await expect(page.getByRole("region", { name: "Dispatch" })).toContainText("Courier returned it");
  await expect(page.getByRole("region", { name: "Dispatch" })).toContainText("Packet: 1 of 2 removed"); // AC-10

  await page.getByRole("button", { name: /Undo review/ }).click();
  const undoR = page.getByRole("dialog", { name: /Undo review/ });
  await undoR.getByLabel("Reason").fill("Reviewed the wrong copy");
  await undoR.getByRole("button", { name: "Undo review" }).click();
  await expect(page.getByTestId("review-state")).toHaveText("To review");
  await expect(review.getByRole("list", { name: "Review history" }).getByRole("listitem").first()).toContainText("undid the review — Reviewed the wrong copy");
  await noSidewaysScroll(page);
});

test("AC-4: a corrected file for a Needs-correction document asks when it arrived; that date replaces received on", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.goto(`/documents/${doc.soft.id}`);
  await expect(page.getByTestId("review-state")).toHaveText("Needs correction · Wrong account number");
  await page.getByLabel("Corrected file received on").fill("2026-07-20");
  await page.locator('input[type="file"]').setInputFiles({ name: "bank-jun-correct.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });
  await expect(page.getByText("New version saved.")).toBeVisible();
  await expect(page.getByTestId("review-state")).toHaveText("To review");
  const { data } = await adminClient().from("document").select("received_on, status").eq("id", doc.soft.id).single();
  expect(data).toEqual({ received_on: "2026-07-20", status: "received" });
  await expect(page.getByRole("list", { name: "Review history" })).toContainText("back to To review");
});

test("AC-14: /documents Status and Return filters round-trip through the URL as enums and rows show the state", async ({ page, baseURL }) => {
  await mustReview(await signedInClient(u.staff.email), doc.orig1.id); // the AC-13 test undid its review: make it ready again
  await signIn(page, u.staff.email, baseURL);
  await page.goto(`/documents?client=${clientId}&return=dispatched`);
  const results = page.getByRole("list", { name: "Documents" });
  // doc.sent (setup) + doc.orig2 (still in the AC-8 packet; only orig1 was taken out in the AC-13 test).
  await expect(results.getByRole("listitem")).toHaveCount(2);
  await expect(results.getByRole("listitem").filter({ hasText: doc.sent.doc_code })).toContainText("Dispatched 10 May · Hand delivery");
  await expect(results.getByRole("listitem").filter({ hasText: doc.orig2.doc_code })).toContainText("· Courier");
  await expect(page.getByRole("button", { name: "Remove filter Return: Dispatched" })).toBeVisible();

  await page.getByRole("combobox", { name: "Return" }).selectOption({ value: "ready" });
  await expect(page).toHaveURL(/return=ready/);
  await expect(results).toContainText(doc.orig1.doc_code);
  await page.getByRole("combobox", { name: "Return" }).selectOption({ value: "" });
  await page.getByRole("combobox", { name: "Status" }).selectOption({ value: "needs_correction" });
  await expect(page).toHaveURL(/status=needs_correction/);
  await expect(results.getByRole("listitem")).toHaveCount(1);
  await expect(results).toContainText("Needs correction · Statement is for the wrong account");
  expect(page.url()).not.toMatch(/wrong|account|Ramesh/i);
  expect(await seriousAxe(page)).toEqual([]);
});
