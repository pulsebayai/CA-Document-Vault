import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "./fixtures";
import "../support/setup-env";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, typeId } from "../support/documents";
import { T, bankOnlyClient, generateAsOf } from "../support/expected";
import { signIn, typeFieldValue } from "./helpers";

// Feature 10 step 10 — Today (spec AC-17, D7): the requester sees the Requested count, a requested row with Upload
// (Add document pre-filled for the item), and the note for items with no date soon. The incharge doesn't.

let officeId: string;
const u = {} as Record<"admin" | "incharge" | "requester", { id: string; email: string }>;
let client: string;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test.beforeAll(async () => {
  test.setTimeout(150_000);
  officeId = await createDocumentOffice("upload-today-ui");
  u.admin = await createStaff(officeId, "utdy-admin", "admin");
  u.incharge = await createStaff(officeId, "utdy-incharge", "staff");
  u.requester = await createStaff(officeId, "utdy-requester", "staff");
  const asAdmin = await signedInClient(u.admin.email);
  await generateAsOf(asAdmin, "2026-03-10");
  client = await bankOnlyClient(await signedInClient(u.incharge.email), officeId,
    { name: "Mahe Exports", incharge_id: u.incharge.id, email: "mahe@example.test", mobile: "9876543255" });
  const notice = await typeId(officeId, T.notice);
  const { error } = await (await signedInClient(u.requester.email)).rpc("record_link_whatsapp", { p: {
    client_id: client, token_hash: sha(randomBytes(32).toString("base64url")),
    items: [
      { kind: "ad_hoc", doc_type_id: notice, needed_by: "2026-03-12", note: "for the bank loan" },
      { kind: "ad_hoc", doc_type_id: notice, note: "whenever ready" },
    ],
  } });
  if (error) throw new Error(error.message);
  await generateAsOf(asAdmin, "2026-03-15");
});
test.afterAll(async () => { await retireStaff(Object.values(u).map((x) => x.id)); });
test.describe.configure({ mode: "serial" });

test("AC-17: the requester's Today shows the Requested count, the overdue row with Upload, and the undated note", async ({ page, baseURL }) => {
  await signIn(page, u.requester.email, baseURL);
  await page.goto("/today");
  await expect(page.getByRole("button", { name: /2\s*Requested/ })).toBeVisible();
  const card = page.getByRole("list", { name: "Open documents for Mahe Exports" });
  const row = card.getByRole("listitem").filter({ hasText: "for the bank loan" });
  await expect(row).toContainText(/^Requested · .+/);
  await expect(row).toContainText(T.notice);
  await expect(row).toContainText("Overdue");
  await expect(page.getByText(/1 requested document has no needed-by date in the next 7 days/)).toBeVisible();
  await page.getByRole("button", { name: /2\s*Requested/ }).click();
  await expect(page).toHaveURL(/show=requested/);
  await expect(card.getByRole("listitem")).toHaveCount(1);
  await row.getByRole("link", { name: /^Upload Requested/ }).click();
  await expect(page.getByRole("heading", { name: "Add document" })).toBeVisible();
  await expect(page).toHaveURL(/item=[0-9a-f-]{36}/);
  await expect(page.getByRole("combobox", { name: "Document type" })).toHaveValue(typeFieldValue(T.notice)); // 12: type-ahead field
});

test("AC-17: the incharge's Today (Mine) doesn't show someone else's request", async ({ page, baseURL }) => {
  await signIn(page, u.incharge.email, baseURL);
  await page.goto("/today");
  await expect(page.getByRole("button", { name: /0\s*Requested/ })).toBeVisible();
  await expect(page.getByText("for the bank loan")).toHaveCount(0);
});
