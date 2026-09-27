import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import "../support/setup-env";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createCatalogueOffice } from "../support/catalogue";
import { testGstin, testPan } from "../support/test-data";
import { appAlert, signIn } from "./helpers";

// Feature 02 step 8 — Add / edit / archive a client (spec AC-8 … AC-11, AC-23).
// Own is_test office, reset to the seed at the start of every run (codes restart at C0001).

let officeId: string;
let staff: { id: string; email: string };
let manager: { id: string; email: string };
let editId: string;

test.beforeAll(async () => {
  officeId = await createCatalogueOffice("client-edit-ui");
  staff = await createStaff(officeId, "cedit-staff", "staff");
  manager = await createStaff(officeId, "cedit-manager", "manager");
  const asStaff = await signedInClient(staff.email);
  const { data, error } = await asStaff.rpc("create_client", { p: { name: "Edit Target", client_type: "individual", incharge_id: staff.id } });
  if (error) throw error;
  editId = data.id;
});
test.afterAll(async () => { await retireStaff([staff?.id, manager?.id].filter(Boolean) as string[]); });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id);
}

test("AC-8, AC-9, AC-23: staff adds a client with a GSTIN and a group; the vault assigns the code", async ({ page, baseURL }) => {
  const pan = testPan("P", 9101);
  await signIn(page, staff.email, baseURL);
  await page.getByRole("link", { name: "Add client" }).click();
  await expect(page).toHaveURL(/\/clients\/new$/);
  await expect(page.getByRole("heading", { name: "Add client" })).toBeVisible();

  // Nothing filled: inline errors, announced (role=alert summary), fields marked invalid.
  await page.getByRole("button", { name: "Add client" }).click();
  await expect(appAlert(page)).toContainText("Please fix the highlighted fields.");
  await expect(page.getByLabel("Name")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Enter the client's name.")).toBeVisible();

  await page.getByLabel("Name").fill("Adyar Agencies");
  await page.getByLabel("Client type").selectOption("proprietorship");
  await page.getByLabel("PAN").fill(testPan("C", 9101)); // 4th letter C = company: wrong for a proprietorship (AC-9)
  await page.getByRole("button", { name: "Add client" }).click();
  await expect(page.getByText("The PAN's 4th letter doesn't match this client type.")).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveValue("Adyar Agencies"); // a refused save keeps what was typed

  await page.getByLabel("PAN").fill(pan.toLowerCase());
  await page.getByLabel("Registration 1 number").fill(testGstin(pan, "33"));
  await expect(page.getByText("Tamil Nadu")).toBeVisible(); // state derived from the GSTIN
  await page.getByRole("checkbox", { name: "GST" }).check();
  expect(await seriousAxe(page)).toEqual([]);
  await page.getByRole("button", { name: "Add client" }).click();

  await expect(page).toHaveURL(/\/clients\/[0-9a-f-]{36}$/);
  expect(page.url()).not.toContain(pan);
  await expect(page.getByRole("heading", { name: "Adyar Agencies" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(/C\d{4}/);
  await expect(page.getByText(pan, { exact: true })).toBeVisible(); // PAN in the details card
  await expect(page.getByText("GST", { exact: true })).toBeVisible();
  expect(await seriousAxe(page)).toEqual([]);

  const id = page.url().split("/").pop()!;
  const { data: log } = await adminClient().from("activity").select("action, data").eq("entity_id", id);
  expect(log?.map((l) => l.action)).toEqual(["client.created"]);
  expect(JSON.stringify(log)).not.toContain(pan);
});

test("AC-10, AC-11: staff edit but can't change incharge or archive; a manager archives with a reason and unarchives", async ({ browser, baseURL }) => {
  const staffCtx = await browser.newContext();
  const sp = await staffCtx.newPage();
  await signIn(sp, staff.email, baseURL);
  await sp.goto(`/clients/${editId}`);
  await expect(sp.getByRole("heading", { name: "Edit Target" })).toBeVisible();
  await expect(sp.getByRole("button", { name: "Archive" })).toHaveCount(0);
  await sp.getByRole("link", { name: "Edit", exact: true }).click();
  await expect(sp.getByLabel("Incharge")).toBeDisabled();
  await sp.getByLabel("Email").fill("owner@example.test");
  await sp.getByRole("button", { name: "Save changes" }).click();
  await expect(sp).toHaveURL(new RegExp(`/clients/${editId}$`));
  await expect(sp.getByText("owner@example.test")).toBeVisible();
  await staffCtx.close();

  const mgrCtx = await browser.newContext();
  const mp = await mgrCtx.newPage();
  await signIn(mp, manager.email, baseURL);
  await mp.goto(`/clients/${editId}`);
  await mp.getByRole("button", { name: "Archive" }).click();
  const dialog = mp.getByRole("dialog", { name: "Archive Edit Target?" });
  await dialog.getByLabel("Reason").fill("Moved to another firm");
  await dialog.getByRole("button", { name: "Archive client" }).click();
  await expect(mp.getByRole("status")).toContainText("This client is archived");
  await expect(mp.getByRole("status")).toContainText("Moved to another firm");
  await expect(mp.getByRole("link", { name: "Edit", exact: true })).toHaveCount(0);
  await mp.getByRole("button", { name: "Unarchive" }).click();
  await expect(mp.getByRole("link", { name: "Edit", exact: true })).toBeVisible();
  await expect(mp.getByText("This client is archived")).toHaveCount(0);
  await mgrCtx.close();

  await expect.poll(async () => {
    const { data } = await adminClient().from("activity").select("action, data").eq("entity_id", editId).order("id");
    return data?.map((l) => l.action) ?? [];
  }).toEqual(["client.created", "client.updated", "client.archived", "client.unarchived"]);
  const { data: log } = await adminClient().from("activity").select("data").eq("entity_id", editId);
  expect(JSON.stringify(log)).not.toMatch(/owner@|Moved to another firm/);
});
