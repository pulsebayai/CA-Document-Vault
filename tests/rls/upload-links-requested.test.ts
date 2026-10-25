import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, typeId, uploadObject } from "../support/documents";
import { T, bankOnlyClient, expectedItem, generateAsOf } from "../support/expected";

// Feature 10 step 9 — Client › Requested (spec AC-16, AC-18): Send again carries open ad-hoc items over; staff
// "Upload" for an item files through 03's create_document and links the document in one transaction.
// Fixture as in upload-links-public: Bank statement only; clock 15 May 2026 → Mar, Apr pending.

type Who = "admin" | "staff" | "limited";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
const c = {} as Record<"a" | "b", string>;
let notice: string;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ip = () => sha(`ip-req-${Date.now()}-${Math.random()}`);
const admin = () => adminClient();
type Res = { data: Record<string, unknown> | null; error: { message: string } | null };
const call = (fn: string, args: Record<string, unknown>, client: SupabaseClient = admin()) =>
  client.rpc(fn, args) as unknown as Promise<Res>;
async function ok(p: Promise<Res>) { const r = await p; if (r.error) throw new Error(r.error.message); return r.data as Record<string, unknown>; }

async function send(who: SupabaseClient, client: string, items: unknown[], replaces?: string) {
  const token = randomBytes(32).toString("base64url");
  const r = await call("record_link_whatsapp", { p: { client_id: client, items, token_hash: sha(token), ...(replaces ? { replaces } : {}) } }, who);
  return { ...r, hash: sha(token) };
}
async function mustSend(who: SupabaseClient, client: string, items: unknown[], replaces?: string) {
  const r = await send(who, client, items, replaces);
  if (r.error) throw new Error(r.error.message);
  const requestId = r.data!.request_id as string;
  const { data: rows } = await admin().from("upload_request_item").select("id, kind, status").eq("request_id", requestId).order("created_at");
  return { requestId, hash: r.hash, items: rows as Array<{ id: string; kind: string; status: string }> };
}
async function linkUpload(hash: string, item: string) {
  const t = await ok(call("link_ticket", { p_token_hash: hash, p_item_id: item, p_file: { ext: "pdf", size: 60 }, p_ip_hash: ip() }));
  const obj = await uploadObject(t.office_id as string, "pdf", t.document_id as string);
  return ok(call("link_register", { p_token_hash: hash, p_item_id: item, p_file: { storage_path: obj.path, file_name: "x.pdf" }, p_ip_hash: ip() }));
}
const adhoc = (note?: string) => ({ kind: "ad_hoc", doc_type_id: notice, ...(note ? { note } : {}) });
const item = async (id: string) => (await admin().from("upload_request_item").select("request_id, status").eq("id", id).single()).data!;

beforeAll(async () => {
  officeId = await createDocumentOffice("upload-requested");
  u.admin = await createStaff(officeId, "urq-admin", "admin");
  u.staff = await createStaff(officeId, "urq-staff", "staff");
  u.limited = await createStaff(officeId, "urq-limited", "limited");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  await generateAsOf(as.admin, "2026-03-15");
  c.a = await bankOnlyClient(as.staff, officeId, { name: "Requested A", incharge_id: u.staff.id, email: "urqa@example.test", mobile: "9876541201" });
  c.b = await bankOnlyClient(as.staff, officeId, { name: "Requested B", incharge_id: u.staff.id, email: "urqb@example.test", mobile: "9876541202" });
  await generateAsOf(as.admin, "2026-05-15");
  notice = await typeId(officeId, T.notice);
}, 300_000);

afterAll(async () => { await retireStaff(Object.values(u).map((x) => x.id)); });

