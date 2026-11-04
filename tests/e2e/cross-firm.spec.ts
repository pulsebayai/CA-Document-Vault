import { randomBytes } from "node:crypto";
import { expect, test } from "./fixtures";
import "../support/setup-env";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { insertClient } from "../support/catalogue";
import { createDocumentOffice, mustCreateDocument, type NewDocument } from "../support/documents";
import { mustSaveDsc, newDsc } from "../support/dsc";
import { signIn } from "./helpers";

// Feature 18 — cross-firm, screen by screen (spec AC-13, X6 c). Firm A's Admin opens Firm B's pages by URL and searches
// for Firm B's text: every page answers Not Found or shows nothing of B's, and no page carries B's marker. Control:
// the same pages of Firm A's own client work.

const marker = `XFB${randomBytes(4).toString("hex")}`;
let adminA: { id: string; email: string };
let staffB: { id: string; email: string };
const ids = {} as Record<"aClient" | "aDoc" | "bClient" | "bDoc" | "bDsc", string>;
const aMarker = `XFA${randomBytes(4).toString("hex")}`;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const a = await createDocumentOffice("xfirm-e2e-a");
  const b = await createDocumentOffice("xfirm-e2e-b");
  adminA = await createStaff(a, "xfirm-e2e-a-admin", "admin");
  staffB = await createStaff(b, "xfirm-e2e-b-staff", "staff");
  const asA = await signedInClient(adminA.email);
  const asB = await signedInClient(staffB.email);
  const ca = await insertClient(asA, a, { name: `${aMarker} own client`, client_type: "individual", incharge_id: adminA.id });
  if (ca.error) throw ca.error;
  ids.aClient = ca.data!.id as string;
  ids.aDoc = (await mustCreateDocument(asA, { client_id: ids.aClient, received_on: "2026-05-02", remark: `${aMarker} remark`, handed_over_name: "XF" } as NewDocument)).id;
  const cb = await insertClient(asB, b, { name: `${marker} Client`, client_type: "individual", incharge_id: staffB.id });
  if (cb.error) throw cb.error;
  ids.bClient = cb.data!.id as string;
  ids.bDoc = (await mustCreateDocument(asB, { client_id: ids.bClient, received_on: "2026-05-02", remark: `${marker} remark`, handed_over_name: "XF" } as NewDocument)).id;
  ids.bDsc = await mustSaveDsc(asB, newDsc(ids.bClient, { holder_name: `${marker} Holder` }));
});
test.afterAll(async () => { await retireStaff([adminA?.id, staffB?.id].filter(Boolean) as string[]); });

const NOT_FOUND = /could not be found/i;

test("AC-13: Firm B's client page, on every tab, is Not Found for Firm A's Admin; Firm A's own client opens", async ({ page, baseURL }) => {
  test.slow();
  await signIn(page, adminA.email, baseURL);
  for (const tab of ["", "?tab=all", "?tab=expected", "?tab=requested", "?tab=dsc", "?tab=settings"]) {
    await page.goto(`/clients/${ids.bClient}${tab}`);
    await expect(page.getByText(NOT_FOUND), `tab ${tab || "documents"}`).toBeVisible();
    expect(await page.content(), `tab ${tab || "documents"}`).not.toContain(marker);
  }
  await page.goto(`/clients/${ids.aClient}?tab=dsc`);
  await expect(page.getByRole("heading", { name: `${aMarker} own client` })).toBeVisible();
});

test("AC-13: Firm B's document page is Not Found; its activity and Firm B's DSC never show", async ({ page, baseURL }) => {
  await signIn(page, adminA.email, baseURL);
  await page.goto(`/documents/${ids.bDoc}`);
  await expect(page.getByText(NOT_FOUND)).toBeVisible();
  expect(await page.content()).not.toContain(marker);
  await page.goto(`/activity?document=${ids.bDoc}`);
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
  expect(await page.content()).not.toContain(marker);
  // controls (review N-7): Firm A's own document page opens, and its activity lists the document being added
  await page.goto(`/documents/${ids.aDoc}`);
  await expect(page.getByText(NOT_FOUND)).toHaveCount(0);
  await expect(page.getByText(`${aMarker} remark`)).toBeVisible();
  await page.goto(`/activity?document=${ids.aDoc}`);
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
  await expect(page.locator("main li").first()).toBeVisible();
});

test("AC-13: searching for Firm B's text finds nothing of Firm B's (header suggestions and /documents)", async ({ page, baseURL }) => {
  await signIn(page, adminA.email, baseURL);
  const box = page.getByRole("combobox", { name: "Search clients and documents" });
  await box.fill(marker);
  await expect(page.getByRole("option", { name: new RegExp(`See all results for “${marker}”`) })).toBeVisible();
  await expect(page.getByText("No matching clients or documents.")).toBeVisible();
  expect(await page.getByRole("listbox", { name: "Search suggestions" }).innerText()).not.toContain(`${marker} Client`);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/documents/);
  await expect(page.getByRole("searchbox", { name: "Search documents" })).toHaveValue(marker);
  await expect(page.getByText("No documents match.")).toBeVisible();
  expect(await page.content()).not.toContain(`${marker} remark`);
  // control: the same search for Firm A's own text finds Firm A's client
  await box.fill(aMarker);
  await expect(page.getByRole("listbox", { name: "Search suggestions" }).getByText(`${aMarker} own client`).first()).toBeVisible();
});
