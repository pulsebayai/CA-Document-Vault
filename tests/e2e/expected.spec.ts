import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { groupId } from "../support/catalogue";
import { createDocumentOffice, TINY } from "../support/documents";
import { T, expectedFor, expectedItem, generateAsOf } from "../support/expected";
import { testGstin, testPan } from "../support/test-data";
import { istDate } from "@/lib/documents/period";
import { shortDate } from "@/lib/expected/schedule";
import { signIn } from "./helpers";

// Feature 04 step 5 — Client › Expected (spec AC-13) with Waive (AC-9), Undo (AC-10), Reopen (AC-11) and
// Upload → Add document pre-filled → linked on save (AC-8). Own is_test office, reset every run.
//
// Test clock (D1): groups are enabled on 2026-06-01 (start = May 2026 for monthly rows), items generated as of
// 2026-07-04. The client has two GSTINs, so per-GSTIN rows show the GSTIN and Upload must carry the registration.
//   Sales (+1/5): May → Overdue · 30 days late · Jun → Due today (due by 4 Jul) — per GSTIN
//   Bank statement (+1/7): May → Overdue · 28 days late · Jun → Due 6 Jul
const TODAY = "2026-07-04";
let officeId: string;
const u = {} as Record<"admin" | "manager" | "staff" | "limited", { id: string; email: string }>;
let clientId: string;
let g1: string; // GSTIN numbers
let g2: string;
let g1Id: string;

test.beforeAll(async () => {
  test.setTimeout(120_000); // office reset + 4 fixture users + 2 generation runs, US runner → Mumbai DB
  officeId = await createDocumentOffice("expected-ui");
  u.admin = await createStaff(officeId, "expui-admin", "admin");
  u.manager = await createStaff(officeId, "expui-manager", "manager");
  u.staff = await createStaff(officeId, "expui-staff", "staff");
  u.limited = await createStaff(officeId, "expui-limited", "limited");
  const asAdmin = await signedInClient(u.admin.email);
  await generateAsOf(asAdmin, "2026-06-01"); // sets the office clock before the plan exists
  const pan = testPan("P", 7401);
  g1 = testGstin(pan, "33", 1);
  g2 = testGstin(pan, "29", 2);
  const asStaff = await signedInClient(u.staff.email);
  const { data, error } = await asStaff.rpc("create_client", { p: {
    name: "Expected Traders", client_type: "proprietorship", pan, incharge_id: u.limited.id, // Limited can see it
    registrations: [{ kind: "gstin", number: g1 }, { kind: "gstin", number: g2 }],
    group_ids: [await groupId(officeId, "GST"), await groupId(officeId, "Banking")],
  } });
  if (error) throw error;
  clientId = data.id;
  await generateAsOf(asAdmin, TODAY);
  const { data: regs } = await asStaff.from("client_registration").select("id, number").eq("client_id", clientId);
  g1Id = regs!.find((r) => r.number === g1)!.id;
});
test.afterAll(async () => { await retireStaff(Object.values(u).map((x) => x.id)); });
test.describe.configure({ mode: "serial" });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id);
}
const openCount = async () => (await expectedFor(clientId)).filter((e) => e.status === "pending").length;
const row = (page: Page, group: string, label: string) =>
  page.getByRole("list", { name: `${group} expected documents` }).getByRole("listitem").filter({ hasText: label });
const tab = (page: Page) => page.getByRole("navigation", { name: "Client sections" }).getByRole("link", { name: /^Expected/ });

