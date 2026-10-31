import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, mustCreateDocument, uploadObject } from "../support/documents";
import { pickType, signIn } from "./helpers";

// Feature 03 step 6 — Inbox, Assign and the nav count (mockup 02; spec AC-7 … AC-9).

let officeId: string;
let staff: { id: string; email: string };
let limited: { id: string; email: string };
const docs = {} as Record<"courier" | "scan" | "onLimitedsClient" | "limitedOwn", { id: string; doc_code: string }>;

test.beforeAll(async () => {
  officeId = await createDocumentOffice("inbox-ui");
  staff = await createStaff(officeId, "inbox-staff", "staff");
  limited = await createStaff(officeId, "inbox-limited", "limited");
  const asStaff = await signedInClient(staff.email);
  const asLimited = await signedInClient(limited.email);
  const { error } = await asStaff.rpc("create_client", { p: { name: "Inbox Traders", client_type: "individual", incharge_id: staff.id } });
  if (error) throw error;
  docs.courier = await mustCreateDocument(asStaff, { received_as: "hard_copy", channel: "courier", remark: "from Blue Dart, sender unclear" });
  const obj = await uploadObject(officeId, "pdf");
  docs.scan = await mustCreateDocument(asStaff, { received_as: "soft_copy", channel: "whatsapp", file: { storage_path: obj.path, file_name: "Scan_0912.pdf" } });
  // Review fix: a Staff member's unclassified item on the Limited user's own client (visible to them by RLS, AC-12)
  // must not appear in the Limited user's Inbox — their Inbox is what they added (AC-9).
  const { data: lc, error: e2 } = await asStaff.rpc("create_client", { p: { name: "Limited's Client", client_type: "individual", incharge_id: limited.id } });
  if (e2) throw e2;
  docs.onLimitedsClient = await mustCreateDocument(asStaff, { received_as: "hard_copy", channel: "email", client_id: lc.id });
  docs.limitedOwn = await mustCreateDocument(asLimited, { received_as: "original", channel: "hand_delivery" });
});
test.afterAll(async () => { await retireStaff([staff?.id, limited?.id].filter(Boolean) as string[]); });
test.describe.configure({ mode: "serial" });

async function seriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id);
}
const inboxLink = (page: Page) => page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Untagged/ });
const items = (page: Page) => page.getByRole("list", { name: "Untagged documents" }).getByRole("listitem");

test("AC-7, AC-9: staff see every unclassified document, newest first, with what's missing and how long it waited", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await expect(inboxLink(page)).toHaveAccessibleName(/Untagged, 4 waiting/);
  await inboxLink(page).click();
  await expect(page.getByRole("heading", { name: "Untagged documents" })).toBeVisible();
  await expect(items(page)).toHaveCount(4);
  await expect(items(page).first()).toContainText(docs.limitedOwn.doc_code); // newest first
  const courier = items(page).filter({ hasText: docs.courier.doc_code });
  await expect(courier).toContainText("Hard copy · from Courier · remark: “from Blue Dart, sender unclear”");
  await expect(courier).toContainText(/No client · No type · waiting \d+ min/);
  await expect(items(page).filter({ hasText: docs.scan.doc_code })).toContainText("Scan_0912.pdf");
  expect(await seriousAxe(page)).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("AC-9: a Limited user sees only the Inbox items they added", async ({ page, baseURL }) => {
  await signIn(page, limited.email, baseURL);
  await expect(inboxLink(page)).toHaveAccessibleName(/Untagged, 1 waiting/);
  await page.goto("/inbox");
  await expect(items(page)).toHaveCount(1);
  await expect(items(page).first()).toContainText(docs.limitedOwn.doc_code);
  await expect(page.getByText(docs.onLimitedsClient.doc_code)).toHaveCount(0);
  // Someone else's Inbox item: Not Found, not an error page with data.
  await page.goto(`/documents/${docs.courier.id}/assign`);
  await expect(page.getByText(/not found|could not be found/i).first()).toBeVisible();
});

test("AC-8: Assign opens the form with what is known; client + type files it and records classified_at once", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto("/inbox");
  await page.getByRole("link", { name: `Assign ${docs.courier.doc_code}` }).click();
  await expect(page.getByRole("heading", { name: "Assign document" })).toBeVisible();
  await expect(page.getByText(docs.courier.doc_code)).toBeVisible();
  await expect(page.getByLabel("Remark")).toHaveValue("from Blue Dart, sender unclear");
  await expect(page.getByRole("radio", { name: "Hard copy" })).toBeChecked();
  expect(await seriousAxe(page)).toEqual([]);

  await page.getByRole("combobox", { name: "Client", exact: true }).fill("Inbox Tr");
  await page.getByRole("listbox", { name: "Matching clients" }).getByRole("button", { name: /Inbox Traders/ }).click();
  await pickType(page, "Form 16 from employer"); // 12: type-ahead field
  await page.getByRole("button", { name: "Save to vault" }).click();

  await page.waitForURL(/\/inbox\?saved=/);
  await expect(page.getByRole("status").filter({ hasText: "saved" })).toContainText(docs.courier.doc_code);
  await expect(items(page)).toHaveCount(3);
  await expect(page.getByRole("link", { name: `Assign ${docs.courier.doc_code}` })).toHaveCount(0);
  await expect(inboxLink(page)).toHaveAccessibleName(/Untagged, 3 waiting/);
  const { data } = await adminClient().from("document").select("classified_at, client_id, doc_type_id").eq("id", docs.courier.id).single();
  expect(data!.classified_at).not.toBeNull();
  expect(data!.client_id).not.toBeNull();
});

test("AC-4: a document added from the Inbox (header button) comes back to the Inbox with its DOC-ID", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto("/inbox");
  await page.getByRole("banner").getByRole("link", { name: "Add document" }).click();
  // Wait for the form: on a deployed preview the page takes ~1 s, and "Hard copy" also labels Inbox rows (run 36455393633).
  await expect(page.getByRole("heading", { name: "Add document" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save as untagged" })).toBeEnabled(); // form is interactive
  await page.locator("label").filter({ has: page.getByRole("radio", { name: "Hard copy" }) }).click(); // the radio is sr-only
  await expect(page.getByRole("radio", { name: "Hard copy" })).toBeChecked();
  await page.getByLabel("Handed over by").fill("Client's accountant"); // 12 (AC-14, approved 2026-10-30)
  await page.getByRole("button", { name: "Save as untagged" }).click();
  await page.waitForURL(/\/inbox\?saved=/);
  const saved = await page.getByRole("status").filter({ hasText: "saved" }).innerText();
  const code = /DOC-FY\d{2}-\d{2}-\d{5}/.exec(saved)![0];
  await expect(items(page).filter({ hasText: code })).toHaveCount(1);
});

test("AC-7: an empty Inbox says so", async ({ page, baseURL }) => {
  const other = await createDocumentOffice("inbox-ui-empty");
  const u = await createStaff(other, "inbox-empty-staff", "staff");
  try {
    await signIn(page, u.email, baseURL);
    await page.goto("/inbox");
    await expect(page.getByText("No untagged documents — everything received has a client and a type.")).toBeVisible();
    await expect(inboxLink(page)).toHaveAccessibleName("Untagged");
  } finally {
    await retireStaff([u.id]);
  }
});
