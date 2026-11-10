import { expect, test } from "./fixtures";
import "../support/setup-env";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice } from "../support/documents";
import { T, bankOnlyClient, generateAsOf } from "../support/expected";
import { pickType, signIn } from "./helpers";

// R1 staging finding F3 (owner 2026-11-10): Client › Requested › "Request documents" opens the link dialog with the
// upload link on, one "other document" row and no open item ticked, so an ad-hoc-only request is one step. The
// client's address ends in .test, so the email is recorded as suppressed (06: nothing leaves the vault).

let officeId: string;
const u = {} as Record<"admin" | "staff", { id: string; email: string }>;
let client: string;

test.beforeAll(async () => {
  test.setTimeout(150_000);
  officeId = await createDocumentOffice("request-docs");
  u.admin = await createStaff(officeId, "reqdocs-admin", "admin");
  u.staff = await createStaff(officeId, "reqdocs-staff", "staff");
  const asAdmin = await signedInClient(u.admin.email);
  const asStaff = await signedInClient(u.staff.email);
  await generateAsOf(asAdmin, "2026-03-15");
  client = await bankOnlyClient(asStaff, officeId, { name: "Kaveri Textiles", incharge_id: u.staff.id, email: "kaveri@example.test", mobile: "9876543278" });
  await generateAsOf(asAdmin, "2026-05-15");
});
test.afterAll(async () => { await retireStaff(Object.values(u).map((x) => x.id)); });

test("F3: Request documents on Client › Requested sends a link with only the other document", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.goto(`/clients/${client}?tab=requested`);
  await page.getByRole("button", { name: "Request documents from Kaveri Textiles" }).click();
  const dialog = page.getByRole("dialog", { name: "Request documents from Kaveri Textiles" });
  await expect(dialog.getByRole("switch", { name: "Include upload link" })).toBeChecked();
  await expect(dialog.getByRole("group", { name: "Open documents" }).getByRole("checkbox").first()).not.toBeChecked();
  await pickType(page, T.notice);
  await dialog.getByLabel("Note for the client (optional)").fill("for the new office lease");
  await expect(dialog.getByRole("region", { name: "Message preview" })).toContainText(`${T.notice} — for the new office lease`);
  await dialog.getByRole("button", { name: "Send email" }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "open until" })).toBeVisible();

  const { data: reqs } = await adminClient().from("upload_request").select("id, upload_request_item (kind)").eq("client_id", client);
  expect(reqs).toHaveLength(1);
  expect((reqs![0].upload_request_item as Array<{ kind: string }>).map((i) => i.kind)).toEqual(["ad_hoc"]);

  await dialog.getByRole("button", { name: "Close" }).click();
  await page.reload();
  await expect(page.getByRole("list", { name: "Requested documents" })).toContainText(T.notice);
});
