import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice } from "../support/documents";
import { signIn } from "./helpers";

// Feature 14 — DSC tracking on screen (spec AC-1 … AC-11; NFR accessibility, 390 px).
//   Client › DSC: add, renew, reveal (30 s, copy, hide), custody out/in, change password, archive/unarchive (Manager).
//   Limited: sees the tab, no Add / Show password. Client › Settings: remind days. Today: "DSC expiring".
// The app encrypts with DSC_ENC_KEYS from the environment (CI and sessions: the public test key).

let officeId: string;
const u = {} as Record<"staff" | "manager" | "limited", { id: string; email: string }>;
let clientId: string, limitedClientId: string;
const PIN = "pin 4321";
const NEW_PIN = "new-pin-9876";

const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const plusDays = (n: number) => new Date(Date.parse(`${istToday()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

test.beforeAll(async () => {
  test.setTimeout(120_000);
  officeId = await createDocumentOffice("dsc-ui");
  u.staff = await createStaff(officeId, "dui-staff", "staff");
  u.manager = await createStaff(officeId, "dui-manager", "manager");
  u.limited = await createStaff(officeId, "dui-limited", "limited");
  const as = await signedInClient(u.staff.email);
  const mk = async (name: string, incharge: string) => {
    const { data, error } = await as.rpc("create_client", { p: { name, client_type: "individual", incharge_id: incharge } });
    if (error) throw error;
    return data.id as string;
  };
  clientId = await mk("Signature Traders", u.staff.id);
  limitedClientId = await mk("Limited Signatures", u.limited.id);
});
test.afterAll(async () => { await retireStaff(Object.values(u).filter(Boolean).map((x) => x.id)); });
test.describe.configure({ mode: "serial", timeout: 120_000 }); // several sign-ins and dialogs per test against dev

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id);
}
const card = (page: Page, holder: string) => page.getByRole("article", { name: holder });

test("AC-1, AC-2, AC-3, AC-4: add a DSC, see its expiry status, renew it; axe; 390 px", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.goto(`/clients/${clientId}?tab=dsc`);
  await expect(page.getByRole("link", { name: /DSC\s*0/ })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("No DSCs yet.")).toBeVisible();

  await page.getByRole("button", { name: "Add DSC" }).click();
  const dialog = page.getByRole("dialog", { name: "Add DSC" });
  await dialog.getByLabel("Holder name").fill("Ravi Director");
  await dialog.getByLabel("Expiry date").fill(plusDays(20));
  await dialog.getByLabel("Token PIN / password").fill(PIN);
  await dialog.getByRole("button", { name: "Show password" }).click();
  await expect(dialog.getByRole("button", { name: "Show password" })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByLabel("Class").selectOption("class3");
  await dialog.getByLabel("Issuer").fill("eMudhra");
  await dialog.getByRole("button", { name: "Add DSC" }).click();
  await expect(dialog).toBeHidden();

  const c = card(page, "Ravi Director");
  await expect(c).toContainText("Expires in 20 days");
  await expect(c).toContainText("Class 3 · eMudhra");
  await expect(c).toContainText("In office");
  await expect(page.getByRole("link", { name: /DSC\s*1/ })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(PIN);
  expect(await seriousAxe(page)).toEqual([]);

  // Renew: a new expiry outside the window.
  await c.getByRole("button", { name: "Edit Ravi Director's DSC" }).click();
  const edit = page.getByRole("dialog", { name: "Edit DSC: Ravi Director" });
  await expect(edit.getByLabel("Token PIN / password")).toHaveCount(0); // never pre-filled (AC-4)
  await edit.getByLabel("Expiry date").fill("2029-03-12");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await expect(c).toContainText("Valid till 12 Mar 2029");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("AC-7: Show password reveals it for 30 seconds with Copy, then hides; Hide hides at once", async ({ page, baseURL }) => {
  await page.clock.install();
  await signIn(page, u.staff.email, baseURL);
  await page.goto(`/clients/${clientId}?tab=dsc`);
  const c = card(page, "Ravi Director");
  await c.getByRole("button", { name: "Show password of Ravi Director's DSC" }).click();
  await expect(c.getByTestId("dsc-password")).toHaveText(PIN);
  await expect(c.getByRole("status")).toHaveText("Password shown for 30 seconds.");
  await expect(c.getByRole("button", { name: "Copy" })).toBeVisible();
  expect(await seriousAxe(page)).toEqual([]);
  await page.clock.runFor(31_000);
  await expect(c.getByTestId("dsc-password")).toHaveCount(0);
  await expect(c.getByRole("status")).toHaveText("Password hidden.");

  await c.getByRole("button", { name: "Show password of Ravi Director's DSC" }).click();
  await expect(c.getByTestId("dsc-password")).toHaveText(PIN);
  await c.getByRole("button", { name: "Hide" }).click();
  await expect(c.getByTestId("dsc-password")).toHaveCount(0);
});

test("AC-8, AC-9: give out and receive back; the record is re-used and the log shows both", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.goto(`/clients/${clientId}?tab=dsc`);
  const c = card(page, "Ravi Director");
  await c.getByRole("button", { name: "Give out Ravi Director's DSC" }).click();
  const out = page.getByRole("dialog", { name: "Give out: Ravi Director" });
  await out.getByLabel("Given to").fill("Client accountant");
  await out.getByLabel("Note").fill("For GST filing");
  await out.getByRole("button", { name: "Record given out" }).click();
  await expect(out).toBeHidden();
  await expect(c).toContainText("With Client accountant since");

  await c.getByRole("button", { name: "Received back: Ravi Director's DSC" }).click();
  const back = page.getByRole("dialog", { name: "Received back: Ravi Director" });
  await expect(back.getByLabel("Received back from")).toHaveValue("Client accountant");
  await back.getByRole("button", { name: "Record received back" }).click();
  await expect(back).toBeHidden();
  await expect(c).toContainText("In office");
  await c.getByText("Custody log (2)").click();
  await expect(c.getByRole("listitem")).toHaveCount(2);
  await expect(c.getByRole("listitem").first()).toContainText("Received back from Client accountant");
});

test("AC-4: Change password needs it twice; the reveal shows the new one", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.goto(`/clients/${clientId}?tab=dsc`);
  const c = card(page, "Ravi Director");
  await c.getByRole("button", { name: "Change password of Ravi Director's DSC" }).click();
  const d = page.getByRole("dialog", { name: "Change password: Ravi Director" });
  await d.getByLabel("New token PIN / password").fill(NEW_PIN);
  await d.getByLabel("Type it again").fill("something else");
  await d.getByRole("button", { name: "Change password" }).click();
  await expect(d).toContainText("The two passwords don't match.");
  await d.getByLabel("Type it again").fill(NEW_PIN);
  await d.getByRole("button", { name: "Change password" }).click();
  await expect(d).toBeHidden();
  await c.getByRole("button", { name: "Show password of Ravi Director's DSC" }).click();
  await expect(c.getByTestId("dsc-password")).toHaveText(NEW_PIN);
});

test("AC-5: a Manager archives with a reason and unarchives; Staff sees no Archive", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.goto(`/clients/${clientId}?tab=dsc`);
  // Wait for the card first, so the absence check means something (and the render isn't cut off mid-stream).
  await expect(card(page, "Ravi Director").getByRole("button", { name: /^Edit/ })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(card(page, "Ravi Director").getByRole("button", { name: /Archive/ })).toHaveCount(0);

  await signIn(page, u.manager.email, baseURL);
  await page.goto(`/clients/${clientId}?tab=dsc`);
  await card(page, "Ravi Director").getByRole("button", { name: "Archive Ravi Director's DSC" }).click();
  const d = page.getByRole("dialog", { name: "Archive DSC: Ravi Director?" });
  await d.getByLabel("Reason").fill("Director resigned");
  await d.getByRole("button", { name: "Archive DSC" }).click();
  await expect(d).toBeHidden();
  await expect(page.getByText("No DSCs yet.")).toBeVisible();
  await page.getByText("Show archived (1)").click();
  const c = card(page, "Ravi Director");
  await expect(c).toContainText("Archived");
  await expect(c).toContainText("Director resigned");
  await expect(c.getByRole("button", { name: /Show password/ })).toHaveCount(0);
  await c.getByRole("button", { name: "Unarchive Ravi Director's DSC" }).click();
  await expect(page.getByText("No DSCs yet.")).toHaveCount(0);
});

test("T4: Limited sees the tab and logs custody, but can't add, edit or show the password", async ({ page, baseURL }) => {
  const as = await signedInClient(u.staff.email);
  // The ciphertext shape only matters to the database here; this DSC is never revealed.
  const { error } = await as.rpc("dsc_save", { p: { client_id: limitedClientId, holder_name: "Lata Partner", expires_on: plusDays(100),
    password_ct: "ktest.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.bGltaXRlZA" } });
  if (error) throw error;
  await signIn(page, u.limited.email, baseURL);
  await page.goto(`/clients/${limitedClientId}?tab=dsc`);
  const c = card(page, "Lata Partner");
  await expect(c).toBeVisible();
  await expect(page.getByRole("button", { name: "Add DSC" })).toHaveCount(0);
  await expect(c.getByRole("button", { name: /Show password|Edit|Change password/ })).toHaveCount(0);
  await expect(c.getByRole("button", { name: "Give out Lata Partner's DSC" })).toBeVisible();
});

test("AC-10, AC-11: remind days in Settings; Today shows DSC expiring on Mine, linked to the DSC tab", async ({ page, baseURL }) => {
  const as = await signedInClient(u.staff.email);
  const { error } = await as.rpc("dsc_save", { p: { client_id: clientId, holder_name: "Soon Expiring", expires_on: plusDays(40),
    password_ct: "ktest.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.c29vbg" } });
  if (error) throw error;
  await signIn(page, u.staff.email, baseURL);
  await page.goto("/today");
  // Wait for the page itself, so the absence check means something (and the render isn't cut off mid-stream).
  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("region", { name: /DSC expiring/ })).toHaveCount(0); // 40 days > the default 30

  await page.goto(`/clients/${clientId}?tab=settings`);
  const days = page.getByLabel("Show on Today this many days before a DSC expires:");
  await expect(days).toHaveValue("30");
  await days.fill("45");
  await days.locator("xpath=ancestor::form").getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  await page.goto("/today");
  const section = page.getByRole("region", { name: /DSC expiring/ });
  await expect(section).toContainText("Soon Expiring");
  await expect(section).toContainText("Expires in 40 days");
  expect(await seriousAxe(page)).toEqual([]);
  await section.getByRole("link", { name: "Signature Traders" }).click();
  await expect(page).toHaveURL(new RegExp(`/clients/${clientId}\\?tab=dsc$`));
  await expect(card(page, "Soon Expiring")).toContainText("Expires in 40 days");
});
