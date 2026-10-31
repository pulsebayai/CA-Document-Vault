import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, mustCreateDocument, mustReview, periodId, typeId } from "../support/documents";
import { T } from "../support/expected";
import { signIn } from "./helpers";

// Feature 13 — hard-copy custody on screen (spec AC-4, AC-6, AC-9, AC-11, AC-12).
//   Document page: Mark in office → Ready to dispatch → dispatch → (manager) undo dispatch → Ready again; Undo steps.
//   Client › Documents row: Mark in office. /documents: bulk Mark in office + the Custody filter. Today: To place count.

let officeId: string;
let staff: { id: string; email: string };
let manager: { id: string; email: string };
let clientId: string;
const doc = {} as Record<"ret" | "plain" | "bulk1" | "bulk2", { id: string; doc_code: string }>;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  officeId = await createDocumentOffice("custody-ui");
  staff = await createStaff(officeId, "cui-staff", "staff");
  manager = await createStaff(officeId, "cui-manager", "manager");
  const as = await signedInClient(staff.email);
  const { data: c, error } = await as.rpc("create_client", { p: { name: "Custody Traders", client_type: "individual", incharge_id: staff.id } });
  if (error) throw error;
  clientId = c.id;
  const bank = await typeId(officeId, T.bank);
  const mk = async (period: string, extra: Record<string, unknown> = {}) => {
    const d = await mustCreateDocument(as, { client_id: clientId, doc_type_id: bank, period_id: await periodId(officeId, period),
      received_as: "hard_copy", received_on: "2026-05-02", ...extra } as never);
    await mustReview(as, d.id);
    return d;
  };
  doc.ret = await mk("2026-04", { returnable: true });
  doc.plain = await mk("2026-05"); // FY 2026-27: the client page opens on the current FY
  doc.bulk1 = await mk("2026-02");
  doc.bulk2 = await mk("2026-01");
});
test.afterAll(async () => { await retireStaff([staff?.id, manager?.id].filter(Boolean) as string[]); });
test.describe.configure({ mode: "serial" });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id);
}
const custody = (page: Page) => page.getByRole("region", { name: "Custody" });

test("AC-9, AC-6: document page — Mark in office, Ready to dispatch, dispatch; undo dispatch keeps Ready; axe", async ({ page, baseURL }) => {
  test.setTimeout(120_000); // two sign-ins and a dispatch
  await signIn(page, staff.email, baseURL);
  await page.goto(`/documents/${doc.ret.id}`);
  await expect(page.getByTestId("custody-state")).toHaveText("Not in office yet");
  await custody(page).getByRole("button", { name: /^Mark in office:/ }).click();
  await expect(custody(page).getByRole("status")).toHaveText("Marked in office.");
  await expect(page.getByTestId("custody-state")).toContainText(/Document in office since .* by Test cui-staff/);
  await expect(page.getByRole("region", { name: "Dispatch" })).toContainText("Not ready yet");
  await custody(page).getByRole("button", { name: /^Ready to dispatch:/ }).click();
  await expect(page.getByTestId("custody-state")).toContainText("Ready to dispatch since");
  await expect(page.getByRole("region", { name: "Dispatch" })).toContainText("Ready to dispatch — this original still needs to go back");
  expect(await seriousAxe(page)).toEqual([]);

  await page.getByRole("region", { name: "Dispatch" }).getByRole("button", { name: /Mark dispatched/ }).click();
  const dialog = page.getByRole("dialog", { name: "Mark originals dispatched" });
  await dialog.getByLabel("Recipient").fill("Client's accountant");
  await dialog.getByRole("button", { name: "Mark 1 dispatched" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("region", { name: "Dispatch" })).toContainText("Dispatched");
  await expect(custody(page).getByRole("button", { name: /^Undo/ })).toHaveCount(0);
  await expect(custody(page)).toContainText("In a dispatch packet");

  await signIn(page, manager.email, baseURL);
  await page.goto(`/documents/${doc.ret.id}`);
  await page.getByRole("button", { name: /Undo dispatch/ }).click();
  const undo = page.getByRole("dialog", { name: /Undo dispatch/ });
  await undo.getByLabel("Reason").fill("Client asked us to hold it");
  await undo.getByRole("button", { name: "Undo dispatch" }).click();
  await expect(page.getByRole("region", { name: "Dispatch" })).toContainText("Ready to dispatch — this original");
  await expect(page.getByTestId("custody-state")).toContainText("Ready to dispatch since");
});

test("AC-4, S3: Undo steps back one step at a time, with no reason asked", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/documents/${doc.ret.id}`);
  await custody(page).getByRole("button", { name: /^Undo Ready to dispatch/ }).click();
  await expect(custody(page).getByRole("status")).toHaveText("Back to Document in office.");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await custody(page).getByRole("button", { name: /^Undo Document in office/ }).click();
  await expect(page.getByTestId("custody-state")).toHaveText("Not in office yet");
});

test("AC-9: a Client › Documents row offers Mark in office; a plain hard copy then shows Document in office", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/clients/${clientId}`);
  const row = page.getByRole("listitem").filter({ hasText: doc.plain.doc_code });
  await row.getByRole("button", { name: /^Mark in office:/ }).click();
  await expect(row.getByRole("status")).toHaveText("Marked in office.");
  await expect(row.getByTestId("doc-state")).toHaveText("Document in office");
  await expect(row.getByRole("button", { name: /Mark in office|Ready to dispatch/ })).toHaveCount(0);
});

test("AC-9, AC-12: /documents bulk Mark in office skips what doesn't qualify; the Custody filter lists them", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/documents?client=${clientId}&return=to_place`);
  const results = page.getByRole("list", { name: "Documents" });
  await expect(results.getByRole("listitem")).toHaveCount(3); // ret (undone above), bulk1, bulk2
  await page.goto(`/documents?client=${clientId}`);
  for (const d of [doc.bulk1, doc.bulk2, doc.plain]) await page.getByRole("checkbox", { name: `Select ${d.doc_code}` }).check();
  await page.getByRole("button", { name: "Mark in office", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Mark in office" });
  await dialog.getByRole("button", { name: "Mark in office: 3 documents" }).click();
  await expect(dialog.getByRole("status")).toHaveText("2 marked in office · 1 skipped");
  await expect(dialog.getByRole("list", { name: "Skipped documents" })).toContainText(`${doc.plain.doc_code} — already done`);
  await dialog.getByRole("button", { name: "Done" }).click();
  await page.getByRole("combobox", { name: "Custody" }).selectOption({ value: "in_office" });
  await expect(page).toHaveURL(/return=in_office/);
  await expect(results.getByRole("listitem")).toHaveCount(3);
  expect(await seriousAxe(page)).toEqual([]);
});

test("AC-11: Today counts To place in office and opens its rows with Mark in office", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto("/today");
  const count = page.getByRole("button", { name: "1 To place in office" });
  await expect(count).toBeVisible();
  await count.click();
  await expect(page).toHaveURL(/show=to_place/);
  const rows = page.getByRole("list", { name: "Open documents for Custody Traders" });
  await expect(rows.getByRole("listitem")).toHaveCount(1);
  await rows.getByRole("button", { name: /^Mark in office:/ }).click();
  await expect(page.getByRole("button", { name: "0 To place in office" })).toBeVisible();
  const { data } = await adminClient().from("document").select("custody").eq("id", doc.ret.id).single();
  expect(data).toEqual({ custody: "in_office" });
});
