import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import "../support/setup-env";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createCatalogueOffice, groupId } from "../support/catalogue";
import { signIn } from "./helpers";

// Feature 02 step 9 — Client › Settings: the collection plan (spec AC-18 … AC-21, AC-23; mockup 11).
// Own is_test office, reset to the seed at the start of every run.

let officeId: string;
let staff: { id: string; email: string };
let manager: { id: string; email: string };
let clientId: string;

const GST_CLIENT_TYPES = [
  "Sales invoices / sales register", "Purchase invoices / purchase register", "Credit / debit notes issued and received",
  "E-way bills", "GST notice / order received",
];

test.beforeAll(async () => {
  officeId = await createCatalogueOffice("client-plan-ui");
  staff = await createStaff(officeId, "cplan-staff", "staff");
  manager = await createStaff(officeId, "cplan-manager", "manager");
  const asStaff = await signedInClient(staff.email);
  const { data, error } = await asStaff.rpc("create_client", { p: { name: "Plan Target", client_type: "individual", incharge_id: staff.id } });
  if (error) throw error;
  clientId = data.id;
});
test.afterAll(async () => { await retireStaff([staff?.id, manager?.id].filter(Boolean) as string[]); });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id);
}
const planRows = async () => {
  const { data, error } = await adminClient().from("client_doc_type").select("id, state, frequency").eq("client_id", clientId);
  if (error) throw error;
  return data;
};
const gstSection = (page: Page) => page.getByRole("region", { name: "GST", exact: true });

test.describe.configure({ mode: "serial" });

test("AC-18, AC-19, AC-21: staff enables GST, edits the plan, disables and re-enables it without duplicates", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/clients/${clientId}`);
  await expect(page.getByRole("heading", { name: "Plan Target" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Client sections" }).getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("No document groups are collected for this client yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0); // pause is Admin/Manager only

  // AC-19: enabling copies every active client-source master type — never firm records.
  await page.getByRole("button", { name: "Enable GST" }).click();
  const gst = gstSection(page);
  await expect(gst).toBeVisible();
  for (const name of GST_CLIENT_TYPES) await expect(gst.getByRole("cell", { name, exact: true })).toBeVisible();
  await expect(gst.getByText("GST working / reconciliation")).toHaveCount(0);
  await expect(gst.getByText("Assigned to")).toContainText("cplan-staff"); // default assignee = incharge
  expect(await seriousAxe(page)).toEqual([]);
  expect((await planRows()).length).toBe(5);

  // AC-20 (Staff+): remove and restore a type; change a frequency in the type dialog.
  await gst.getByRole("switch", { name: "Collect E-way bills for this client" }).click();
  await expect(gst.getByText("Not collected for this client")).toBeVisible();
  await gst.getByRole("switch", { name: "Collect E-way bills for this client" }).click();
  await expect(gst.getByText("Not collected for this client")).toHaveCount(0);

  await gst.getByRole("button", { name: "Edit Credit / debit notes issued and received" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Credit / debit notes issued and received" });
  await dialog.getByLabel("Collected").selectOption("quarterly");
  await expect(dialog.getByLabel("Collect from")).toBeVisible();
  expect(await seriousAxe(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(gst.getByRole("row", { name: /Credit \/ debit notes/ })).toContainText("Quarterly");

  // AC-21: disabling keeps the rows (removed); re-enabling restores them — no duplicates.
  await gst.getByRole("switch", { name: "Collect GST for this client" }).click();
  await expect(gst).toHaveCount(0);
  await expect(page.getByText("previously collected — settings kept")).toBeVisible();
  expect((await planRows()).every((r) => r.state === "removed")).toBe(true);
  await page.getByRole("button", { name: "Enable GST" }).click();
  await expect(gstSection(page).getByRole("row", { name: /Credit \/ debit notes/ })).toContainText("Quarterly");
  const rows = await planRows();
  expect(rows.length).toBe(5);
  expect(rows.every((r) => r.state === "active")).toBe(true);

  // AC-23: activity has actions, IDs and field names only.
  const { data: log } = await adminClient().from("activity").select("action, data").eq("office_id", officeId).eq("data->>client_id", clientId) // this attempt's client only (serial retries re-create it)
    .in("action", ["client_group.enabled", "client_group.disabled", "client_doc_type.removed", "client_doc_type.restored", "client_doc_type.updated"])
    .order("id");
  expect(log?.map((l) => l.action)).toEqual([
    "client_group.enabled", "client_doc_type.removed", "client_doc_type.restored", "client_doc_type.updated",
    "client_group.disabled", "client_group.enabled",
  ]);
  expect(log?.[3].data).toMatchObject({ client_id: clientId, fields: expect.arrayContaining(["frequency", "start_period_id"]) });
});

test("AC-20: a manager pauses and resumes the group with a remark, reassigns it, and adds a type", async ({ page, baseURL }) => {
  // A master type added to the catalogue after the group was enabled is offered by "+ Add type to GST".
  const asManager = await signedInClient(manager.email);
  const { error } = await asManager.from("doc_type").insert({
    office_id: officeId, doc_group_id: await groupId(officeId, "GST"), code: "e2e_gst_annual_summary", name: "GST annual turnover summary",
    period_kind: "year", default_frequency: "yearly", source: "client", ask_after_months: 1, ask_day: 1, overdue_after_months: 2, overdue_day: 15, reminders: true,
  });
  if (error) throw error;

  await signIn(page, manager.email, baseURL);
  await page.goto(`/clients/${clientId}`);
  const gst = gstSection(page);

  await gst.getByRole("button", { name: "Pause GST", exact: true }).click();
  const pause = page.getByRole("dialog", { name: "Pause GST" });
  await pause.getByLabel("Remark").fill("Client abroad until March");
  await pause.getByRole("button", { name: "Pause" }).click();
  await expect(gst.getByText(/Paused since/)).toBeVisible();
  await expect(gst.getByText("Client abroad until March")).toBeVisible();
  await gst.getByRole("button", { name: "Resume GST", exact: true }).click();
  await expect(gst.getByText(/Paused since/)).toHaveCount(0);

  await gst.getByLabel("Assigned to").selectOption({ label: "Test cplan-manager" });
  await expect.poll(async () => {
    const { data } = await adminClient().from("client_group").select("assigned_staff_id").eq("client_id", clientId).single();
    return data?.assigned_staff_id;
  }).toBe(manager.id);

  await gst.getByRole("button", { name: "+ Add type to GST" }).click();
  const add = page.getByRole("dialog", { name: "Add a type to GST" });
  await add.getByLabel("Document type").selectOption({ label: "GST annual turnover summary" });
  await add.getByRole("button", { name: "Add type" }).click();
  await expect(gst.getByRole("cell", { name: "GST annual turnover summary", exact: true })).toBeVisible();
  await expect(gst.getByRole("row", { name: /GST annual turnover summary/ })).toContainText("Yearly");
  expect(await seriousAxe(page)).toEqual([]);

  const { data: log } = await adminClient().from("activity").select("action, data").eq("office_id", officeId).eq("data->>client_id", clientId) // this attempt's client only (serial retries re-create it)
    .in("action", ["client_group.paused", "client_group.resumed", "client_group.assigned", "client_doc_type.added"]).order("id");
  expect(log?.map((l) => l.action)).toEqual(["client_group.paused", "client_group.resumed", "client_group.assigned", "client_doc_type.added"]);
  expect(JSON.stringify(log)).not.toContain("Client abroad"); // remarks stay on the row, never in activity
});