describe("Send again carries open ad-hoc items over (AC-18)", () => {
  it("open items move to the new request (same id); received items stay; the old link stops; the new one lists them", async () => {
    const first = await mustSend(as.staff, c.a, [{ kind: "scheduled", expected_doc_id: (await expectedItem(c.a, T.bank, "2026-03")).id }, adhoc("one"), adhoc("two")]);
    const [, open1, done] = first.items;
    await linkUpload(first.hash, done.id);
    expect((await item(done.id)).status).toBe("received");
    const pending = (await expectedItem(c.a, T.bank, "2026-03")).id;
    const again = await mustSend(as.staff, c.a, [{ kind: "scheduled", expected_doc_id: pending }, { kind: "carry", item_id: open1.id }], first.requestId);
    expect(await item(open1.id)).toEqual({ request_id: again.requestId, status: "open" });
    expect((await item(done.id)).request_id).toBe(first.requestId);
    const { data: old } = await admin().from("upload_request").select("revoked_at, replaced_by").eq("id", first.requestId).single();
    expect(old).toMatchObject({ replaced_by: again.requestId });
    expect(old!.revoked_at).not.toBeNull();
    expect(await ok(call("link_open", { p_token_hash: first.hash, p_ip_hash: ip() }))).toEqual({ active: false });
    const page = await ok(call("link_open", { p_token_hash: again.hash, p_ip_hash: ip() }));
    expect((page.items as Array<{ id: string }>).map((i) => i.id)).toEqual(expect.arrayContaining([open1.id]));
    expect(again.items.filter((i) => i.kind === "ad_hoc").map((i) => i.id)).toEqual([open1.id]); // moved, not copied
  });

  it("refuses to carry without replacing, an item of another request, and an item that isn't open", async () => {
    const first = await mustSend(as.staff, c.a, [adhoc()]);
    const other = await mustSend(as.staff, c.a, [adhoc()]);
    expect((await send(as.staff, c.a, [{ kind: "carry", item_id: first.items[0].id }])).error?.message).toMatch(/ITEM_STATE/);
    expect((await send(as.staff, c.a, [{ kind: "carry", item_id: other.items[0].id }], first.requestId)).error?.message).toMatch(/ITEM_STATE/);
    await ok(call("cancel_request_item", { p_id: first.items[0].id, p_reason: "not needed" }, as.staff));
    expect((await send(as.staff, c.a, [{ kind: "carry", item_id: first.items[0].id }], first.requestId)).error?.message).toMatch(/ITEM_STATE/);
    // nothing was written by the refused calls: the first link is still live
    const { data: still } = await admin().from("upload_request").select("revoked_at").eq("id", first.requestId).single();
    expect(still!.revoked_at).toBeNull();
  });
});

describe("Upload from Client › Requested (AC-16)", () => {
  const fileFor = async (who: SupabaseClient, itemId: string, extra: Record<string, unknown> = {}) => {
    const obj = await uploadObject(officeId, "pdf");
    return call("create_document_for_item", { p_item: itemId, p: {
      received_as: "soft_copy", channel: "email", received_on: "2026-05-15",
      file: { storage_path: obj.path, file_name: "notice.pdf" }, ...extra } }, who);
  };

  it("files the document with the item's client and type, links it, marks the item received and logs it", async () => {
    const link = await mustSend(as.staff, c.a, [adhoc()]);
    // Step 13 (review I-1): the form sends the item's own client and type; anything else is refused (upload-links-review-10b).
    const r = await fileFor(as.staff, link.items[0].id, { client_id: c.a, doc_type_id: notice });
    expect(r.error).toBeNull();
    const id = r.data!.id as string;
    const { data: d } = await admin().from("document").select("client_id, doc_type_id, channel, upload_request_item_id, status").eq("id", id).single();
    expect(d).toEqual({ client_id: c.a, doc_type_id: notice, channel: "email", upload_request_item_id: link.items[0].id, status: "received" });
    expect((await item(link.items[0].id)).status).toBe("received");
    const { data: act } = await admin().from("activity").select("actor_id, data").eq("entity_id", link.items[0].id).eq("action", "upload_request_item.filed");
    expect(act).toEqual([{ actor_id: u.staff.id, data: { client_id: c.a, document_id: id } }]);
  });

  it("refuses a cancelled item, and an item of a client the user can't see", async () => {
    const link = await mustSend(as.staff, c.a, [adhoc()]);
    await ok(call("cancel_request_item", { p_id: link.items[0].id, p_reason: "not needed" }, as.staff));
    expect((await fileFor(as.staff, link.items[0].id)).error?.message).toMatch(/ITEM_STATE/);
    const visible = await mustSend(as.staff, c.b, [adhoc()]);
    expect((await fileFor(as.limited, visible.items[0].id)).error?.message).toMatch(/NOT_FOUND/);
  });
});
