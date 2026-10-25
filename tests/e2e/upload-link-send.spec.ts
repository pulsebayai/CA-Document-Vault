import { expect, test } from "./fixtures";
import "../support/setup-env";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice } from "../support/documents";
import { T, bankOnlyClient, generateAsOf } from "../support/expected";
import { signIn } from "./helpers";

// Feature 10 step 6 — sending an upload link from the Remind dialog (spec AC-1…AC-4, AC-18). The client's address
// ends in .test, so the email is recorded as suppressed (06: nothing leaves the vault) — the link flow is the same.

let officeId: string;
const u = {} as Record<"admin" | "staff", { id: string; email: string }>;
let client: string;

test.beforeAll(async () => {
  test.setTimeout(150_000);
  officeId = await createDocumentOffice("upload-send");
  u.admin = await createStaff(officeId, "usend-admin", "admin");
  u.staff = await createStaff(officeId, "usend-staff", "staff");
  const asAdmin = await signedInClient(u.admin.email);
  const asStaff = await signedInClient(u.staff.email);
  await generateAsOf(asAdmin, "2026-03-15");
  client = await bankOnlyClient(asStaff, officeId, { name: "Auroville Crafts", incharge_id: u.staff.id, email: "crafts@example.test", mobile: "9876543277" });
  await generateAsOf(asAdmin, "2026-05-15");
});
test.afterAll(async () => { await retireStaff(Object.values(u).map((x) => x.id)); });
test.describe.configure({ mode: "serial" });

async function openRemind(page: import("./fixtures").Page) {
  await page.goto(`/clients/${client}?tab=expected`);
  await page.getByRole("button", { name: "Remind Auroville Crafts" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Remind Auroville Crafts" });
  await expect(dialog.getByRole("group", { name: "Open documents" })).toBeVisible();
  return dialog;
}

test("AC-4: a note with personal data is flagged as you type and sending is blocked", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  const dialog = await openRemind(page);
  await dialog.getByRole("switch", { name: "Include upload link" }).click();
  await dialog.getByRole("button", { name: "+ Request another document" }).click();
  await dialog.getByLabel("Document type").selectOption({ label: T.notice });
  await dialog.getByLabel("Note for the client (optional)").fill("PAN ABCDE1234F");
  await expect(dialog.getByText("Notes are shown to anyone with the link — remove numbers and IDs.").first()).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Send email" })).toBeDisabled();
});

test("AC-1, AC-2, AC-18: link with a scheduled and an ad-hoc item; preview without the token; send; revoke", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  const dialog = await openRemind(page);
  await dialog.getByRole("switch", { name: "Include upload link" }).click();
  await dialog.getByRole("button", { name: "+ Request another document" }).click();
  await dialog.getByLabel("Document type").selectOption({ label: T.notice });
  await dialog.getByLabel("Needed by (optional)").fill("2026-05-30");
  await dialog.getByLabel("Note for the client (optional)").fill("for the new office lease");
  const preview = dialog.getByRole("region", { name: "Message preview" });
  await expect(preview).toContainText("You can upload them securely here (open until 29 May):");
  await expect(preview).toContainText("‹secure upload link›");
  await expect(preview).toContainText(`${T.notice} — for the new office lease — needed by 30 May`);
  await dialog.getByRole("button", { name: "Send email" }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "open until 29 May" })).toBeVisible();

  const { data: reqs } = await adminClient().from("upload_request").select("id, follow_up_id, revoked_at, upload_request_item (kind)").eq("client_id", client);
  expect(reqs).toHaveLength(1);
  expect((reqs![0].upload_request_item as Array<{ kind: string }>).map((i) => i.kind).sort()).toEqual(["ad_hoc", "scheduled", "scheduled"]);
  const { data: fu } = await adminClient().from("follow_up").select("status, channel").eq("id", reqs![0].follow_up_id).single();
  expect(fu).toEqual({ status: "suppressed", channel: "email" });

  await dialog.getByRole("button", { name: "Revoke" }).click();
  await expect(dialog.getByText("Link revoked — it no longer works.")).toBeVisible();
  const { data: after } = await adminClient().from("upload_request").select("revoked_by").eq("id", reqs![0].id).single();
  expect(after!.revoked_by).toBe(u.staff.id);
});

test("AC-2: WhatsApp with a link opens wa.me with the link in the text and records the request", async ({ page, baseURL, context }) => {
  await signIn(page, u.staff.email, baseURL);
  await context.route("https://wa.me/**", (route) => route.fulfill({ status: 200, body: "wa" }));
  const dialog = await openRemind(page);
  await dialog.getByRole("switch", { name: "Include upload link" }).click();
  const [tab] = await Promise.all([context.waitForEvent("page"), dialog.getByRole("button", { name: "Open WhatsApp" }).click()]);
  await tab.waitForURL(/^https:\/\/wa\.me\/919876543277\?text=/);
  const text = decodeURIComponent(new URL(tab.url()).searchParams.get("text") ?? "");
  expect(text).toMatch(/\/u#[A-Za-z0-9_-]{43}\n/);
  await expect(dialog.getByText(/WhatsApp opened with the link — press Send there · open until 29 May/)).toBeVisible();
  const { count } = await adminClient().from("upload_request").select("id", { count: "exact", head: true }).eq("client_id", client).is("revoked_at", null);
  expect(count).toBe(1);
});
