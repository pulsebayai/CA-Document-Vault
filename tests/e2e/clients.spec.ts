import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import "../support/setup-env";
import { adminClient, createStaff, retireStaff } from "../support/db";
import { createCatalogueOffice } from "../support/catalogue";
import { testPan } from "../support/test-data";
import { signIn } from "./helpers";

// Feature 02 step 7 — Clients list (spec AC-7, AC-12). Own is_test office, reset at the start of each run,
// so auth.spec's office keeps its "No clients yet" state.

let officeId: string;
let staff: { id: string; email: string };
let limited: { id: string; email: string };

test.beforeAll(async () => {
  officeId = await createCatalogueOffice("clients-list-ui");
  staff = await createStaff(officeId, "clients-staff", "staff");
  limited = await createStaff(officeId, "clients-limited", "limited");
  const rows = [
    { name: "Kaveri Textiles", client_type: "partnership", pan: testPan("F", 5101), previous_reference: "K-OLD-9", incharge_id: staff.id },
    { name: "Mylapore Stores", client_type: "proprietorship", pan: testPan("P", 5102), incharge_id: staff.id },
    { name: "Limited Co", client_type: "individual", incharge_id: limited.id },
    { name: "Archived Agency", client_type: "individual", incharge_id: staff.id, archived_at: new Date().toISOString() },
  ].map((r) => ({ office_id: officeId, ...r }));
  const { error } = await adminClient().from("client").insert(rows); // setup as the service role
  if (error) throw error;
});
test.afterAll(async () => { await retireStaff([staff?.id, limited?.id].filter(Boolean) as string[]); });

const list = (page: Page) => page.getByRole("list", { name: "Clients" });
const shown = async (page: Page) => (await list(page).getByRole("listitem").all()).length;

test("AC-7: search by name, PAN and previous reference, filter by type, show archived — nothing typed reaches the URL", async ({ page, baseURL }) => {
  const seen: string[] = [];
  page.on("request", (r) => seen.push(r.url()));
  page.on("framenavigated", (f) => seen.push(f.url()));

  await signIn(page, staff.email, baseURL);
  await expect(page.getByText("3 clients", { exact: true })).toBeVisible();
  await expect(list(page).getByRole("listitem")).toHaveCount(3);
  await expect(list(page).getByRole("listitem", { name: "Kaveri Textiles" })).toContainText("Partnership · ZZZFZ5101Z · Incharge Test clients-staff");

  const search = page.getByRole("searchbox", { name: "Search clients" });
  for (const term of ["kaveri", "fz510", "k-old"]) {
    await search.fill(term);
    await expect(list(page).getByRole("listitem")).toHaveCount(1);
    await expect(list(page).getByRole("listitem", { name: "Kaveri Textiles" })).toBeVisible();
  }
  await search.press("Enter"); // explicit submit must not navigate either

  await search.fill("");
  await page.getByRole("combobox", { name: "Type" }).selectOption("proprietorship");
  await expect(list(page).getByRole("listitem")).toHaveCount(1);
  await expect(list(page).getByRole("listitem", { name: "Mylapore Stores" })).toBeVisible();

  await page.getByRole("button", { name: "Clear" }).click();
  await expect(list(page).getByRole("listitem")).toHaveCount(3);
  await page.getByRole("checkbox", { name: "Show archived" }).check();
  await expect(list(page).getByRole("listitem")).toHaveCount(4);
  await expect(list(page).getByRole("listitem", { name: "Archived Agency" })).toContainText("Archived");

  await search.fill("no such client");
  await expect(page.getByText("No clients match")).toBeVisible();

  expect(page.url()).toMatch(/\/clients$/);
  for (const term of ["kaveri", "fz510", "k-old", "no such client", "no%20such", "proprietorship", "archived"]) {
    expect(seen.filter((u) => u.toLowerCase().includes(term))).toEqual([]);
  }

  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id)).toEqual([]);
  expect(await shown(page)).toBe(0);
});

test("AC-12: a Limited user lists only clients they are incharge of", async ({ page, baseURL }) => {
  await signIn(page, limited.email, baseURL);
  await expect(list(page).getByRole("listitem")).toHaveCount(1);
  await expect(list(page).getByRole("listitem", { name: "Limited Co" })).toBeVisible();
  await expect(page.getByText("1 client", { exact: true })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search clients" }).fill("kaveri");
  await expect(page.getByText("No clients match")).toBeVisible();
});
