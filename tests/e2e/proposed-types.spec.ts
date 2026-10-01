import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";
import "../support/setup-env";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { groupId } from "../support/catalogue";
import { createDocumentOffice, mustCreateDocument } from "../support/documents";
import { signIn } from "./helpers";

// Feature 03 step 8 — "Proposed by staff" panel (mockup 05, read-only until 05) and the "Proposed" badge in
// Client › Settings (spec AC-15, AC-16).

let officeId: string;
let staff: { id: string; email: string };
let admin: { id: string; email: string };
let clientId: string;

test.beforeAll(async () => {
  officeId = await createDocumentOffice("proposed-ui");
  staff = await createStaff(officeId, "ptypes-staff", "staff");
  admin = await createStaff(officeId, "ptypes-admin", "admin");
  const asStaff = await signedInClient(staff.email);
  const { data: c, error } = await asStaff.rpc("create_client", { p: { name: "Proposal Client", client_type: "individual", incharge_id: staff.id } });
  if (error) throw error;
  clientId = c.id;
  const { data: p, error: e2 } = await asStaff.rpc("create_proposed_type", {
    p_client_id: clientId, p_doc_group_id: await groupId(officeId, "Banking"), p_name: "Locker rent receipt",
  });
  if (e2) throw e2;
  await mustCreateDocument(asStaff, { client_id: clientId, doc_type_id: (p as { doc_type_id: string }).doc_type_id });
});
test.afterAll(async () => { await retireStaff([staff?.id, admin?.id].filter(Boolean) as string[]); });

test("AC-16: an Admin sees the proposal with its group, proposer, client and document count — read-only", async ({ page, baseURL }) => {
  await signIn(page, admin.email, baseURL);
  await page.goto("/settings/catalogue");
  const panel = page.getByRole("region", { name: /Proposed by staff/ });
  await expect(panel).toContainText("coming with feature 05");
  const item = panel.getByRole("list", { name: "Proposed types" }).getByRole("listitem");
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("Locker rent receipt");
  await expect(item).toContainText("Banking · by Test ptypes-staff");
  await expect(item).toContainText("1 document");
  await expect(item.getByRole("link", { name: "Proposal Client" })).toHaveAttribute("href", `/clients/${clientId}`);
  await expect(panel.getByRole("button")).toHaveCount(0); // no approve/reject in 03
  // Proposed types never appear in the catalogue's own lists (they aren't approved).
  await expect(page.getByRole("region", { name: "Banking", exact: true }).getByText("Locker rent receipt")).toHaveCount(0);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id)).toEqual([]);
});

test("AC-16: Staff don't get the approval panel", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto("/settings/catalogue");
  await expect(page.getByRole("heading", { name: "Document catalogue" })).toBeVisible();
  await expect(page.getByRole("region", { name: /Proposed by staff/ })).toHaveCount(0);
});

test("AC-15: Client › Settings shows the proposed type in its own group, badged 'Proposed'", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/clients/${clientId}?tab=settings`); // 04 AC-14: Documents is the default client tab; Settings is ?tab=settings (Raja 2026-10-01, option A)
  const banking = page.getByRole("region", { name: "Banking", exact: true });
  await expect(banking).toContainText("Locker rent receipt");
  await expect(banking).toContainText("Proposed");
});