test("AC-13: Expected tab — count, states as text, GSTIN shown when the client has two; axe; 390 px", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.goto(`/clients/${clientId}`);
  await expect(tab(page)).toHaveText(new RegExp(`Expected\\s*${await openCount()}$`));
  await tab(page).click();
  await expect(tab(page)).toHaveAttribute("aria-current", "page");
  await expect(page.getByLabel("Financial year").locator("option:checked")).toHaveText("FY 2026-27");

  await expect(row(page, "GST", `${T.sales} · May 2026 · ${g1}`)).toContainText("Overdue · 30 days late");
  await expect(row(page, "GST", `${T.sales} · Jun 2026 · ${g2}`)).toContainText("Due today");
  await expect(row(page, "Banking", `${T.bank} · May 2026`)).toContainText("Overdue · 28 days late");
  await expect(row(page, "Banking", `${T.bank} · Jun 2026`)).toContainText("Due 6 Jul");
  expect(await seriousAxe(page)).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("AC-9: Staff marks an item not needed with a reason (required); it leaves Open and the count", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  const before = await openCount();
  await page.goto(`/clients/${clientId}?tab=expected`);
  const label = `${T.bank} · May 2026`;
  await page.getByRole("button", { name: `Waive ${label}` }).click();
  const dialog = page.getByRole("dialog", { name: `Not needed for ${label}?` });
  await dialog.getByRole("button", { name: "Mark not needed" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Please give a reason");
  await dialog.getByLabel("Reason").fill("Account closed in April");
  await dialog.getByRole("button", { name: "Mark not needed" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Marked not needed." })).toBeVisible();
  await expect(row(page, "Banking", label)).toHaveCount(0);
  await expect(tab(page)).toHaveText(new RegExp(`Expected\\s*${before - 1}$`));

  await page.getByLabel("Status").selectOption("Not needed");
  await expect(row(page, "Banking", label)).toContainText("Not needed · Account closed in April");
  await expect(row(page, "Banking", label)).toContainText("Test expui-staff, "); // who and when
  await expect(row(page, "Banking", label).getByRole("button", { name: /^Undo/ })).toHaveCount(0); // Staff can't undo (AC-10)
});

test("AC-9: a Limited user sees the client's items but can't mark them not needed", async ({ page, baseURL }) => {
  await signIn(page, u.limited.email, baseURL);
  await page.goto(`/clients/${clientId}?tab=expected`);
  await expect(row(page, "Banking", `${T.bank} · Jun 2026`)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Waive/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: `Upload ${T.bank} · Jun 2026` })).toBeVisible();
});

test("AC-10: a Manager undoes “Not needed”; the item is open again", async ({ page, baseURL }) => {
  await signIn(page, u.manager.email, baseURL);
  await page.goto(`/clients/${clientId}?tab=expected`);
  await page.getByLabel("Status").selectOption("Not needed");
  const label = `${T.bank} · May 2026`;
  await row(page, "Banking", label).getByRole("button", { name: `Undo not needed for ${label}` }).click();
  await expect(page.getByRole("status").filter({ hasText: "“Not needed” undone." })).toBeVisible();
  await page.getByLabel("Status").selectOption("Open");
  await expect(row(page, "Banking", label)).toContainText("Overdue · 28 days late");
});

test("AC-8 + AC-11: Upload pre-fills Add document (0 choices); saving links it → Received; Reopen → open again", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.goto(`/clients/${clientId}?tab=expected`);
  const label = `${T.sales} · Jun 2026 · ${g1}`;
  await page.getByRole("link", { name: `Upload ${label}` }).click();
  await expect(page.getByRole("heading", { name: "Add document" })).toBeVisible();
  await expect(page.getByText("Expected Traders")).toBeVisible();
  await expect(page.getByLabel("Document type").locator("option:checked")).toHaveText(new RegExp(`^${T.sales.replace(/[/]/g, "\\/")}`));
  await expect(page.getByRole("radio", { name: "Month" })).toBeChecked();
  await expect(page.getByRole("combobox", { name: "Month" }).locator("option:checked")).toHaveText("Jun 2026");
  await expect(page.getByLabel("GSTIN")).toHaveValue(g1Id);

  await page.locator('input[type="file"]').setInputFiles({ name: "Jun-2026-sales.pdf", mimeType: "application/pdf", buffer: TINY.pdf.bytes });
  await expect(page.getByText("Uploaded", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save to vault" }).click();

  await page.waitForURL(new RegExp(`/clients/${clientId}\\?tab=expected&saved=`));
  await expect(page.getByRole("status").filter({ hasText: "saved" })).toContainText(/DOC-FY\d{2}-\d{2}-\d{5}/);
  await expect(row(page, "GST", label)).toHaveCount(0); // no longer open
  const item = await expectedItem(clientId, T.sales, "2026-06", g1Id);
  expect(item.status).toBe("received");

  await page.getByLabel("Status").selectOption("Received");
  await expect(row(page, "GST", label)).toContainText(`Received ${shortDate(istDate(), TODAY)}`);
  await row(page, "GST", label).getByRole("button", { name: `Reopen ${label}` }).click();
  await row(page, "GST", label).getByRole("button", { name: "Reopen", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Reopened." })).toBeVisible();
  await page.getByLabel("Status").selectOption("Open");
  await expect(row(page, "GST", label)).toContainText("Due today");
  expect((await expectedItem(clientId, T.sales, "2026-06", g1Id)).status).toBe("pending");
});
