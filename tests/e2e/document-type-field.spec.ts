import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { groupId } from "../support/catalogue";
import { createDocumentOffice, mustCreateDocument, mustReview, periodId, typeId } from "../support/documents";
import { T } from "../support/expected";
import { testGstin, testPan } from "../support/test-data";
import { signIn } from "./helpers";

// Feature 12 — the type-ahead Document type field (spec AC-1 … AC-6, D4) and the Edit "Moves from … to …" line
// (AC-20). Matching itself is unit-tested (type-match, type-combobox); this proves it in the real form: plan types
// grouped first, aliases, keyboard, Esc, the propose row, axe with the list open, and 390 px.

let officeId: string;
let staff: { id: string; email: string };
let clientId: string;
let moved: { id: string; doc_code: string };

test.beforeAll(async () => {
  officeId = await createDocumentOffice("type-field");
  staff = await createStaff(officeId, "tf-staff", "staff");
  const as = await signedInClient(staff.email);
  const pan = testPan("P", 7121);
  const { data, error } = await as.rpc("create_client", { p: {
    name: "Type Field Traders", client_type: "proprietorship", pan, incharge_id: staff.id,
    registrations: [{ kind: "gstin", number: testGstin(pan) }], group_ids: [await groupId(officeId, "GST")],
  } });
  if (error) throw error;
  clientId = data.id;
  // A reviewed Bank statement (Banking, not in the plan) to move in the AC-20 test.
  moved = await mustCreateDocument(as, { client_id: clientId, doc_type_id: await typeId(officeId, T.bank),
    period_id: await periodId(officeId, "2026-04"), received_as: "hard_copy", channel: "hand_delivery" });
  await mustReview(as, moved.id);
});
test.afterAll(async () => { if (staff) await retireStaff([staff.id]); });
test.describe.configure({ mode: "serial" });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id);
}
const field = (page: Page) => page.getByRole("combobox", { name: "Document type" });
const list = (page: Page) => page.getByRole("listbox", { name: "Matching types" });

async function openAddDocument(page: Page) {
  await page.goto(`/documents/new?client=${clientId}`);
  await expect(page.getByRole("button", { name: "Save as untagged" })).toBeEnabled(); // form is interactive
}

test("AC-1, AC-4: an empty field lists the client's plan types under group headings; axe with the list open", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await openAddDocument(page);
  await field(page).click();
  await expect(field(page)).toHaveAttribute("aria-expanded", "true");
  await expect(list(page).getByRole("group", { name: "GST" })).toBeVisible();
  await expect(list(page).getByRole("group", { name: "Not in existing category plan" })).toHaveCount(0); // plan only
  await expect(list(page).getByRole("option", { name: new RegExp(`^${T.sales.replace(/[/]/g, "\\/")}.*Monthly`) })).toBeVisible();
  expect(await seriousAxe(page)).toEqual([]);
});

test("AC-2, AC-3: typing matches aliases; other types follow under 'Not in existing category plan'", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await openAddDocument(page);
  await field(page).fill("form 130");
  const other = list(page).getByRole("group", { name: "Not in existing category plan" });
  await expect(other.getByRole("option", { name: /^Form 16 from employer.*Income Tax/ })).toBeVisible();
});

test("AC-4, AC-6: keyboard pick shows the group line; Esc restores the last pick", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await openAddDocument(page);
  await field(page).fill("sales invoices");
  await page.keyboard.press("ArrowDown");
  await expect(field(page)).toHaveAttribute("aria-activedescendant", /.+/);
  await page.keyboard.press("Enter");
  await expect(field(page)).toHaveValue(T.sales);
  await expect(field(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("set from the type")).toContainText("GST");
  await field(page).fill("bank");
  await page.keyboard.press("Escape");
  await expect(field(page)).toHaveValue(T.sales);
});

test("AC-5: no match offers '+ Propose a new type…', which opens the new-type step with the typed name", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await openAddDocument(page);
  await field(page).fill("Zzq crypto ledger");
  await expect(page.getByText("No matching type", { exact: true })).toHaveCount(0); // Staff with a client: the propose row instead
  await list(page).getByRole("option", { name: /Propose a new type/ }).click();
  await expect(page.getByLabel("New type name")).toHaveValue("Zzq crypto ledger");
});

test("AC-4: the field and its open list fit a 390 px screen", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  await openAddDocument(page);
  await field(page).fill("gst");
  await expect(list(page).getByRole("option").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("AC-20: Edit says where the document moves and that its review resets", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/documents/${moved.id}/assign`);
  await expect(page.getByRole("button", { name: "Save changes" })).toBeEnabled(); // form is interactive
  await expect(page.getByText(/^Moves from/)).toHaveCount(0); // nothing changed yet
  await field(page).fill("sales invoices");
  await list(page).getByRole("option", { name: new RegExp(`^${T.sales.replace(/[/]/g, "\\/")}`) }).click();
  const line = page.getByRole("status").filter({ hasText: "Moves from" });
  await expect(line).toContainText(`Moves from Banking › ${T.bank} to GST › ${T.sales}.`);
  await expect(line).toContainText("Review will reset to To review.");
});
