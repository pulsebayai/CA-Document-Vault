import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, typeId } from "../support/documents";
import { T } from "../support/expected";
import { signIn } from "./helpers";

// Feature 13 — Log receipt (spec AC-13 … AC-16; Q1, Q2; Sankar #6): reception logs paper with client, what came in,
// how many and who handed it over; the confirmation lists each paper's reference (client code + DOC-ID). 390 px + axe.

let officeId: string;
let staff: { id: string; email: string };
let clientId: string;
let clientCode: string;

test.beforeAll(async () => {
  officeId = await createDocumentOffice("receipt-ui");
  staff = await createStaff(officeId, "rui-staff", "staff");
  const as = await signedInClient(staff.email);
  const { data: c, error } = await as.rpc("create_client", { p: { name: "Receipt Traders", client_type: "individual", incharge_id: staff.id } });
  if (error) throw error;
  clientId = c.id;
  clientCode = c.code;
});
test.afterAll(async () => { if (staff) await retireStaff([staff.id]); });
test.describe.configure({ mode: "serial" });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id);
}

test("AC-13 … AC-15: three papers with a type — three filed hard copies, references to write on them; axe", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto("/inbox");
  await page.getByRole("link", { name: "Log receipt" }).click();
  await expect(page).toHaveURL(/\/documents\/receipt$/);
  await expect(page.getByRole("button", { name: "Log receipt" })).toBeEnabled(); // form is interactive
  await page.getByRole("combobox", { name: "Client", exact: true }).fill("Receipt Tra");
  await page.getByRole("listbox", { name: "Matching clients" }).getByRole("button", { name: /Receipt Traders/ }).click();
  const type = page.getByRole("combobox", { name: "What came in" });
  await expect(type).toBeEnabled();
  await type.fill("bank statement");
  await page.getByRole("listbox", { name: "Matching types" }).getByRole("option", { name: new RegExp(`^${T.bank}`) }).first().click();
  await page.getByLabel("How many").fill("3");
  await page.getByRole("button", { name: "Log receipt" }).click();
  await expect(page.getByText("Say who handed it over.")).toBeVisible(); // required
  await page.getByLabel("Handed over by (required)").fill("Client's accountant");
  await page.getByLabel(/^Returnable/).check();
  expect(await seriousAxe(page)).toEqual([]);
  await page.getByRole("button", { name: "Log receipt" }).click();

  await expect(page.getByRole("status")).toHaveText("Logged 3 papers for Receipt Traders");
  const refs = page.getByRole("list", { name: "Paper references" }).getByRole("listitem");
  await expect(refs).toHaveCount(3);
  await expect(refs.first()).toContainText(new RegExp(`^${clientCode} · DOC-FY\\d{2}-\\d{2}-\\d{5}`));
  expect(await seriousAxe(page)).toEqual([]);
  const { data } = await adminClient().from("document").select("received_as, returnable, handed_over_name, doc_type_id, current_version_id")
    .eq("client_id", clientId);
  expect(data).toHaveLength(3);
  for (const d of data!) expect(d).toMatchObject({ received_as: "hard_copy", returnable: true, handed_over_name: "Client's accountant",
    doc_type_id: await typeId(officeId, T.bank), current_version_id: null });

  await refs.first().getByRole("link", { name: /Attach scan/ }).click();
  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]{36}#current-file$/);
  await expect(page.getByText(/No file yet/)).toBeVisible();
});

test("AC-14, AC-16: no type → untagged for the client; the form fits 390 px", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/documents/receipt?client=${clientId}`);
  await expect(page.getByText("Receipt Traders")).toBeVisible();
  await expect(page.getByRole("button", { name: "Log receipt" })).toBeEnabled();
  await page.getByLabel("Handed over by (required)").fill("Courier — Blue Dart");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Log receipt" }).click();
  await expect(page.getByRole("status")).toHaveText("Logged 1 paper for Receipt Traders");
  await page.getByRole("button", { name: "Log another receipt" }).click();
  await expect(page.getByRole("button", { name: "Change" })).toBeVisible(); // the client stays chosen for the next paper
  await expect(page.getByLabel("Handed over by (required)")).toHaveValue("");
  const { count } = await adminClient().from("document").select("id", { count: "exact", head: true }).eq("client_id", clientId).is("doc_type_id", null);
  expect(count).toBe(1);
});
