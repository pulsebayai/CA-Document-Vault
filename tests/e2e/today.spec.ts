import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice } from "../support/documents";
import { bankOnlyClient, followUpsOf, generateAsOf } from "../support/expected";
import { signIn } from "./helpers";

// Feature 06 steps 5–6 — Today (spec AC-1…AC-5) and the Remind / Log call dialogs from a Today row (AC-7…AC-13).
// Own is_test office, reset every run. Test clock: Bank statement only (overdue +1/7), enabled 15 Mar 2026,
// generated as of 15 Jul 2026 → Mar–Jun overdue (4 rows per client).
//   Alpha (incharge staff, email + mobile on .test / fixture numbers) · Bravo (incharge limited, no email)
// Every email in this file goes to a .test address, so the mailer suppresses it (AC-13): nothing leaves the vault.

let officeId: string;
const u = {} as Record<"admin" | "staff" | "limited", { id: string; email: string }>;
let alpha: string;
let bravo: string;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  officeId = await createDocumentOffice("today-ui");
  u.admin = await createStaff(officeId, "tdui-admin", "admin");
  u.staff = await createStaff(officeId, "tdui-staff", "staff");
  u.limited = await createStaff(officeId, "tdui-limited", "limited");
  const asAdmin = await signedInClient(u.admin.email);
  const asStaff = await signedInClient(u.staff.email);
  await generateAsOf(asAdmin, "2026-03-15");
  alpha = await bankOnlyClient(asStaff, officeId, { name: "Alpha Traders", incharge_id: u.staff.id, email: "alpha@example.test", mobile: "9876543210" });
  bravo = await bankOnlyClient(asStaff, officeId, { name: "Bravo Exports", incharge_id: u.limited.id, email: null, mobile: "9876543211" });
  await generateAsOf(asAdmin, "2026-07-15");
});
test.afterAll(async () => { await retireStaff(Object.values(u).map((x) => x.id)); });
test.describe.configure({ mode: "serial" });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id);
}
const card = (page: Page, name: string) =>
  page.getByRole("list", { name: "Clients that need something" }).getByRole("listitem").filter({ has: page.getByRole("link", { name }) }).first();

test("AC-1: Today is the landing page and first in the nav; the logo goes there", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL); // the helper itself asserts that sign-in lands on /today
  await page.goto("/");
  await expect(page).toHaveURL(/\/today$/);
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link").first()).toHaveText("Today");
  await expect(nav.getByRole("link", { name: "Today" })).toHaveAttribute("aria-current", "page");
  await page.goto("/clients");
  await page.getByRole("banner").getByRole("link").first().click();
  await expect(page).toHaveURL(/\/today$/);
});

