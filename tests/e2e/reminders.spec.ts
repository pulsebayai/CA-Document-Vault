import { expect, test } from "./fixtures";
import "../support/setup-env";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice } from "../support/documents";
import { bankOnlyClient, emailReminder, expectedItem, generateAsOf, mustRpc, T } from "../support/expected";
import { signIn } from "./helpers";

// Feature 06 step 6 — Remind / Log call on Client › Documents (expected rows only) and Client › Expected, the row
// history and the client's Reminders list (spec AC-7, AC-11, AC-12). Test clock as in today.spec.ts.

let officeId: string;
const u = {} as Record<"admin" | "staff", { id: string; email: string }>;
let client: string;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  officeId = await createDocumentOffice("reminders-ui");
  u.admin = await createStaff(officeId, "rmui-admin", "admin");
  u.staff = await createStaff(officeId, "rmui-staff", "staff");
  const asAdmin = await signedInClient(u.admin.email);
  const asStaff = await signedInClient(u.staff.email);
  await generateAsOf(asAdmin, "2026-03-15");
  client = await bankOnlyClient(asStaff, officeId, { name: "Chennai Mills", incharge_id: u.staff.id, email: "mills@example.test", mobile: "9876543212" });
  await generateAsOf(asAdmin, "2026-07-15");
  // History: a call on 14 Jul by staff, then a suppressed email (.test) today by admin — both count as reminders.
  const mar = (await expectedItem(client, T.bank, "2026-03")).id;
  await mustRpc(asStaff, "record_follow_up", { p_client: client, p_items: [mar], p_channel: "phone", p_on: "2026-07-14", p_note: "Called the accountant" });
  await emailReminder(asAdmin, client, [mar], "suppressed");
});
test.afterAll(async () => { await retireStaff(Object.values(u).map((x) => x.id)); });
test.describe.configure({ mode: "serial" });

test("AC-12: Client › Documents expected rows show the history and offer Remind / Log call", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.goto(`/clients/${client}`);
  const open = page.getByRole("list", { name: "Banking outstanding" });
  const mar = open.getByRole("listitem").filter({ hasText: "Bank statement · Mar 2026" });
  await expect(mar).toContainText("reminded twice · last 15 Jul by Test rmui-admin (email)");
  await expect(mar.getByRole("button", { name: "Remind Chennai Mills" })).toBeVisible();
  await expect(mar.getByRole("button", { name: "Log call with Chennai Mills" })).toBeVisible();
  // Already emailed today (the admin's suppressed email): the dialog says so.
  await mar.getByRole("button", { name: "Remind Chennai Mills" }).click();
  const dialog = page.getByRole("dialog", { name: "Remind Chennai Mills" });
  await expect(dialog).toContainText(/Emailed today at \d\d:\d\d by Test rmui-admin\. One email per client per day\./);
  await expect(dialog.getByRole("button", { name: "Send email" })).toBeDisabled();
});

test("AC-12: Client › Expected rows carry the history; the Reminders list shows newest first with the call note", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.goto(`/clients/${client}?tab=expected`);
  const row = page.getByRole("list", { name: "Banking expected documents" }).getByRole("listitem").filter({ hasText: "Bank statement · Mar 2026" });
  await expect(row).toContainText("reminded twice");
  await expect(row.getByRole("button", { name: "Remind Chennai Mills" })).toBeVisible();
  const list = page.getByRole("list", { name: "Reminders, newest first" }).getByRole("listitem");
  await expect(list).toHaveCount(2);
  await expect(list.nth(0)).toContainText("15 Jul · Email · Test rmui-admin · Not sent (test address) to m…@…");
  await expect(list.nth(1)).toContainText("14 Jul · Call · Test rmui-staff · Logged");
  await expect(list.nth(1)).toContainText("“Called the accountant”");
  // The list shows the address masked (the header's client card shows it in full, by design).
  await expect(page.getByRole("list", { name: "Reminders, newest first" })).not.toContainText("mills@example.test");
});
