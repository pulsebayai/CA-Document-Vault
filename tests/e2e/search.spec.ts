import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, createSoftCopy, mustCreateDocument, typeId } from "../support/documents";
import { appAlert, signIn } from "./helpers";

// Feature 03b step 5 — header search (mockup 01 header; spec AC-1…AC-4, AC-11).

let staff: { id: string; email: string };
let limited: { id: string; email: string };
let clientId: string;
let classified: { id: string; doc_code: string };

test.beforeAll(async () => {
  const officeId = await createDocumentOffice("search-ui");
  staff = await createStaff(officeId, "search-ui-staff", "staff");
  limited = await createStaff(officeId, "search-ui-limited", "limited");
  const asStaff = await signedInClient(staff.email);
  const asLimited = await signedInClient(limited.email);
  const { data, error } = await asStaff.rpc("create_client", { p: { name: "Searchable Traders", client_type: "individual", incharge_id: staff.id } });
  if (error) throw error;
  clientId = data.id as string;
  // On a client the Limited user can't see (Staff is the incharge).
  classified = await createSoftCopy(asStaff, officeId, { client_id: clientId, doc_type_id: await typeId(officeId, "Form 16 from employer"), remark: "zeb annual salary" });
  await mustCreateDocument(asLimited, { remark: "zeb courier bag" });
});
test.afterAll(async () => { await retireStaff([staff?.id, limited?.id].filter(Boolean) as string[]); });
test.describe.configure({ mode: "serial" });

const box = (page: Page) => page.getByRole("combobox", { name: "Search clients and documents" });
const group = (page: Page, name: string) => page.getByRole("listbox", { name: "Search suggestions" }).getByRole("group", { name });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id);
}

test("AC-1, AC-2: \"/\" focuses the box; suggestions are grouped; arrow keys + Enter open a client", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("/");
  await expect(box(page)).toBeFocused();
  await expect(box(page)).toHaveAttribute("placeholder", "Search clients, documents, DOC id…");
  await page.keyboard.type("Searchable");
  await expect(group(page, "Clients").getByRole("option")).toHaveText(/^Searchable Traders · C\d{4}$/);
  await expect(page.getByRole("option", { name: /See all results for “Searchable”/ })).toBeVisible();
  expect(await seriousAxe(page)).toEqual([]);
  await page.keyboard.press("ArrowDown");
  await expect(box(page)).toHaveAttribute("aria-activedescendant", /.+/);
  await page.keyboard.press("Enter");
  await page.waitForURL(new RegExp(`/clients/${clientId}$`));
});

test("AC-2, AC-3: documents are suggested, and a typed DOC-ID opens the document", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await box(page).fill("zeb annual");
  await expect(group(page, "Documents").getByRole("option")).toContainText(`${classified.doc_code} · Form 16 from employer`);
  await box(page).fill(`  ${classified.doc_code.toLowerCase()} `);
  await box(page).press("Enter");
  await page.waitForURL(new RegExp(`/documents/${classified.id}$`));
});

test("AC-3: a DOC-ID the user can't open says so and stays put", async ({ page, baseURL }) => {
  await signIn(page, limited.email, baseURL);
  const before = page.url();
  await box(page).fill(classified.doc_code);
  await box(page).press("Enter");
  await expect(appAlert(page)).toHaveText(`No document ${classified.doc_code} that you can open`);
  expect(page.url()).toBe(before);
  await box(page).fill("zeb");
  await expect(group(page, "Documents").getByRole("option")).toHaveCount(1); // only the Inbox item Limited added
  await expect(group(page, "Documents").getByRole("option")).toContainText("Inbox");
});

test("AC-4, AC-11: Enter opens /documents; the text goes through session storage and never into any URL", async ({ page, baseURL }) => {
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  page.on("framenavigated", (f) => urls.push(f.url()));
  await signIn(page, staff.email, baseURL);
  await box(page).fill("zeb annual");
  await expect(group(page, "Documents").getByRole("option")).toHaveCount(1); // suggestions were requested
  await box(page).press("Enter");
  await page.waitForURL(/\/documents$/);
  expect(await page.evaluate(() => window.sessionStorage.getItem("cdv:documents-search-text"))).toBe("zeb annual");
  expect(urls.length).toBeGreaterThan(0);
  expect(urls.filter((u) => /zeb|annual/i.test(decodeURIComponent(u)))).toEqual([]);
});

test("AC-1: at 390 px the header fits and a Search button opens a full-width field", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, staff.email, baseURL);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(box(page)).toBeHidden();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(box(page)).toBeFocused();
  await page.keyboard.type("Searchable");
  await expect(group(page, "Clients").getByRole("option")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await seriousAxe(page)).toEqual([]);
  await page.getByRole("button", { name: "Close search" }).click();
  await expect(box(page)).toBeHidden();
});
