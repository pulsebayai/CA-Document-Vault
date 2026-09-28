import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import "../support/setup-env";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createCatalogueOffice } from "../support/catalogue";
import { testGstin, testPan } from "../support/test-data";
import { appAlert, signIn } from "./helpers";

// Feature 02 step 10 — Clients › Import CSV (spec AC-13 … AC-16). Own is_test office, reset to the seed at
// the start of every run, so codes restart at C0001 and the existing-PAN duplicate is always C0001.

let officeId: string;
let staff: { id: string; email: string };
const existingPan = testPan("P", 7001);

test.beforeAll(async () => {
  officeId = await createCatalogueOffice("import-ui");
  staff = await createStaff(officeId, "import-staff", "staff");
  const asStaff = await signedInClient(staff.email);
  const { error } = await asStaff.rpc("create_client", { p: { name: "Existing Client", client_type: "individual", pan: existingPan, incharge_id: staff.id } });
  if (error) throw error;
});
test.afterAll(async () => { await retireStaff([staff?.id].filter(Boolean) as string[]); });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id);
}

async function downloadText(page: Page, button: string) {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: button }).click()]);
  return readFile((await dl.path())!, "utf8");
}

const upload = (page: Page, csv: string, name = "clients.csv") =>
  page.getByLabel("CSV file").setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });

test("AC-13…16: template, preview with errors and duplicates, import, error file round trip", async ({ page, baseURL }) => {
  const panA = testPan("F", 7002);
  const inchargeEmail = staff.email;
  const header = "name,client_type,pan,previous_reference,email,mobile,incharge_email,gstins,tans,groups";
  const csv = [
    header,
    `Anna Nagar Traders,Partnership firm,${panA},OLD-1,accounts@example.test,+91 98450 12345,${inchargeEmail},${testGstin(panA)},,GST`, // row 2 valid
    `Besant Stores,proprietorship,,,,,${inchargeEmail},,,`,                                                          // row 3 valid, no PAN
    `Existing Again,individual,${existingPan},,,,${inchargeEmail},,,`,                                               // row 4 duplicate (DB)
    `Chetpet Co,individual,,,not-an-email,,${inchargeEmail},,,`,                                                     // row 5 error
    `Anna Nagar Copy,partnership,${panA},,,,${inchargeEmail},,,`,                                                    // row 6 duplicate (file)
    `Dindigul Agencies,individual,,,,,nobody@example.test,,,`,                                                       // row 7 error
  ].join("\n");

  await signIn(page, staff.email, baseURL);
  const seen: string[] = [];
  page.on("request", (r) => seen.push(r.url()));
  page.on("framenavigated", (f) => seen.push(f.url()));
  await page.getByRole("link", { name: "Import CSV" }).click();
  await expect(page).toHaveURL(/\/clients\/import$/);
  await expect(page.getByRole("heading", { name: "Import clients" })).toBeVisible();
  expect(await seriousAxe(page)).toEqual([]);

  // AC-13: template
  const template = await downloadText(page, "Download template");
  expect(template.split(/\r?\n/)[0]).toBe(header);
  expect(template.trim().split(/\r?\n/)).toHaveLength(2);

  // AC-14: bad header → plain message, nothing else happens
  await upload(page, "name,type\nA,individual\n");
  await expect(appAlert(page)).toContainText("header row doesn't match");

  // AC-14/15: preview — nothing written yet
  const before = (await adminClient().from("client").select("id", { count: "exact", head: true }).eq("office_id", officeId)).count;
  await upload(page, csv);
  await expect(page.getByRole("heading", { name: /Preview/ })).toBeVisible();
  const summary = page.getByLabel("Import summary");
  await expect(summary).toContainText("Rows in file6");
  await expect(summary).toContainText("Ready to import2");
  await expect(summary).toContainText("Errors2");
  await expect(summary).toContainText("Duplicates2");
  const row = (n: number) => page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: String(n), exact: true }) });
  await expect(row(4)).toContainText("Duplicate — skipped");
  await expect(row(4)).toContainText("C0001");
  await expect(row(5)).toContainText("Enter a valid email address.");
  await expect(row(6)).toContainText("same PAN as row 2");
  await expect(row(7)).toContainText("No active staff member has this email.");
  expect((await adminClient().from("client").select("id", { count: "exact", head: true }).eq("office_id", officeId)).count).toBe(before);
  expect(await seriousAxe(page)).toEqual([]);

  await page.getByRole("checkbox", { name: "Only rows with problems" }).check();
  await expect(page.getByRole("row")).toHaveCount(1 + 4);

  // AC-16: import → codes in file order, result, error rows
  await page.getByRole("button", { name: "Import 2 valid rows" }).click();
  await expect(page.getByRole("heading", { name: /2 clients imported/ })).toContainText("C0002 – C0003");
  await expect(page.getByText("2 duplicates skipped")).toBeVisible();
  await expect(page.getByText("2 rows not imported")).toBeVisible();

  const svc = adminClient();
  const { data: made } = await svc.from("client").select("id, code, name").eq("office_id", officeId).in("code", ["C0002", "C0003"]).order("code");
  expect(made?.map((c) => c.name)).toEqual(["Anna Nagar Traders", "Besant Stores"]);
  const { count: gstTypes } = await svc.from("client_doc_type").select("id", { count: "exact", head: true }).eq("client_id", made![0].id);
  expect(gstTypes).toBe(5); // GST group enabled with its client documents
  const { count: regs } = await svc.from("client_registration").select("id", { count: "exact", head: true }).eq("client_id", made![0].id);
  expect(regs).toBe(1);

  const errors = await downloadText(page, "Download error rows");
  const lines = errors.trim().split(/\r?\n/);
  expect(lines[0]).toBe(`${header},error`);
  expect(lines).toHaveLength(3);
  expect(lines[1]).toContain("Chetpet Co");
  expect(lines[1]).toContain("email: Enter a valid email address.");

  // Fix the error file and upload it again (the error column is ignored)
  const fixed = errors.replace("not-an-email", "chetpet@example.test").replace("nobody@example.test", inchargeEmail);
  await page.getByRole("button", { name: "Import another file" }).click();
  await upload(page, fixed, "client-import-errors.csv");
  await expect(page.getByLabel("Import summary")).toContainText("Ready to import2");
  await page.getByRole("button", { name: "Import 2 valid rows" }).click();
  await expect(page.getByRole("heading", { name: /2 clients imported/ })).toContainText("C0004 – C0005");
  await expect(page.getByText("0 rows not imported")).toBeVisible();

  // No client data in any URL (spec NFR)
  for (const term of ["anna", "besant", "chetpet", panA.toLowerCase(), "example.test"]) {
    expect(seen.filter((u) => u.toLowerCase().includes(term))).toEqual([]);
  }
  const { data: act } = await svc.from("activity").select("data").eq("office_id", officeId).eq("action", "client.imported");
  expect(JSON.stringify(act)).not.toMatch(new RegExp(`${panA}|example\\.test|98450`));
});

test("AC-14: Limited users can't open the import page", async ({ page, baseURL }) => {
  const limited = await createStaff(officeId, "import-limited", "limited");
  try {
    await signIn(page, limited.email, baseURL);
    await expect(page.getByRole("link", { name: "Import CSV" })).toHaveCount(0);
    await page.goto("/clients/import");
    // Streaming responses keep HTTP 200; what matters is that the import screen doesn't render.
    await expect(page.getByText(/could not be found/i)).toBeVisible();
    await expect(page.getByLabel("CSV file")).toHaveCount(0);
  } finally {
    await retireStaff([limited.id]);
  }
});
