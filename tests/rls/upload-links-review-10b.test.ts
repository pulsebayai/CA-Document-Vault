import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { groupId, mergeType, mustOk, proposeType, rejectType } from "../support/catalogue";
import { createDocumentOffice, typeId, uploadObject } from "../support/documents";
import { T, bankOnlyClient, generateAsOf, mustRpc } from "../support/expected";

// Feature 10 step 13 — fixes from the pre-PR review of 10b (migration J). Each failed on the code before it.
//   I-1  create_document_for_item refuses another client / type / period than the item's (ITEM_MISMATCH).
//   I-2  a 05 merge of the proposed type an item asks for keeps the item Received (re-pointed to the target).
//   N-6  Send again refuses to carry an item whose type can no longer be requested.
//   N-2  Today cards carry requested_overdue (badge tone).

type Who = "admin" | "manager" | "staff";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
let client: string;
let notice: string;
let other: string;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ip = () => sha(`ip-10b-${Date.now()}-${Math.random()}`);

async function send(items: unknown[], replaces?: string) {
  const token = randomBytes(32).toString("base64url");
  const r = await as.staff.rpc("record_link_whatsapp", { p: { client_id: client, token_hash: sha(token), items, ...(replaces ? { replaces } : {}) } });
  if (r.error) return { error: r.error.message } as const;
  const requestId = (r.data as { request_id: string }).request_id;
  const { data } = await adminClient().from("upload_request_item").select("id").eq("request_id", requestId);
  return { hash: sha(token), requestId, item: (data as Array<{ id: string }>)[0].id };
}
async function mustSend(items: unknown[]) { const r = await send(items); if ("error" in r) throw new Error(r.error); return r; }
async function linkUpload(hash: string, item: string) {
  const t = await mustRpc<{ office_id: string; document_id: string }>(adminClient(), "link_ticket",
    { p_token_hash: hash, p_item_id: item, p_file: { ext: "pdf", size: 60 }, p_ip_hash: ip() });
  const obj = await uploadObject(t.office_id, "pdf", t.document_id);
  return mustRpc<{ document_id: string }>(adminClient(), "link_register",
    { p_token_hash: hash, p_item_id: item, p_file: { storage_path: obj.path, file_name: "x.pdf" }, p_ip_hash: ip() });
}
const itemRow = async (id: string) => (await adminClient().from("upload_request_item").select("status, doc_type_id").eq("id", id).single()).data!;

beforeAll(async () => {
  officeId = await createDocumentOffice("upload-10b-review");
  u.admin = await createStaff(officeId, "u10b-admin", "admin");
  u.manager = await createStaff(officeId, "u10b-manager", "manager");
  u.staff = await createStaff(officeId, "u10b-staff", "staff");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  await generateAsOf(as.admin, "2026-03-15");
  client = await bankOnlyClient(as.staff, officeId, { name: "Review 10b Client", incharge_id: u.staff.id, email: "u10b@example.test", mobile: "9876541501" });
  notice = await typeId(officeId, T.notice);
  other = await groupId(officeId, "Other");
}, 300_000);
afterAll(async () => { await retireStaff(Object.values(u).map((x) => x.id)); });

describe("I-1: Upload for a requested item files exactly what was requested", () => {
  it("refuses another type or client; accepts the item's own", async () => {
    const link = await mustSend([{ kind: "ad_hoc", doc_type_id: notice }]);
    const file = async (p: Record<string, unknown>) => {
      const obj = await uploadObject(officeId, "pdf");
      return as.staff.rpc("create_document_for_item", { p_item: link.item, p: { received_as: "soft_copy", channel: "email",
        file: { storage_path: obj.path, file_name: "n.pdf" }, ...p } });
    };
    expect((await file({ client_id: client, doc_type_id: await typeId(officeId, T.bank) })).error?.message).toMatch(/ITEM_MISMATCH/);
    expect((await file({ client_id: crypto.randomUUID(), doc_type_id: notice })).error?.message).toMatch(/ITEM_MISMATCH/);
    expect((await file({ client_id: client, doc_type_id: notice })).error).toBeNull();
  });
});

describe("I-2: merging the proposed type an item asks for keeps it Received", () => {
  it("the item follows its documents to the approved type", async () => {
    const proposed = await proposeType(as.staff, client, other, `Lease papers ${Date.now()}`);
    const link = await mustSend([{ kind: "ad_hoc", doc_type_id: proposed }]);
    await linkUpload(link.hash, link.item);
    expect((await itemRow(link.item)).status).toBe("received");
    await mustOk(mergeType(as.manager, proposed, notice));
    expect(await itemRow(link.item)).toEqual({ status: "received", doc_type_id: notice });
    const page = await mustRpc<{ items: Array<{ id: string; files: number }> }>(adminClient(), "link_open", { p_token_hash: link.hash, p_ip_hash: ip() });
    expect(page.items.find((i) => i.id === link.item)?.files).toBe(1);
  });
});

describe("N-6: Send again doesn't carry an item whose type can't be requested any more", () => {
  it("a rejected proposed type stops the carry", async () => {
    const proposed = await proposeType(as.staff, client, other, `Odd paper ${Date.now()}`);
    const link = await mustSend([{ kind: "ad_hoc", doc_type_id: proposed }]);
    await mustOk(rejectType(as.manager, proposed, "not a document we collect"));
    const again = await send([{ kind: "carry", item_id: link.item }], link.requestId);
    expect("error" in again && again.error).toMatch(/ITEM_STATE/);
  });
});

describe("N-2: Today cards carry requested_overdue", () => {
  it("counts the card's overdue requested rows", async () => {
    await generateAsOf(as.admin, "2026-03-15");
    const link = await mustSend([{ kind: "ad_hoc", doc_type_id: notice, needed_by: "2026-03-16" }]);
    await generateAsOf(as.admin, "2026-03-20");
    const d = await mustRpc<{ cards: Array<{ client_id: string; requested_overdue: number; rows: Array<{ item_id?: string }> }> }>(
      as.staff, "today_items", { p_scope: "mine", p_show: "requested", p_page: 0, p_limit: 100 });
    const card = d.cards.find((c) => c.client_id === client)!;
    expect(card.rows.map((r) => r.item_id)).toContain(link.item);
    expect(card.requested_overdue).toBeGreaterThanOrEqual(1);
  });
});
