import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";
import "../support/setup-env";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { groupId } from "../support/catalogue";
import { createDocumentOffice, mustCreateDocument } from "../support/documents";
import { signIn } from "./helpers";

// Feature 05 step 4 — Settings › Catalogue decision queue (spec AC-1 … AC-3, AC-5, AC-8, AC-9; mockup 05).
// The database rules are proven in tests/rls/type-governance.test.ts; this proves the screens drive them.

let officeId: string;
let staff: { id: string; email: string };
let admin: { id: string; email: string };
let clientId: string;
const type = {} as Record<"locker" | "cards" | "gate" | "petty", string>;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  officeId = await createDocumentOffice("governance-ui");
  staff = await createStaff(officeId, "govui-staff", "staff");
  admin = await createStaff(officeId, "govui-admin", "admin");
  const asStaff = await signedInClient(staff.email);
  const { data: c, error } = await asStaff.rpc("create_client", { p: { name: "Governance Client", client_type: "individual", incharge_id: staff.id } });
  if (error) throw error;
  clientId = c.id;
  const propose = async (group: string, name: string) => {
    const { data, error: e } = await asStaff.rpc("create_proposed_type", { p_client_id: clientId, p_doc_group_id: await groupId(officeId, group), p_name: name });
    if (e) throw e;
    return (data as { doc_type_id: string }).doc_type_id;
  };
  type.locker = await propose("Banking", "Locker slips");
  type.cards = await propose("Other", "Visiting cards");
  type.gate = await propose("Other", "Gate passes");
  type.petty = await propose("Accounting", "Petty vouchers");
  await mustCreateDocument(asStaff, { client_id: clientId, doc_type_id: type.locker });
});
test.afterAll(async () => { await retireStaff([staff?.id, admin?.id].filter(Boolean) as string[]); });

const panelOf = (page: import("@playwright/test").Page) => page.getByRole("region", { name: /Proposed by staff/ });
const itemOf = (page: import("@playwright/test").Page, name: string) =>
  panelOf(page).getByRole("list", { name: "Proposed types" }).getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });

test("AC-1: Admin sees the queue with the four decisions; Reject is disabled while documents use the type (AC-9)", async ({ page, baseURL }) => {
  await signIn(page, admin.email, baseURL);
  await page.goto("/settings/catalogue");
  const panel = panelOf(page);
  await expect(panel).toContainText("4 waiting");
  const locker = itemOf(page, "Locker slips");
  await expect(locker).toContainText("Banking · by Test govui-staff");
  await expect(locker).toContainText("1 document");
  await locker.getByText("Used on 1 client").click();
  await expect(locker.getByRole("link", { name: "Governance Client" })).toHaveAttribute("href", `/clients/${clientId}`);
  await expect(locker.getByRole("button", { name: "Reject" })).toBeDisabled();
  await expect(locker).toContainText("1 document uses this type. Merge it into an approved type instead.");
  const axe = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id)).toEqual([]);
});

test("AC-5, AC-8: Merge into… shows what will happen, then moves the document", async ({ page, baseURL }) => {
  await signIn(page, admin.email, baseURL);
  await page.goto("/settings/catalogue");
  await itemOf(page, "Locker slips").getByRole("button", { name: "Merge Locker slips into an approved type" }).click();
  const dialog = page.getByRole("dialog", { name: /Merge “Locker slips”/ });
  await dialog.getByRole("searchbox", { name: "Find the approved type" }).fill("bank statement");
  await dialog.getByRole("radio", { name: /^Bank statement/ }).check();
  const what = dialog.getByRole("list", { name: "What will happen" });
  await expect(what).toContainText("1 document on 1 client move to Bank statement.");
  await expect(what).toContainText("Review and dispatch states stay.");
  const axe = await new AxeBuilder({ page }).include("dialog[open]").withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id)).toEqual([]);
  await dialog.getByRole("button", { name: "Merge", exact: true }).click();
  await expect(itemOf(page, "Locker slips")).toHaveCount(0);
  const { data } = await adminClient().from("doc_type").select("status, mapped_to_id").eq("id", type.locker).single();
  expect(data!.status).toBe("mapped");
});

test("AC-9: Reject needs a reason, then retires the type", async ({ page, baseURL }) => {
  await signIn(page, admin.email, baseURL);
  await page.goto("/settings/catalogue");
  await itemOf(page, "Visiting cards").getByRole("button", { name: "Reject Visiting cards" }).click();
  const dialog = page.getByRole("dialog", { name: /Reject “Visiting cards”/ });
  await dialog.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(dialog.getByText("Give a reason (up to 500 characters).").first()).toBeVisible();
  await dialog.getByRole("textbox", { name: "Reason" }).fill("Not a compliance document");
  await dialog.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(itemOf(page, "Visiting cards")).toHaveCount(0);
  const { data } = await adminClient().from("doc_type").select("status, decision_comment").eq("id", type.cards).single();
  expect(data).toEqual({ status: "rejected", decision_comment: "Not a compliance document" });
});

