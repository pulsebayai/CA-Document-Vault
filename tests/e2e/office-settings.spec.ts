import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";
import "../support/setup-env";
import { adminClient, createStaff, createTestOffice, retireStaff } from "../support/db";
import { testOfficeName } from "../support/test-data";
import { signIn } from "./helpers";

// Feature 17 — Settings › Office (spec AC-9, AC-10). The office's name is restored after the edit: the fixture
// office is found by its name on the next run.

let officeId: string;
const name = testOfficeName("e2e-office");
let admin: { id: string; email: string };
let manager: { id: string; email: string };
const restore = () => adminClient().from("office").update({ name, branch: "test" }).eq("id", officeId);

test.beforeAll(async () => {
  officeId = await createTestOffice("e2e-office");
  await restore();
  admin = await createStaff(officeId, "office-admin", "admin");
  manager = await createStaff(officeId, "office-manager", "manager");
});
test.afterAll(async () => {
  await restore();
  await retireStaff([manager?.id, admin?.id].filter(Boolean) as string[]);
});

test("AC-9: an Admin renames the firm; the header follows and one activity row names the fields", async ({ page, baseURL }) => {
  try {
    await signIn(page, admin.email, baseURL);
    await page.goto("/settings/office");
    await expect(page.getByRole("heading", { name: "Office" })).toBeVisible();
    await expect(page.getByLabel("Firm name")).toHaveValue(name);
    await page.getByLabel("Firm name").fill(`${name} Renamed`);
    await page.getByLabel(/Branch/).fill("Chennai");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await expect(page.getByRole("banner").getByText(`${name} Renamed`)).toBeVisible();
    await expect.poll(async () => {
      const { data } = await adminClient().from("activity").select("data").eq("office_id", officeId)
        .eq("action", "office.updated").order("id", { ascending: false }).limit(1);
      return data?.[0]?.data ?? null;
    }).toEqual({ fields: ["name", "branch"] });
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(axe.violations).toEqual([]);
  } finally { await restore(); }
});

test("AC-9: an empty firm name is refused with a message on the field", async ({ page, baseURL }) => {
  await signIn(page, admin.email, baseURL);
  await page.goto("/settings/office");
  await page.getByLabel("Firm name").fill("   ");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Enter the firm's name.")).toBeVisible();
  await expect(page.getByLabel("Firm name")).toHaveAttribute("aria-invalid", "true");
  expect((await adminClient().from("office").select("name").eq("id", officeId).single()).data?.name).toBe(name);
});

test("AC-10: a Manager sees no Office item, and the URL shows Not Found", async ({ page, baseURL }) => {
  await signIn(page, manager.email, baseURL);
  await page.goto("/settings/catalogue");
  const nav = page.getByRole("navigation", { name: "Settings" });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole("link", { name: "Office" })).toHaveCount(0);
  await page.goto("/settings/office");
  await expect(page.getByText(/could not be found/i)).toBeVisible();
  await expect(page.getByLabel("Firm name")).toHaveCount(0);
});
