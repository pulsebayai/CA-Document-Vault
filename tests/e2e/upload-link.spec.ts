import AxeBuilder from "@axe-core/playwright";
import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "./fixtures";
import "../support/setup-env";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, typeId } from "../support/documents";
import { T, bankOnlyClient, expectedItem, generateAsOf } from "../support/expected";

// Feature 10 step 5 — the public upload page (spec AC-6…AC-10, AC-14 ZIP refused). No staff session anywhere here.
// Fixture as in tests/rls/upload-links-public.test.ts: Bank statement only; clock 15 May 2026.

let officeId: string;
let staff: { id: string; email: string };
let admin: { id: string; email: string };
let client: string;
let token: string;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test.beforeAll(async () => {
  test.setTimeout(180_000);
  officeId = await createDocumentOffice("upload-page");
  admin = await createStaff(officeId, "upage-admin", "admin");
  staff = await createStaff(officeId, "upage-staff", "staff");
  const asAdmin = await signedInClient(admin.email);
  const asStaff = await signedInClient(staff.email);
  await generateAsOf(asAdmin, "2026-03-15");
  client = await bankOnlyClient(asStaff, officeId, { name: "Pondy Textiles", incharge_id: staff.id, email: "pondy@example.test", mobile: "9876543299" });
  await generateAsOf(asAdmin, "2026-05-15");
  token = randomBytes(32).toString("base64url");
  const { error } = await asStaff.rpc("record_link_whatsapp", { p: {
    client_id: client, token_hash: sha(token),
    items: [
      { kind: "scheduled", expected_doc_id: (await expectedItem(client, T.bank, "2026-03")).id },
      { kind: "ad_hoc", doc_type_id: await typeId(officeId, T.notice), needed_by: "2026-05-30", note: "for the new office lease" },
    ],
  } });
  if (error) throw new Error(error.message);
});
test.afterAll(async () => { await retireStaff([staff.id, admin.id]); });
test.describe.configure({ mode: "serial" });

test("AC-10: /u without a token shows 'not active' with no-referrer, noindex and no-store headers", async ({ page }) => {
  const res = await page.goto("/u");
  expect(res?.status()).toBe(200);
  const h = res!.headers();
  expect(h["referrer-policy"]).toBe("no-referrer");
  expect(h["x-robots-tag"]).toContain("noindex");
  expect(h["cache-control"]).toContain("no-store");
  await expect(page.getByRole("heading", { name: "This link is no longer active" })).toBeVisible();
  await page.goto("/u#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  await expect(page.getByRole("heading", { name: "This link is no longer active" })).toBeVisible();
});

test("AC-6: the page shows the firm, the requester, dates and the items — nothing about the client; 390 px; axe", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/u#${token}`);
  await expect(page.getByRole("heading", { name: "Upload your documents" })).toBeVisible();
  await expect(page.getByText(/Requested by Test on \d+ \w+ 2026 · open until 29 May 2026/)).toBeVisible();
  await expect(page.getByRole("heading", { name: `Banking · ${T.bank} · Mar 2026` })).toBeVisible();
  await expect(page.getByText("for the new office lease")).toBeVisible();
  await expect(page.getByText("Needed by 30 May 2026")).toBeVisible();
  const body = await page.locator("body").innerText();
  for (const secret of ["Pondy Textiles", "pondy@example.test", "9876543299", staff.email]) expect(body).not.toContain(secret);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations).toEqual([]);
});

test("AC-7, AC-11, AC-13: a PDF uploads, is filed for the requester To review, and the expected item becomes received", async ({ page }) => {
  await page.goto(`/u#${token}`);
  const card = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: `Banking · ${T.bank} · Mar 2026` }) });
  await card.locator('input[type="file"]').setInputFiles({ name: "march-statement.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });
  await expect(card.getByText("Uploaded ✓")).toBeVisible();
  await expect(card.getByText("Received")).toBeVisible();
  await expect(card.getByText("Add more files")).toBeVisible();
  const { data } = await adminClient().from("document").select("channel, status, received_by, client_id").eq("client_id", client).eq("channel", "upload_link");
  expect(data).toEqual([{ channel: "upload_link", status: "received", received_by: staff.id, client_id: client }]);
  expect((await expectedItem(client, T.bank, "2026-03")).status).toBe("received");
});

test("D3: a ZIP is refused before upload with a plain message", async ({ page }) => {
  await page.goto(`/u#${token}`);
  const card = page.getByRole("listitem").filter({ hasText: "for the new office lease" });
  await card.locator('input[type="file"]').setInputFiles({ name: "papers.zip", mimeType: "application/zip", buffer: Buffer.from("PK\u0003\u0004") });
  await expect(card.getByRole("alert")).toContainText("This file type can't be sent");
});

test("AC-10: staff pages still need sign-in", async ({ page }) => {
  await page.goto("/today");
  await expect(page).toHaveURL(/\/login$/);
});
