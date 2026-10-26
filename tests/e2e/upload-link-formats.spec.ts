import AxeBuilder from "@axe-core/playwright";
import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "./fixtures";
import "../support/setup-env";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice } from "../support/documents";
import { T, bankOnlyClient, expectedItem, generateAsOf } from "../support/expected";
import { seedPreferences } from "../support/formats";

// Feature 11 step 6 — preferred formats on the public upload page (spec AC-9, AC-10, AC-12, AC-13).
// The client sees the hint and a warning, and can always upload anyway; nothing is refused for format.
// Test offices start with no preferences (migration C), so this file switches on the real seed explicitly.

let officeId: string;
let staff: { id: string; email: string };
let admin: { id: string; email: string };
let client: string;
let token: string;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test.beforeAll(async () => {
  test.setTimeout(180_000);
  officeId = await createDocumentOffice("upload-formats");
  await seedPreferences(officeId);
  admin = await createStaff(officeId, "ufmt-admin", "admin");
  staff = await createStaff(officeId, "ufmt-staff", "staff");
  const asAdmin = await signedInClient(admin.email);
  const asStaff = await signedInClient(staff.email);
  await generateAsOf(asAdmin, "2026-03-15");
  client = await bankOnlyClient(asStaff, officeId, { name: "Format Traders", incharge_id: staff.id, mobile: "9876543288" });
  await generateAsOf(asAdmin, "2026-05-15");
  token = randomBytes(32).toString("base64url");
  const { error } = await asStaff.rpc("record_link_whatsapp", { p: {
    client_id: client, token_hash: sha(token),
    items: [{ kind: "scheduled", expected_doc_id: (await expectedItem(client, T.bank, "2026-03")).id }],
  } });
  if (error) throw new Error(error.message);
});
test.afterAll(async () => { await retireStaff([staff?.id, admin?.id].filter(Boolean) as string[]); });
test.describe.configure({ mode: "serial" });

const card = (page: import("@playwright/test").Page) =>
  page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: `Banking · ${T.bank} · Mar 2026` }) });
const linkUploads = async () => {
  const { data, error } = await adminClient().from("document").select("id, format_ok").eq("client_id", client).eq("channel", "upload_link")
    .order("created_at");
  if (error) throw error;
  return data ?? [];
};

test("AC-9, AC-12: the item shows its preferred formats; a PDF gets a warning the client can pass; 390 px; axe", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/u#${token}`);
  const item = card(page);
  await expect(item.getByText("Excel or CSV preferred")).toBeVisible();
  await item.locator('input[type="file"]').setInputFiles({ name: "march.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });
  const warn = item.getByRole("group", { name: /This document is preferred as Excel or CSV/ });
  await expect(warn).toBeVisible();
  await expect(warn.getByRole("button", { name: "Choose another file" })).toBeFocused();
  expect(await linkUploads()).toEqual([]); // nothing uploaded until the client decides
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations).toEqual([]);

  await warn.getByRole("button", { name: "Upload anyway" }).click();
  await expect(item.getByText("Uploaded ✓")).toBeVisible();
  const docs = await linkUploads();
  expect(docs).toEqual([{ id: expect.any(String), format_ok: false }]);
  const { data: act } = await adminClient().from("activity").select("data").eq("entity_id", docs[0].id).eq("action", "document.link_upload").single();
  expect(act!.data).toMatchObject({ warned: true }); // AC-13
});

test("AC-10: a preferred file uploads with no warning and no flag", async ({ page }) => {
  await page.goto(`/u#${token}`);
  const item = card(page);
  await item.locator('input[type="file"]').setInputFiles({ name: "march.csv", mimeType: "text/csv", buffer: Buffer.from("date,amount\n2026-03-01,100\n") });
  await expect(item.getByText("Uploaded ✓")).toBeVisible();
  await expect(item.getByRole("group", { name: /preferred as/ })).toHaveCount(0);
  const docs = await linkUploads();
  expect(docs.map((d) => d.format_ok)).toEqual([false, true]);
  const { data: act } = await adminClient().from("activity").select("data").eq("entity_id", docs[1].id).eq("action", "document.link_upload").single();
  expect(act!.data).not.toHaveProperty("warned");
});
