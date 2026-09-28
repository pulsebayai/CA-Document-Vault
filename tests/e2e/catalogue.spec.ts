import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { adminClient, createStaff, retireStaff } from "../support/db";
import { createCatalogueOffice } from "../support/catalogue";
import { signIn } from "./helpers";

// Feature 02 step 6 — Settings › Document catalogue (spec AC-2, AC-3, AC-4 wording, AC-6, AC-23).
// Own is_test office, reset to the seed at the start of every run (so renames never accumulate).

let officeId: string;
let admin: { id: string; email: string };
let staff: { id: string; email: string };
const CDN = "Credit / debit notes issued and received";

test.beforeAll(async () => {
  officeId = await createCatalogueOffice("catalogue-ui");
  admin = await createStaff(officeId, "cat-admin", "admin");
  staff = await createStaff(officeId, "cat-staff", "staff");
});
test.afterAll(async () => { await retireStaff([staff?.id, admin?.id].filter(Boolean) as string[]); });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => `${v.id}: ${v.nodes.length}`);
}

async function openCatalogue(page: Page) {
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings\/catalogue$/);
  await expect(page.getByRole("heading", { name: "Document catalogue" })).toBeVisible();
}

test("AC-2, AC-3, AC-23: admin edits a type's name and schedule, toggles a group; both are logged", async ({ page, baseURL }) => {
  await signIn(page, admin.email, baseURL);
  await openCatalogue(page);
  await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Users and roles" })).toBeVisible();
  const gst = page.getByRole("region", { name: "GST", exact: true });
  await expect(gst.getByRole("row", { name: new RegExp(CDN.replace(/[/]/g, "\\/")) })).toContainText("overdue from 5th of the next month");

  // Invalid schedule: plain-word error, nothing saved.
  await gst.getByRole("button", { name: `Edit ${CDN}` }).click();
  let dialog = page.getByRole("dialog", { name: `Edit ${CDN}` });
  await expect(dialog.getByText("Existing clients keep their own schedule.")).toBeVisible(); // AC-4 wording
  await dialog.getByLabel("Ask: Months after").fill("2");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByText("Overdue must be on or after the ask date.")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  // Valid edit.
  await gst.getByRole("button", { name: `Edit ${CDN}` }).click();
  dialog = page.getByRole("dialog", { name: `Edit ${CDN}` });
  await dialog.getByLabel("Name").fill("Credit / debit notes");
  await dialog.getByLabel("Overdue from: Day").fill("7");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(gst.getByRole("row", { name: /^Credit \/ debit notes/ })).toContainText("overdue from 7th of the next month");

  const { data: row } = await adminClient().from("doc_type").select("id, name, overdue_day")
    .eq("office_id", officeId).eq("name", "Credit / debit notes").single();
  expect(row?.overdue_day).toBe(7);
  await expect.poll(async () => {
    const { data } = await adminClient().from("activity").select("action, data").eq("office_id", officeId).eq("entity_id", row!.id);
    return data?.find((a) => a.action === "doc_type.updated")?.data?.fields ?? [];
  }).toEqual(expect.arrayContaining(["name", "overdue_day"]));

  // "Enabled for new clients" (AC-3).
  const banking = page.getByRole("region", { name: "Banking", exact: true });
  const toggle = banking.getByRole("switch", { name: "Banking: enabled for new clients" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect.poll(async () => (await adminClient().from("doc_group").select("enabled_for_new_clients")
    .eq("office_id", officeId).eq("name", "Banking").single()).data?.enabled_for_new_clients).toBe(true);

  expect(await seriousAxe(page)).toEqual([]);
});

test("AC-6: staff see the catalogue read-only; Users and roles stays Admin only", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await openCatalogue(page);
  await expect(page.getByRole("note")).toContainText("An Admin or Manager can change it.");
  await expect(page.getByRole("region", { name: "GST", exact: true }).getByRole("row", { name: /Sales invoices/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Edit / })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^\+ Add/ })).toHaveCount(0);
  for (const s of await page.getByRole("switch").all()) await expect(s).toBeDisabled();
  await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Users and roles" })).toHaveCount(0);
  expect(await seriousAxe(page)).toEqual([]);

  await page.goto("/settings/users");
  await expect(page.getByText(/could not be found/i)).toBeVisible();
  await expect(page.getByText(admin.email)).toHaveCount(0);
});