test("AC-2, AC-3: Approve as proposed, and Edit & approve with a new name", async ({ page, baseURL }) => {
  await signIn(page, admin.email, baseURL);
  await page.goto("/settings/catalogue");
  await itemOf(page, "Gate passes").getByRole("button", { name: "Approve Gate passes", exact: true }).click();
  const approve = page.getByRole("dialog", { name: /Approve “Gate passes”/ });
  await expect(approve.getByRole("list", { name: "What will happen" })).toContainText("becomes an approved type, offered for every client");
  await approve.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(itemOf(page, "Gate passes")).toHaveCount(0);
  // Approved types join the catalogue list of their group.
  await expect(page.getByRole("region", { name: "Other", exact: true }).getByRole("row", { name: /Gate passes/ })).toBeVisible();

  await itemOf(page, "Petty vouchers").getByRole("button", { name: "Edit and approve Petty vouchers" }).click();
  const edit = page.getByRole("dialog", { name: /Edit & approve “Petty vouchers”/ });
  await edit.getByRole("textbox", { name: "Name" }).fill("Petty cash book");
  await edit.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(itemOf(page, "Petty vouchers")).toHaveCount(0);
  const { data } = await adminClient().from("doc_type").select("name, status, aliases").eq("id", type.petty).single();
  expect(data).toEqual({ name: "Petty cash book", status: "approved", aliases: ["Petty vouchers"] });
  await expect(panelOf(page)).toContainText("No proposed types waiting.");
});

test("AC-10: Staff don't get the queue", async ({ page, baseURL }) => {
  await signIn(page, staff.email, baseURL);
  await page.goto("/settings/catalogue");
  await expect(page.getByRole("heading", { name: "Document catalogue" })).toBeVisible();
  await expect(panelOf(page)).toHaveCount(0);
});

test("AC-13: the proposer's bell — count, the decisions' text, opening marks them read; 390 px; axe", async ({ page, baseURL }) => {
  // Runs after the decision tests above (serial file): Merge, Reject, Approve and Edit & approve each notified the proposer.
  await signIn(page, staff.email, baseURL);
  await page.goto("/settings/catalogue");
  const bell = page.getByRole("button", { name: "Notifications, 4 unread" });
  await expect(bell).toBeVisible();
  await bell.click();
  const panel = page.getByRole("region", { name: "Notifications" });
  await expect(panel).toContainText("Locker slips was merged into Bank statement.");
  await expect(panel).toContainText("Visiting cards was rejected: Not a compliance document");
  await expect(panel).toContainText("Gate passes (Other) was approved.");
  await expect(panel).toContainText("Petty cash book (Accounting) was approved.");
  await expect(panel).not.toContainText("Governance Client"); // a notification never names a client
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).map((v) => v.id)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Notifications", exact: true })).toBeFocused();
  await page.reload();
  await expect(page.getByRole("button", { name: "Notifications", exact: true })).toBeVisible(); // read: no count

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await expect(page.getByRole("region", { name: "Notifications" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("AC-16: Settings › Collection shows metric 3 and the queue's age", async ({ page, baseURL }) => {
  // Self-contained: one new proposal with one document; the expected figures are counted from the database.
  const asStaff = await signedInClient(staff.email);
  const { data, error } = await asStaff.rpc("create_proposed_type", { p_client_id: clientId, p_doc_group_id: await groupId(officeId, "Other"), p_name: "Fresh slips" });
  if (error) throw error;
  await mustCreateDocument(asStaff, { client_id: clientId, doc_type_id: (data as { doc_type_id: string }).doc_type_id });
  const { data: docs } = await adminClient().from("document").select("doc_type:doc_type_id (status)")
    .eq("office_id", officeId).not("classified_at", "is", null).is("archived_at", null);
  const rows = (docs ?? []) as unknown as Array<{ doc_type: { status: string } }>;
  const approved = rows.filter((d) => d.doc_type.status === "approved").length;
  const pct = Math.round((1000 * approved) / rows.length) / 10;
  const { data: waiting } = await adminClient().from("doc_type").select("id").eq("office_id", officeId).eq("status", "proposed");
  const items = waiting!.length; // one proposal per name here, so rows = items

  await signIn(page, admin.email, baseURL);
  await page.goto("/settings/collection");
  const figures = page.locator('dl[aria-label="Catalogue figures"]');
  await expect(figures).toContainText("Filed under approved types");
  await expect(figures).toContainText(`${pct.toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`);
  await expect(figures).toContainText(`${approved} of ${rows.length} documents`);
  await expect(page.getByRole("link", { name: `${items} ${items === 1 ? "proposal" : "proposals"} waiting` })).toHaveAttribute("href", "/settings/catalogue");
  await expect(page.getByText(/oldest 0 days/)).toBeVisible();
});