test("AC-2…AC-5: counts, scope, filter in the URL as enums, card content; axe; 390 px", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.goto("/today");
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(page.getByText(/Wednesday, 15 July 2026 · 1 client needs something/)).toBeVisible();
  await expect(page.getByRole("button", { name: "My clients" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "4 Overdue" })).toBeVisible();
  const a = card(page, "Alpha Traders");
  await expect(a).toContainText("Incharge Test tdui-staff");
  await expect(a).toContainText("4 overdue");
  await expect(a.getByRole("list", { name: "Open documents for Alpha Traders" }).getByRole("listitem")).toHaveCount(4);
  await expect(a).toContainText("Banking · Bank statement · Mar 2026");
  await expect(a).toContainText("Not received · 100 days late");
  expect(await seriousAxe(page)).toEqual([]);

  await page.getByRole("button", { name: "Everyone" }).click();
  await expect(page).toHaveURL(/\/today\?scope=everyone$/);
  await expect(card(page, "Bravo Exports")).toBeVisible();
  await expect(page.getByRole("button", { name: "8 Overdue" })).toBeVisible();
  await page.getByRole("button", { name: "0 Due this week" }).click();
  await expect(page).toHaveURL(/\/today\?scope=everyone&show=due_week$/);
  await expect(page.getByText("Nothing in this list")).toBeVisible();
  await page.getByRole("button", { name: "0 Due this week" }).click();
  await expect(page).toHaveURL(/\/today\?scope=everyone$/);
  expect(new URL(page.url()).search).not.toMatch(/Alpha|Bravo|@/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/today?scope=everyone");
  await expect(card(page, "Alpha Traders")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("AC-3: Limited sees only their own clients, even under Everyone", async ({ page, baseURL }) => {
  await signIn(page, u.limited.email, baseURL);
  await page.goto("/today?scope=everyone");
  await expect(card(page, "Bravo Exports")).toBeVisible();
  await expect(page.getByRole("link", { name: "Alpha Traders" })).toHaveCount(0);
});

test("AC-7…AC-10, AC-13: Remind from Today — ticks, preview, Send email (suppressed: .test), cap, history; axe on the dialog", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.goto("/today");
  await card(page, "Alpha Traders").getByRole("button", { name: "Remind Alpha Traders" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Remind Alpha Traders" });
  await expect(dialog.getByRole("checkbox")).toHaveCount(4);
  for (const box of await dialog.getByRole("checkbox").all()) await expect(box).toBeChecked();
  const preview = dialog.getByRole("region", { name: "Message preview" });
  await expect(preview).toContainText("Dear Alpha Traders,");
  await expect(preview).toContainText("Banking · Bank statement · March 2026 — overdue since 7 Apr");
  await expect(preview).toContainText("Test tdui-staff");
  expect(await seriousAxe(page)).toEqual([]);

  await dialog.getByRole("button", { name: "Send email" }).click();
  await expect(dialog.getByText("Recorded, not sent: this address doesn't receive email in this environment.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Send email" })).toBeDisabled();
  await expect(dialog).toContainText(/Emailed today at \d\d:\d\d by Test tdui-staff/);
  // AC-13: the follow-up exists and nothing was sent.
  const emails = (await followUpsOf(officeId, alpha)).filter((f) => f.channel === "email");
  expect(emails.map((f) => f.status)).toEqual(["suppressed"]);
  await dialog.getByRole("button", { name: "Close" }).click();

  await expect(card(page, "Alpha Traders")).toContainText("reminded once");
});

test("AC-9: Open WhatsApp opens a wa.me chat and records it; no email on file is explained", async ({ page, baseURL, context }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.goto("/today?scope=everyone");
  await card(page, "Bravo Exports").getByRole("button", { name: "Remind Bravo Exports" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Remind Bravo Exports" });
  await expect(dialog.getByRole("button", { name: "Send email" })).toBeDisabled();
  await expect(dialog).toContainText("No email on file — add one in Settings.");
  // Never reach the real WhatsApp from a test: answer the chat URL locally.
  await context.route(/^https:\/\/(wa\.me|api\.whatsapp\.com)\//, (r) => r.fulfill({ status: 200, contentType: "text/plain", body: "chat" }));
  const popup = context.waitForEvent("page");
  await dialog.getByRole("button", { name: "Open WhatsApp" }).click();
  const chat = await popup;
  await chat.waitForURL(/^https:\/\/wa\.me\/919876543211\?text=Dear%20Bravo%20Exports/);
  await chat.close();
  await expect(dialog.getByText("WhatsApp opened and recorded.")).toBeVisible();
  await expect.poll(async () => (await followUpsOf(officeId, bravo)).map((f) => `${f.channel}:${f.status}`)).toEqual(["whatsapp:opened"]);
});

test("AC-11: Log call records a call with its date and note", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.goto("/today");
  await card(page, "Alpha Traders").getByRole("button", { name: "Log call with Alpha Traders" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Log a call with Alpha Traders" });
  await expect(dialog.getByLabel("Date of call")).toHaveValue("2026-07-15");
  await dialog.getByLabel("Date of call").fill("2026-07-14");
  await dialog.getByLabel("Note (optional)").fill("Accountant will send on Friday");
  await dialog.getByRole("button", { name: "Save call" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await followUpsOf(officeId, alpha)).find((f) => f.channel === "phone"))
    .toMatchObject({ status: "logged", sent_on: "2026-07-14", note: "Accountant will send on Friday" });
  await expect(card(page, "Alpha Traders")).toContainText("reminded twice");
});
