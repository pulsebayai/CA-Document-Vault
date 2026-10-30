import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";
import "../support/setup-env";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, mustCreateDocument, mustCreateOriginal, periodId, typeId } from "../support/documents";
import { T, bankOnlyClient, generateAsOf } from "../support/expected";
import { signIn } from "./helpers";

// Feature 06 step 9 — Today's To review / Ready to dispatch rows (spec AC-2, AC-5) using 07's controls.
// Clock 15 Mar 2026 (nothing expected is asked yet, so the card holds documents only):
//   Delta Docs (incharge staff): a hard copy To review, and a reviewed original Ready to dispatch.

let officeId: string;
const u = {} as Record<"admin" | "staff", { id: string; email: string }>;
let client: string;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  officeId = await createDocumentOffice("today-docs-ui");
  u.admin = await createStaff(officeId, "tddui-admin", "admin");
  u.staff = await createStaff(officeId, "tddui-staff", "staff");
  const asAdmin = await signedInClient(u.admin.email);
  const asStaff = await signedInClient(u.staff.email);
  await generateAsOf(asAdmin, "2026-03-15");
  client = await bankOnlyClient(asStaff, officeId, { name: "Delta Docs", incharge_id: u.staff.id });
  const bank = await typeId(officeId, T.bank);
  await mustCreateDocument(asStaff, { client_id: client, doc_type_id: bank, period_id: await periodId(officeId, "2026-02"), received_on: "2026-03-10", received_as: "hard_copy" });
  await mustCreateOriginal(asStaff, { client_id: client, doc_type_id: bank, period_id: await periodId(officeId, "2026-01"), received_on: "2026-03-05" }, asStaff);
});
test.afterAll(async () => { await retireStaff(Object.values(u).map((x) => x.id)); });
test.describe.configure({ mode: "serial" });

test("step 9: To review and Ready to dispatch on Today — counts, rows, Mark reviewed; axe", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.goto("/today");
  await expect(page.getByText(/1 client needs something/)).toBeVisible();
  await expect(page.getByRole("button", { name: "1 To review" })).toBeVisible();
  await expect(page.getByRole("button", { name: "1 Ready to dispatch" })).toBeVisible();
  const rows = page.getByRole("list", { name: "Open documents for Delta Docs" });
  await expect(rows.getByRole("listitem")).toHaveCount(2);
  await expect(rows.getByRole("listitem").nth(0)).toContainText("Received 10 Mar · waiting for review");
  await expect(rows.getByRole("listitem").nth(1)).toContainText("Returnable"); // 12 (spec AC-11): badge renamed
  await expect(rows.getByRole("listitem").nth(1)).toContainText("Ready to dispatch");
  await expect(rows.getByRole("button", { name: /^Mark dispatched: DOC-FY/ })).toBeVisible();
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id)).toEqual([]);

  await page.getByRole("button", { name: "1 Ready to dispatch" }).click();
  await expect(page).toHaveURL(/\/today\?show=ready$/);
  await expect(rows.getByRole("listitem")).toHaveCount(1);
  await page.getByRole("button", { name: "1 Ready to dispatch" }).click();

  await rows.getByRole("button", { name: /^Mark reviewed: DOC-FY/ }).click();
  await expect(page.getByRole("button", { name: "0 To review" })).toBeVisible();
  await expect(rows.getByRole("listitem")).toHaveCount(1);
});
