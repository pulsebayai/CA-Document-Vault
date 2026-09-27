import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import "../support/setup-env";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { createCatalogueOffice, groupId } from "../support/catalogue";
import { testGstin, testPan } from "../support/test-data";
import { signIn } from "./helpers";

// Feature 02 step 11 — screenshots of the new screens for the PR, next to mockups 03 / 05 / 11
// (references/mockup), plus axe at desktop and phone width. Screenshots land in test-results/screenshots/,
// which CI uploads with the test evidence. Own is_test office with a few realistic synthetic clients.

let officeId: string;
let admin: { id: string; email: string };
let staff: { id: string; email: string };
let clientId: string;
const SHOTS = "test-results/screenshots";

test.beforeAll(async () => {
  officeId = await createCatalogueOffice("screenshots-ui");
  admin = await createStaff(officeId, "shots-admin", "admin");
  staff = await createStaff(officeId, "shots-staff", "staff");
  const as = await signedInClient(admin.email);
  const [gst, it, tds, bank] = await Promise.all(["GST", "Income Tax", "TDS/TCS", "Banking"].map((g) => groupId(officeId, g)));
  const pan1 = testPan("C", 8001);
  const pan2 = testPan("P", 8002);
  const pan3 = testPan("F", 8003);
  const clients = [
    { name: "Sankar Software Pvt Ltd", client_type: "private_ltd", pan: pan1, email: "accounts@sankar.example.test", mobile: "9840012345",
      incharge_id: staff.id, registrations: [{ kind: "gstin", number: testGstin(pan1) }, { kind: "gstin", number: testGstin(pan1, "29") }],
      group_ids: [gst, it, tds, bank] },
    { name: "Rajesh Traders", client_type: "proprietorship", pan: pan2, incharge_id: admin.id,
      registrations: [{ kind: "gstin", number: testGstin(pan2) }], group_ids: [gst, it] },
    { name: "Meena Exports", client_type: "partnership", pan: pan3, incharge_id: staff.id, group_ids: [gst, tds] },
  ];
  const ids: string[] = [];
  for (const p of clients) {
    const { data, error } = await as.rpc("create_client", { p });
    if (error) throw error;
    ids.push(data.id);
  }
  clientId = ids[0];
  // Mockup 03 shows a paused group badge ("TDS paused").
  const { error } = await as.from("client_group").update({ state: "paused", remark: "Screenshot fixture" })
    .eq("client_id", ids[2]).eq("doc_group_id", tds);
  if (error) throw error;
});
test.afterAll(async () => { await retireStaff([admin?.id, staff?.id].filter(Boolean) as string[]); });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => `${v.id}: ${v.nodes[0]?.target}`);
}

async function shoot(page: Page, name: string) {
  expect(await seriousAxe(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

test("screens vs mockups 03 / 05 / 11 + import + add client, desktop and phone width; no serious/critical axe issues", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await signIn(page, admin.email, baseURL);

  // Mockup 03 — Clients
  await expect(page.getByRole("list", { name: "Clients" }).getByRole("listitem")).toHaveCount(3);
  await expect(page.getByRole("listitem", { name: "Meena Exports" })).toContainText("TDS/TCS paused");
  await shoot(page, "03-clients");

  // Mockup 11 — Client › Settings
  await page.goto(`/clients/${clientId}`);
  await expect(page.getByRole("heading", { name: "Sankar Software Pvt Ltd" })).toBeVisible();
  await shoot(page, "11-client-settings");

  // Mockup 05 — Settings › Document catalogue
  await page.goto("/settings/catalogue");
  await expect(page.getByRole("heading", { name: "GST", exact: true })).toBeVisible();
  await shoot(page, "05-settings-catalogue");

  // No mockup: Add client and Import CSV (preview)
  await page.goto("/clients/new");
  await expect(page.getByRole("heading", { name: "Add client" })).toBeVisible();
  await shoot(page, "add-client");
  await page.goto("/clients/import");
  const header = "name,client_type,pan,previous_reference,email,mobile,incharge_email,gstins,tans,groups";
  const csv = `${header}\nAdyar Agencies,Individual,${testPan("P", 8010)},,,,${staff.email},,,GST\nBad Row,individual,,,oops,,${staff.email},,,\n`;
  await page.getByLabel("CSV file").setInputFiles({ name: "clients.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.getByLabel("Import summary")).toContainText("Ready to import1");
  await shoot(page, "import-preview");

  // Phone width (release checklist: mobile width check)
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/clients");
  await expect(page.getByRole("list", { name: "Clients" })).toBeVisible();
  await shoot(page, "mobile-03-clients");
  await page.goto(`/clients/${clientId}`);
  await expect(page.getByRole("heading", { name: "Sankar Software Pvt Ltd" })).toBeVisible();
  await shoot(page, "mobile-11-client-settings");
  // Phone layout is not in 02's scope: record the page width for the release checklist instead of asserting it.
  test.info().annotations.push({ type: "mobile-scroll-width", description: String(await page.evaluate(() => document.documentElement.scrollWidth)) });
});
