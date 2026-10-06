import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, mustCreateDocument, mustReview, periodId, typeId } from "../support/documents";
import { T } from "../support/expected";
import { insertActivity } from "../support/activity";
import { signIn } from "./helpers";

// Feature 08 step 5 — the Activity screen (mockup 04; AC-5 … AC-9, AC-11 on screen): nav item, day groups, sentences,
// links, filters in the URL, sign-ins hidden by default, Limited's view; axe, ≤ 390 px, screenshot next to mockup 04.
// Activity isn't purged between runs, so assertions use this run's clients and DOC-IDs.

const SHOTS = "test-results/screenshots";
let officeId: string;
const u = {} as Record<"staff" | "limited", { id: string; email: string }>;
const client = {} as Record<"mine" | "other", string>;
let reviewed: { id: string; doc_code: string };
let hidden: { id: string; doc_code: string };

test.beforeAll(async () => {
  test.setTimeout(180_000);
  officeId = await createDocumentOffice("activity-ui");
  u.staff = await createStaff(officeId, "acui-staff", "staff");
  u.limited = await createStaff(officeId, "acui-limited", "limited");
  const as = await signedInClient(u.staff.email);
  const mk = async (name: string, incharge: string) => {
    const { data, error } = await as.rpc("create_client", { p: { name, client_type: "individual", incharge_id: incharge } });
    if (error) throw error;
    return data.id as string;
  };
  client.mine = await mk("Activity Mine Traders", u.limited.id);
  client.other = await mk("Activity Other Exports", u.staff.id);
  const bank = await typeId(officeId, T.bank);
  const aug = await periodId(officeId, "2026-08");
  reviewed = await mustCreateDocument(as, { client_id: client.mine, doc_type_id: bank, period_id: aug, received_as: "hard_copy", received_on: "2026-09-02" });
  await mustReview(as, reviewed.id);
  hidden = await mustCreateDocument(as, { client_id: client.other, doc_type_id: bank, period_id: aug, received_as: "hard_copy", received_on: "2026-09-02" });
  await insertActivity(officeId, [{ actor_id: u.staff.id, action: "auth.signed_in", entity_type: "staff_user", entity_id: u.staff.id, data: { method: "code" } }]);
});
test.afterAll(async () => { await retireStaff([u.staff?.id, u.limited?.id].filter(Boolean) as string[]); });
test.describe.configure({ mode: "serial" });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id);
}

test("AC-5, AC-8, AC-9: the feed reads as sentences under day headings; sign-ins only on request; rows link", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Activity" }).click();
  await expect(page).toHaveURL(/\/activity$/);
  await expect(page.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
  await expect(page.getByText("Everything anyone did, newest first")).toBeVisible();
  const today = page.getByRole("region", { name: /^Today, / });
  await expect(today.getByText(`Activity Mine Traders · Banking · ${reviewed.doc_code}`).first()).toBeVisible();
  await expect(today.getByRole("link", { name: /^Test reviewed Bank statement/ }).first()).toBeVisible();
  await expect(page.getByText(/signed in$/)).toHaveCount(0);
  expect(await seriousAxe(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/08-activity.png`, fullPage: true });

  await page.getByRole("combobox", { name: "Action" }).selectOption("sign_ins");
  await expect(page).toHaveURL(/action=sign_ins/);
  await expect(page.getByRole("link", { name: "Remove filter Action: Sign-ins" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove filter Action: Sign-ins" })).toBeVisible();
  await expect(page.getByText("Test signed in").first()).toBeVisible();
  await page.getByRole("button", { name: "Clear all" }).click();
  await expect(page).toHaveURL(/\/activity$/);

  await page.goto(`/activity?client=${client.mine}`);
  await expect(page.getByRole("button", { name: /Remove filter Client: Activity Mine Traders/ })).toBeVisible();
  await page.getByRole("link", { name: /^Test reviewed Bank statement/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`/documents/${reviewed.id}$`));
});

test("AC-11 on screen: Limited sees its clients' events only, with its own subtitle; ≤ 390 px", async ({ page, baseURL }) => {
  await signIn(page, u.limited.email, baseURL);
  await page.goto("/activity");
  await expect(page.getByText("Your actions and your clients, newest first")).toBeVisible();
  await expect(page.getByText(reviewed.doc_code).first()).toBeVisible();
  await expect(page.getByText(hidden.doc_code)).toHaveCount(0);
  await expect(page.getByText("Activity Other Exports")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${SHOTS}/08-activity-limited-390.png`, fullPage: true });
});

test("AC-10: the document page's Activity card and the client page's Activity link", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.goto(`/documents/${reviewed.id}`);
  const card = page.getByRole("list", { name: "Document activity" });
  await expect(card.getByRole("listitem").first()).toContainText("Test acui-staff marked it reviewed");
  await expect(card.getByRole("listitem").last()).toContainText("Test acui-staff added");
  await page.getByRole("link", { name: "See all in Activity" }).click();
  await expect(page).toHaveURL(new RegExp(`/activity\\?document=${reviewed.id}$`));
  await expect(page.getByRole("button", { name: `Remove filter Document: ${reviewed.doc_code}` })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Test reviewed Bank statement/ })).toHaveCount(1);

  await page.goto(`/clients/${client.mine}`);
  await page.getByRole("main").getByRole("link", { name: "Activity", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/activity\\?client=${client.mine}$`));
  await expect(page.getByText(hidden.doc_code)).toHaveCount(0);
});
