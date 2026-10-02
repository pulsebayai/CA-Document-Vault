import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, createSoftCopy, mustCreateDocument, mustReview, periodId, typeId } from "../support/documents";
import { T } from "../support/expected";
import { signIn } from "./helpers";

// Feature 08 step 4 — bulk select on /documents and Client › Documents (AC-1), the browser-built zip (AC-2: real
// download, unzipped here) and bulk Mark reviewed (AC-3); axe with the bar and dialogs open, ≤ 390 px, screenshots.

const SHOTS = "test-results/screenshots";
let officeId: string;
let staff: { id: string; email: string };
let clientId: string;
const soft: Array<{ id: string; doc_code: string }> = [];
let hard: { id: string; doc_code: string };
let done: { id: string; doc_code: string };

test.beforeAll(async () => {
  test.setTimeout(180_000);
  officeId = await createDocumentOffice("bulk-ui");
  staff = await createStaff(officeId, "bkui-staff", "staff");
  const as = await signedInClient(staff.email);
  const { data, error } = await as.rpc("create_client", { p: { name: "Bulk UI Client", client_type: "individual", incharge_id: staff.id } });
  if (error) throw error;
  clientId = data.id;
  const bank = await typeId(officeId, T.bank);
  for (const m of ["2026-06", "2026-07", "2026-08"]) {
    soft.push(await createSoftCopy(as, officeId, { client_id: clientId, doc_type_id: bank, period_id: await periodId(officeId, m), received_on: "2026-09-02" }));
  }
  hard = await mustCreateDocument(as, { client_id: clientId, doc_type_id: bank, period_id: await periodId(officeId, "2026-05"), received_as: "hard_copy", received_on: "2026-09-02" });
  done = await mustCreateDocument(as, { client_id: clientId, doc_type_id: bank, period_id: await periodId(officeId, "2026-04"), received_as: "hard_copy", received_on: "2026-09-02" });
  await mustReview(as, done.id);
});
test.afterAll(async () => { await retireStaff([staff?.id].filter(Boolean) as string[]); });
test.describe.configure({ mode: "serial" });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id);
}

/** Entry names in a zip's central directory. */
function zipNames(b: Buffer): string[] {
  const out: string[] = [];
  for (let i = 0; i < b.length - 46; i++) {
    if (b.readUInt32LE(i) !== 0x02014b50) continue;
    const len = b.readUInt16LE(i + 28);
    out.push(b.subarray(i + 46, i + 46 + len).toString("utf8"));
    i += 45 + len;
  }
  return out.sort();
}

test("AC-1, AC-2: select on /documents, download a zip of the files; the selection is per page", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/documents?client=${clientId}`);
  await page.getByRole("checkbox", { name: `Select ${soft[0].doc_code}` }).check();
  await page.getByRole("checkbox", { name: `Select ${soft[1].doc_code}` }).check();
  await page.getByRole("checkbox", { name: `Select ${hard.doc_code}` }).check(); // no file: listed as missing
  await expect(page.getByRole("status").filter({ hasText: "selected" })).toHaveText("3 selected");
  expect(await seriousAxe(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/08-documents-selected.png`, fullPage: true });

  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download zip/ }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^vault-documents-\d{4}-\d{2}-\d{2}\.zip$/);
  const names = zipNames(await readFile((await download.path())!));
  expect(names).toEqual([`${soft[0].doc_code} statement.pdf`, `${soft[1].doc_code} statement.pdf`].sort());
  const dialog = page.getByRole("dialog", { name: "Download zip" });
  await expect(dialog.getByRole("status")).toHaveText("Saved 2 files · 1 failed");
  await expect(dialog.getByRole("list", { name: "Files not in the zip" })).toHaveText(`${hard.doc_code} — no file`);
  expect(await seriousAxe(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Done" }).click();

  // Per page (D2): a filter change empties the selection.
  await page.getByRole("checkbox", { name: "Select all on this page" }).check();
  await expect(page.getByRole("status").filter({ hasText: "selected" })).toHaveText("5 selected");
  await page.getByLabel("Received as").selectOption("hard_copy");
  await expect(page.getByRole("checkbox", { name: "Select all on this page" })).not.toBeChecked();
  await expect(page.getByRole("button", { name: /Download zip/ })).toHaveCount(0);
});

test("AC-1, AC-3: Client › Documents select all → Mark reviewed → result; ≤ 390 px", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/clients/${clientId}?tab=documents`);
  await page.getByRole("checkbox", { name: "Select all on this page" }).check();
  await expect(page.getByRole("status").filter({ hasText: "selected" })).toHaveText("5 selected");
  await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Mark reviewed" });
  await expect(dialog).toContainText("Mark 4 documents reviewed? 1 will be skipped (already reviewed).");
  expect(await seriousAxe(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/08-bulk-review-confirm.png`, fullPage: true });
  await dialog.getByRole("button", { name: "Mark 4 documents reviewed" }).click();
  await expect(dialog.getByRole("status")).toHaveText("4 reviewed · 1 skipped");
  await expect(dialog.getByRole("list", { name: "Skipped documents" })).toHaveText(`${done.doc_code} — already reviewed`);
  await dialog.getByRole("button", { name: "Done" }).click();
  for (const d of [...soft, hard]) {
    await expect(page.getByRole("listitem").filter({ hasText: d.doc_code }).getByTestId("doc-state")).toContainText(/^Reviewed/);
  }

  await page.getByRole("checkbox", { name: `Select ${hard.doc_code}` }).check();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${SHOTS}/08-client-documents-390.png`, fullPage: true });
});
