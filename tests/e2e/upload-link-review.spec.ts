import { createHash, randomBytes } from "node:crypto";
import { expect, test, type Page } from "./fixtures";
import "../support/setup-env";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, typeId, uploadObject } from "../support/documents";
import { T, bankOnlyClient, generateAsOf } from "../support/expected";
import { signIn } from "./helpers";

// Feature 10 step 7 — what staff see of a link upload (spec AC-13, AC-14, AC-15): the "From client link" badge on
// Client › Documents, /documents and the document page; download only until reviewed (D3); the channel filter
// "Upload link"; the requester's bell (D6). The upload is made through the public functions, as the page does.

let officeId: string;
const u = {} as Record<"admin" | "staff", { id: string; email: string }>;
let client: string;
let docCode: string;
let docId: string;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test.beforeAll(async () => {
  test.setTimeout(150_000);
  officeId = await createDocumentOffice("upload-review");
  u.admin = await createStaff(officeId, "urev-admin", "admin");
  u.staff = await createStaff(officeId, "urev-staff", "staff");
  const asAdmin = await signedInClient(u.admin.email);
  const asStaff = await signedInClient(u.staff.email);
  await generateAsOf(asAdmin, "2026-03-15");
  client = await bankOnlyClient(asStaff, officeId, { name: "Karaikal Fisheries", incharge_id: u.staff.id, email: "fish@example.test", mobile: "9876543266" });
  await generateAsOf(asAdmin, "2026-05-15");
  const token = randomBytes(32).toString("base64url");
  const sent = await asStaff.rpc("record_link_whatsapp", { p: { client_id: client, token_hash: sha(token),
    items: [{ kind: "ad_hoc", doc_type_id: await typeId(officeId, T.notice), note: "the notice you received" }] } });
  if (sent.error) throw new Error(sent.error.message);
  const { data: item } = await adminClient().from("upload_request_item").select("id").eq("request_id", (sent.data as { request_id: string }).request_id).single();
  const ip = sha("e2e-review");
  const t = await adminClient().rpc("link_ticket", { p_token_hash: sha(token), p_item_id: item!.id, p_file: { ext: "pdf", size: 60 }, p_ip_hash: ip });
  if (t.error) throw new Error(t.error.message);
  const obj = await uploadObject((t.data as { office_id: string }).office_id, "pdf", (t.data as { document_id: string }).document_id);
  const r = await adminClient().rpc("link_register", { p_token_hash: sha(token), p_item_id: item!.id, p_file: { storage_path: obj.path, file_name: "notice.pdf" }, p_ip_hash: ip });
  if (r.error) throw new Error(r.error.message);
  docCode = (r.data as { doc_code: string }).doc_code;
  docId = (r.data as { document_id: string }).document_id;
});
test.afterAll(async () => { await retireStaff(Object.values(u).map((x) => x.id)); });
test.describe.configure({ mode: "serial" });

const rowOf = (page: Page, code: string) => page.getByRole("listitem").filter({ hasText: code });

test("AC-15: the requester's bell says files arrived, naming the client", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.getByRole("button", { name: /^Notifications, 1 unread$/ }).click();
  await expect(page.getByRole("region", { name: "Notifications" })).toContainText("Files arrived from Karaikal Fisheries through your upload link");
});

test("AC-13, D3: Client › Documents shows the badge and no View until the document is reviewed", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.goto(`/clients/${client}`);
  const row = rowOf(page, docCode);
  await expect(row.getByText("From client link")).toBeVisible();
  await expect(row.getByRole("button", { name: `View ${docCode}` })).toHaveCount(0);
  await expect(row.getByRole("button", { name: `Download ${docCode}` })).toBeVisible();
  await expect(row.getByText("Sent by the client — review before opening in the browser.")).toBeVisible();
  await row.getByRole("button", { name: /Mark reviewed/ }).click();
  await expect(row.getByRole("button", { name: `View ${docCode}` })).toBeVisible();
});

test("AC-13: /documents filters by channel Upload link and shows the badge; the document page names the channel", async ({ page, baseURL }) => {
  await signIn(page, u.staff.email, baseURL);
  await page.goto(`/documents?client=${client}&channel=upload_link`);
  const hit = page.getByRole("listitem").filter({ hasText: docCode });
  await expect(hit.getByText("From client link")).toBeVisible();
  await expect(hit).toContainText("Upload link");
  await page.goto(`/documents/${docId}`);
  await expect(page.getByText("From client link").first()).toBeVisible();
  await expect(page.getByText("Upload link").first()).toBeVisible();
});
