import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, mustCreateDocument, mustReview, mustSetCustody, mustMarkReady, periodId, typeId, uploadObject } from "../support/documents";
import { T } from "../support/expected";
import { signIn } from "./helpers";

// Feature 13 addendum (AC-21, AC-22) — Client › In office (R1 feedback, Sankar 2026-11-12): every hard copy the firm holds
// for the client, any FY, not in a live packet. Round 2 (Sankar, 2026-11-12: "everything we physically hold"): at any step —
// untagged, To review, reviewed but not yet placed, Document in office, Ready, Needs correction.

let officeId: string;
let staff: { id: string; email: string };
let limited: { id: string; email: string };
let clientId: string;
let emptyClientId: string;
const doc = {} as Record<"older" | "ready" | "correction" | "notPlaced" | "toReview" | "untagged" | "soft" | "other", { id: string; doc_code: string }>;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  officeId = await createDocumentOffice("in-office-ui");
  staff = await createStaff(officeId, "inoffice-staff", "staff");
  limited = await createStaff(officeId, "inoffice-limited", "limited");
  const as = await signedInClient(staff.email);
  const mkClient = async (name: string, incharge: string) => {
    const { data, error } = await as.rpc("create_client", { p: { name, client_type: "individual", incharge_id: incharge } });
    if (error) throw error;
    return data.id as string;
  };
  clientId = await mkClient("In Office Client", limited.id); // Limited sees this client
  emptyClientId = await mkClient("Nothing Held Client", staff.id);
  const otherClientId = await mkClient("Other Held Client", staff.id);
  const bank = await typeId(officeId, T.bank);
  const hard = async (client: string, type: string, period: string, extra: Record<string, unknown> = {}) =>
    mustCreateDocument(as, { client_id: client, doc_type_id: type, period_id: await periodId(officeId, period),
      received_as: "hard_copy", received_on: "2026-05-02", handed_over_name: "Client's accountant", channel: "hand_delivery", ...extra } as never);

  doc.older = await hard(clientId, await typeId(officeId, "Form 16 from employer"), "2025-26", { returnable: false }); // an older FY
  doc.ready = await hard(clientId, bank, "2026-04", { returnable: true });
  doc.correction = await hard(clientId, bank, "2026-05");
  doc.notPlaced = await hard(clientId, bank, "2026-06");
  doc.other = await hard(otherClientId, bank, "2026-04");
  doc.toReview = await hard(clientId, bank, "2026-07");
  // Untagged: the client is known, the type isn't yet (13's Log receipt without a type).
  doc.untagged = await mustCreateDocument(as, { client_id: clientId, received_as: "hard_copy", received_on: "2026-05-02",
    handed_over_name: "Client's accountant", channel: "hand_delivery" } as never);
  const obj = await uploadObject(officeId, "pdf");
  doc.soft = await mustCreateDocument(as, { received_as: "soft_copy", channel: "email", client_id: clientId, doc_type_id: bank,
    period_id: await periodId(officeId, "2026-03"), file: { storage_path: obj.path, file_name: "soft.pdf" } });

  for (const d of [doc.older, doc.ready, doc.notPlaced, doc.other]) await mustReview(as, d.id);
  await mustReview(as, doc.correction.id, "needs_correction", "Wrong account number");
  // Marked in this order, so "longest held first" is older → ready → correction.
  await mustSetCustody(as, [doc.older.id], "in_office");
  await mustMarkReady(as, doc.ready.id);
  await mustSetCustody(as, [doc.correction.id], "in_office");
  await mustSetCustody(as, [doc.other.id], "in_office");
});
test.afterAll(async () => { await retireStaff([staff?.id, limited?.id].filter(Boolean) as string[]); });
test.describe.configure({ mode: "serial" });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id);
}

test("AC-21, AC-22: the tab lists every held copy of this client (any FY, Needs correction included), longest held first; axe", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/clients/${clientId}`);
  const tabs = page.getByRole("navigation", { name: "Client sections" });
  await tabs.getByRole("link", { name: "In office" }).click();
  await expect(page).toHaveURL(new RegExp(`/clients/${clientId}\\?tab=office$`));
  await expect(tabs.getByRole("link", { name: "In office" })).toHaveAttribute("aria-current", "page");

  const rows = page.getByRole("list", { name: "Hard copies in office" });
  await expect(rows.getByRole("listitem")).toHaveCount(6);
  await expect(page.getByText("6 documents · 3 not yet placed in office")).toBeVisible();
  // Order: not yet placed (held since received on, 2 May) by DOC-ID, then marked in office first → last.
  const order = [doc.notPlaced, doc.toReview, doc.untagged, doc.older, doc.ready, doc.correction];
  for (const [i, d] of order.entries()) await expect(rows.getByRole("listitem").nth(i)).toContainText(d.doc_code);
  const row = (d: { doc_code: string }) => rows.getByRole("listitem").filter({ hasText: d.doc_code });
  await expect(row(doc.notPlaced).getByTestId("doc-state")).toHaveText(/^Reviewed/);
  await expect(row(doc.notPlaced).getByRole("button", { name: /^Mark in office/ })).toBeVisible(); // its next step, here too
  await expect(row(doc.toReview).getByTestId("doc-state")).toHaveText("To review");
  await expect(row(doc.untagged).getByTestId("doc-state")).toHaveText("Untagged");
  await expect(row(doc.ready)).toContainText("Ready to dispatch");
  await expect(row(doc.correction)).toContainText("Needs correction"); // still held, with its own state
  // Not here: another client's copy, a soft copy.
  await expect(rows).not.toContainText(doc.other.doc_code);
  await expect(rows).not.toContainText(doc.soft.doc_code);
  expect(await seriousAxe(page)).toEqual([]);
});

test("AC-21: a client with nothing held says so and links to All documents", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto(`/clients/${emptyClientId}?tab=office`);
  await expect(page.getByText("No hard copies in the office for this client.")).toBeVisible();
  await page.getByRole("link", { name: "See all documents" }).click();
  await expect(page).toHaveURL(new RegExp(`/clients/${emptyClientId}\\?tab=all$`));
});

test("AC-21, AC-22: a Limited user sees the tab for a client they can see; 390 px fits", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, limited.email, baseURL);
  await page.goto(`/clients/${clientId}?tab=office`);
  await expect(page.getByRole("list", { name: "Hard copies in office" }).getByRole("listitem")).toHaveCount(6);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await seriousAxe(page)).toEqual([]);
});
