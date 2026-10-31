import AxeBuilder from "@axe-core/playwright";
import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "./fixtures";
import "../support/setup-env";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, TINY, typeId } from "../support/documents";
import { T, bankOnlyClient, generateAsOf } from "../support/expected";
import { signIn, typeFieldValue } from "./helpers";

// Feature 10 step 9 — Client › Requested (spec AC-16, AC-18): the tab with its count, Upload (Add document pre-filled
// and linked to the item), Cancel with a reason, Reopen, and Send again by WhatsApp (open items carried over).

let officeId: string;
const u = {} as Record<"admin" | "staff", { id: string; email: string }>;
let client: string;
let requestId: string;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test.beforeAll(async () => {
  test.setTimeout(150_000);
  officeId = await createDocumentOffice("upload-requested-ui");
  u.admin = await createStaff(officeId, "ureq-admin", "admin");
  u.staff = await createStaff(officeId, "ureq-staff", "staff");
  const asAdmin = await signedInClient(u.admin.email);
  const asStaff = await signedInClient(u.staff.email);
  await generateAsOf(asAdmin, "2026-03-15");
  client = await bankOnlyClient(asStaff, officeId, { name: "Karaikal Traders", incharge_id: u.staff.id, email: "karaikal@example.test", mobile: "9876543266" });
  await generateAsOf(asAdmin, "2026-05-15");
  const notice = await typeId(officeId, T.notice);
  const { data, error } = await asStaff.rpc("record_link_whatsapp", { p: {
    client_id: client, token_hash: sha(randomBytes(32).toString("base64url")),
    items: [
      { kind: "ad_hoc", doc_type_id: notice, needed_by: "2026-05-30", note: "for the new office lease" },
      { kind: "ad_hoc", doc_type_id: notice, note: "the second notice" },
      { kind: "ad_hoc", doc_type_id: notice, note: "not needed after all" },
    ],
  } });
  if (error) throw new Error(error.message);
  requestId = (data as { request_id: string }).request_id;
});
test.afterAll(async () => { await retireStaff(Object.values(u).map((x) => x.id)); });
test.describe.configure({ mode: "serial" });

const itemRow = (page: import("./fixtures").Page, note: string) =>
  page.getByRole("list", { name: "Requested documents" }).getByRole("listitem").filter({ hasText: note });

test("AC-16: the Requested tab lists the ad-hoc items with their count, and passes axe at phone width", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/clients/${client}?tab=requested`);
  await expect(page.getByRole("link", { name: /Requested\s*3/ })).toHaveAttribute("aria-current", "page");
  const row = itemRow(page, "for the new office lease");
  await expect(row).toContainText(T.notice);
  await expect(row).toContainText("needed by 30 May");
  await expect(row).toContainText("Link open");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("AC-16: Cancel needs a reason and closes the item", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.goto(`/clients/${client}?tab=requested`);
  await itemRow(page, "not needed after all").getByRole("button", { name: `Cancel ${T.notice}` }).click();
  const dialog = page.getByRole("dialog", { name: `Cancel ${T.notice}` });
  await expect(dialog.getByRole("button", { name: "Cancel request" })).toBeDisabled();
  await dialog.getByLabel("Reason").fill("client sent it by hand");
  await dialog.getByRole("button", { name: "Cancel request" }).click();
  await expect(itemRow(page, "not needed after all")).toContainText("Cancelled: client sent it by hand");
  await expect(page.getByRole("link", { name: /Requested\s*2/ })).toBeVisible();
});

test("AC-16: Upload opens Add document pre-filled; saving files it for the item, which becomes Received; Reopen", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.goto(`/clients/${client}?tab=requested`);
  await itemRow(page, "for the new office lease").getByRole("link", { name: `Upload ${T.notice}` }).click();
  await expect(page.getByRole("heading", { name: "Add document" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Document type" })).toHaveValue(typeFieldValue(T.notice)); // 12: type-ahead field
  await page.locator('input[type="file"]').setInputFiles({ name: "lease-notice.pdf", mimeType: "application/pdf", buffer: TINY.pdf.bytes });
  await expect(page.getByText("Uploaded", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save to vault" }).click();
  await page.waitForURL(new RegExp(`/clients/${client}\\?tab=requested&saved=`));
  const row = itemRow(page, "for the new office lease");
  await expect(row).toContainText("Received");
  await expect(row).toContainText("1 file");
  const { data: items } = await adminClient().from("upload_request_item").select("id, status").eq("note", "for the new office lease").eq("request_id", requestId);
  const { data: docs } = await adminClient().from("document").select("channel, upload_request_item_id").eq("upload_request_item_id", items![0].id);
  expect(docs).toEqual([{ channel: "whatsapp", upload_request_item_id: items![0].id }]); // staff filed it: no link badge
  await row.getByRole("button", { name: `Reopen ${T.notice}` }).click();
  await expect(itemRow(page, "for the new office lease").getByText("Open", { exact: true })).toBeVisible();
});

test("AC-18: Send again by WhatsApp carries the open items to a new link and the old one stops", async ({ page, baseURL, context }) => {
  await signIn(page, u.staff.email, baseURL);
  await context.route("https://wa.me/**", (route) => route.fulfill({ status: 200, body: "wa" }));
  await page.goto(`/clients/${client}?tab=requested`);
  await page.getByRole("list", { name: "Upload links, newest first" }).getByRole("button", { name: /^Send again/ }).click();
  const dialog = page.getByRole("dialog", { name: "Send the link again" });
  await expect(dialog.getByRole("listitem")).toHaveCount(2); // the two open notices; the cancelled one stays behind
  const [tab] = await Promise.all([context.waitForEvent("page"), dialog.getByRole("button", { name: "Open WhatsApp" }).click()]);
  await tab.waitForURL(/^https:\/\/wa\.me\/919876543266\?text=/);
  const text = decodeURIComponent(new URL(tab.url()).searchParams.get("text") ?? "");
  expect(text).toContain("the second notice");
  await expect(dialog.getByText(/The old link no longer works/)).toBeVisible();
  const { data: old } = await adminClient().from("upload_request").select("replaced_by").eq("id", requestId).single();
  expect(old!.replaced_by).not.toBeNull();
  const { data: moved } = await adminClient().from("upload_request_item").select("request_id").eq("note", "the second notice").eq("office_id", officeId); // this office only: other runs (lanes, local) use the same note
  expect(moved).toEqual([{ request_id: old!.replaced_by }]);
});

test("AC-23: Settings › Collection shows the upload-link section to an Admin", async ({ page, baseURL }) => {
  await signIn(page, u.admin.email, baseURL);
  await page.goto("/settings/collection");
  await expect(page.getByRole("heading", { name: "Upload links" })).toBeVisible();
  // This office's only requested item was filed by staff and then reopened, so nothing counts yet (figures are
  // pinned in tests/rls/upload-links-metrics.test.ts).
  await expect(page.getByText(/No documents came through upload links in these 30 days\./)).toBeVisible();
});
