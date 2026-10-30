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
// Steps 9–10: a second client with 23 documents (incharge = someone else), for paging, Returnable and My clients.
let other: { id: string; email: string };
let manager: { id: string; email: string };
let busyId: string;
const busyDocs: { id: string; doc_code: string }[] = []; // busyDocs[i] received 2026-05-(i+1)
test.beforeAll(async () => {
  other = await createStaff(officeId, "if-other", "staff");
  manager = await createStaff(officeId, "if-manager", "manager");
  const as = await signedInClient(staff.email);
  const { data: c, error } = await as.rpc("create_client", { p: { name: "Busy Paging Traders", client_type: "individual", incharge_id: other.id } });
  if (error) throw error;
  busyId = c.id;
  const bank = await typeId(officeId, T.bank);
  const apr = await periodId(officeId, "2026-04");
  for (let i = 0; i < 23; i++) {
    busyDocs.push(await mustCreateDocument(as, {
      client_id: busyId, doc_type_id: bank, period_id: apr, received_as: "hard_copy", channel: "hand_delivery",
      received_on: `2026-05-${String(i + 1).padStart(2, "0")}`, ...(i === 4 ? { returnable: true } : {}),
    } as never));
  }
});
test.afterAll(async () => { await retireStaff([staff?.id, other?.id, manager?.id].filter(Boolean) as string[]); });
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

// Step 8 — Needs correction kinds (spec AC-21 … AC-23).
test("AC-21, AC-22: Wrong file offers Upload corrected file first", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/clients/${clientId}`);
  const row = page.getByRole("listitem").filter({ hasText: docs.paper.doc_code });
  await row.getByRole("button", { name: new RegExp(`^Needs correction: .*${docs.paper.doc_code}`) }).click();
  const dialog = page.getByRole("dialog", { name: /Needs correction/ });
  await dialog.getByLabel("Reason").fill("Unsigned copy");
  await dialog.getByRole("button", { name: "Mark needs correction" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Choose wrong file or wrong details.");
  await dialog.getByRole("radio", { name: /Wrong file/ }).check();
  await dialog.getByRole("button", { name: "Mark needs correction" }).click();
  await expect(row).toContainText("Needs correction · wrong file · Unsigned copy");
  await page.goto(`/documents/${docs.paper.id}`);
  const actions = page.getByTestId("correction-actions");
  await expect(actions.getByRole("link")).toHaveText(["Upload corrected file", "Edit details"]);
});

test("AC-22, AC-23: Wrong details → Edit details → a changed received-on date sends it back to To review", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/documents/${docs.wrong.id}`);
  const actions = page.getByTestId("correction-actions");
  await expect(actions.getByRole("link")).toHaveText(["Edit details", "Upload corrected file"]);
  await actions.getByRole("link", { name: "Edit details" }).click();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeEnabled(); // form is interactive
  await page.getByLabel("Received on").fill("2026-05-01");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(new RegExp(`/documents/${docs.wrong.id}\\?saved=`));
  await expect(page.getByTestId("review-state")).toHaveText("To review");
  await expect(page.getByRole("list", { name: "Review history" })).toContainText("changed it — back to To review");
});

// Step 9 — lists (spec AC-25, AC-26, AC-13).
test("AC-25: /documents shows 20 per page with N–M of T", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/documents?client=${busyId}`);
  const results = page.getByRole("list", { name: "Documents" }).getByRole("listitem");
  await expect(results).toHaveCount(20);
  const pages = page.getByRole("navigation", { name: "Pages" });
  await expect(pages).toContainText("1–20 of 23");
  await pages.getByRole("button", { name: "Next" }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(results).toHaveCount(3);
  await expect(pages).toContainText("21–23 of 23");
});

test("AC-13: the Returnable filter lists returnable hard copies only, as a URL flag", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/documents?client=${busyId}`);
  await page.getByRole("checkbox", { name: "Returnable only" }).click(); // ticks once the URL changes (filters are the URL)
  await expect(page).toHaveURL(/returnable=1/);
  const results = page.getByRole("list", { name: "Documents" }).getByRole("listitem");
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText(busyDocs[4].doc_code);
  await expect(page.getByRole("button", { name: "Remove filter Returnable: Yes" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Returnable only" })).toBeChecked();
});

test("AC-26: Client › Documents pages each card by 20, newest received first", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/clients/${busyId}`);
  const banking = page.getByRole("list", { name: "Banking documents" }).getByRole("listitem");
  await expect(banking).toHaveCount(20);
  await expect(banking.first()).toContainText(busyDocs[22].doc_code); // received 23 May
  const pager = page.getByRole("navigation", { name: "Banking pages" });
  await expect(pager).toContainText("1–20 of 23");
  await pager.getByRole("button", { name: "Next" }).click();
  await expect(banking).toHaveCount(3);
  await expect(banking.last()).toContainText(busyDocs[0].doc_code); // received 1 May
  await expect(pager).toContainText("21–23 of 23");
  expect(await seriousAxe(page)).toEqual([]);
});

// Step 10 — My clients (spec AC-27).
test("AC-27: My clients is on by default for Staff; off shows every client and is kept in the URL", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto("/clients");
  const toggle = page.getByRole("button", { name: "My clients" });
  const list = page.getByRole("list", { name: "Clients" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(list).toContainText("Intake Fixes Traders");
  await expect(list).not.toContainText("Busy Paging Traders");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page).toHaveURL(/\/clients\?mine=0$/);
  await expect(list).toContainText("Busy Paging Traders");
  await page.reload();
  await expect(page.getByRole("button", { name: "My clients" })).toHaveAttribute("aria-pressed", "false");
  await expect(list).toContainText("Busy Paging Traders");
  // Access never changes: the other staff member's client still opens by link.
  await page.goto(`/clients/${busyId}`);
  await expect(page.getByRole("heading", { name: "Busy Paging Traders" })).toBeVisible();
});

test("AC-27: My clients is off by default for a Manager", async ({ page, baseURL }) => {
  await signIn(page, manager.email, baseURL);
  await page.goto("/clients");
  await expect(page.getByRole("button", { name: "My clients" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("list", { name: "Clients" })).toContainText("Busy Paging Traders");
});
