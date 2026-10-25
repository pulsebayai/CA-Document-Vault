import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocument, createDocumentOffice, createSoftCopy, mustReview, typeId, uploadObject } from "../support/documents";
import { T, bankOnlyClient, generateAsOf } from "../support/expected";

// Feature 10 step 8 — the fixes from the pre-PR review and the security review of 10a (migration
// 20261025163857_upload_links_review_fixes; plan.md Deviations, step 8). Each test fails on the code before the fix.
// Fixture as in upload-links-public: Bank statement only; clock 15 May 2026.

type Who = "admin" | "manager" | "staff" | "staff2";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
const c = {} as Record<"a" | "b", string>;
let notice: string;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ip = (n = 1) => sha(`ip-review-${n}-${Date.now()}-${Math.random()}`);
const admin = () => adminClient();
type Res = { data: Record<string, unknown> | null; error: { message: string } | null };
const call = (fn: string, args: Record<string, unknown>, client: SupabaseClient = admin()) =>
  client.rpc(fn, args) as unknown as Promise<Res>;
async function ok(p: Promise<Res>) { const r = await p; if (r.error) throw new Error(r.error.message); return r.data as Record<string, unknown>; }

async function sendLink(who: SupabaseClient, client: string, items: unknown[] = [{ kind: "ad_hoc", doc_type_id: notice }], replaces?: string) {
  const token = randomBytes(32).toString("base64url");
  const res = await call("record_link_whatsapp", { p: { client_id: client, items, token_hash: sha(token), ...(replaces ? { replaces } : {}) } }, who);
  if (res.error) return { error: res.error.message } as const;
  const { data: rows } = await admin().from("upload_request_item").select("id").eq("request_id", res.data!.request_id);
  return { hash: sha(token), requestId: res.data!.request_id as string, item: (rows as Array<{ id: string }>)[0].id };
}
async function mustSend(who: SupabaseClient, client: string, items?: unknown[]) {
  const r = await sendLink(who, client, items);
  if ("error" in r) throw new Error(r.error);
  return r;
}
const ticket = (hash: string, item: string, ipHash = ip()) =>
  call("link_ticket", { p_token_hash: hash, p_item_id: item, p_file: { ext: "pdf", size: 60 }, p_ip_hash: ipHash });
async function upload(hash: string, item: string, fileName = "invoice.pdf") {
  const t = await ok(ticket(hash, item));
  const obj = await uploadObject(t.office_id as string, "pdf", t.document_id as string);
  return ok(call("link_register", { p_token_hash: hash, p_item_id: item, p_file: { storage_path: obj.path, file_name: fileName }, p_ip_hash: ip() }));
}
const itemStatus = async (item: string) => (await admin().from("upload_request_item").select("status").eq("id", item).single()).data!.status;

beforeAll(async () => {
  officeId = await createDocumentOffice("upload-review");
  u.admin = await createStaff(officeId, "urv-admin", "admin");
  u.manager = await createStaff(officeId, "urv-manager", "manager");
  u.staff = await createStaff(officeId, "urv-staff", "staff");
  u.staff2 = await createStaff(officeId, "urv-staff2", "staff");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  await generateAsOf(as.admin, "2026-03-15");
  c.a = await bankOnlyClient(as.staff, officeId, { name: "Upload review A", incharge_id: u.staff.id, email: "urva@example.test", mobile: "9876541101" });
  c.b = await bankOnlyClient(as.staff, officeId, { name: "Upload review B", incharge_id: u.staff.id, email: "urvb@example.test", mobile: "9876541102" });
  await generateAsOf(as.admin, "2026-05-15");
  notice = await typeId(officeId, T.notice);
}, 300_000);

afterAll(async () => { await retireStaff((Object.values(u)).map((x) => x.id)); });

describe("B1: the stored file name keeps the stored object's extension", () => {
  it("a name the browser sends back with another extension is filed with the object's own", async () => {
    const link = await mustSend(as.staff, c.a);
    const reg = await upload(link.hash, link.item, "GST invoice.exe");
    const { data: v } = await admin().from("document_version").select("file_name").eq("document_id", reg.document_id).single();
    expect(v!.file_name).toBe("GST invoice.pdf");
    const reg2 = await upload(link.hash, link.item, "...");
    const { data: v2 } = await admin().from("document_version").select("file_name").eq("document_id", reg2.document_id).single();
    expect(v2!.file_name).toBe("file.pdf");
  });
});

describe("I1: Send again replaces only your own link, unless you are Admin/Manager", () => {
  it("Staff can't revoke a colleague's link by replacing it; a Manager can", async () => {
    const theirs = await mustSend(as.staff2, c.a);
    const r = await sendLink(as.staff, c.a, undefined, theirs.requestId);
    expect("error" in r && r.error).toMatch(/NOT_FOUND/);
    const { data: still } = await admin().from("upload_request").select("revoked_at").eq("id", theirs.requestId).single();
    expect(still!.revoked_at).toBeNull();
    const byManager = await sendLink(as.manager, c.a, undefined, theirs.requestId);
    expect("error" in byManager).toBe(false);
    const own = await mustSend(as.staff, c.a);
    expect("error" in (await sendLink(as.staff, c.a, undefined, own.requestId))).toBe(false);
  });
});

describe("security I1: failed lookups through ticket and register count towards the IP block (AC-9)", () => {
  it("20 bad tokens sent to link_ticket block that IP everywhere, including link_open with a good token", async () => {
    const good = await mustSend(as.staff, c.a);
    const bad = ip(9);
    for (let n = 0; n < 20; n++) {
      const r = await ticket(sha(`wrong-${n}`), good.item, bad);
      expect(r.error).toBeNull();
      expect(r.data).toEqual({ error: "NOT_ACTIVE" });
    }
    expect(await ok(call("link_open", { p_token_hash: good.hash, p_ip_hash: bad }))).toEqual({ active: false });
    const reg = await call("link_register", { p_token_hash: good.hash, p_item_id: good.item, p_file: { storage_path: "x", file_name: "x.pdf" }, p_ip_hash: bad });
    expect(reg.data).toEqual({ error: "NOT_ACTIVE" });
  });
});

describe("I6: tickets are capped for the link's lifetime", () => {
  it("after 2 × max_files tickets the link refuses more, even without registrations", async () => {
    const link = await mustSend(as.staff, c.a);
    await ok(call("test_set_link_caps", { p_request: link.requestId, p_max_files: 2, p_max_bytes: 10_000_000 }));
    for (let n = 0; n < 4; n++) await ok(ticket(link.hash, link.item));
    expect((await ticket(link.hash, link.item)).error?.message).toMatch(/CAP_REACHED/);
  });
});

describe("I3 + I4: the ad-hoc item follows changes made by 03's trigger and by reclassification", () => {
  it("a corrected file (new version) after Needs correction makes the item received again", async () => {
    const link = await mustSend(as.staff, c.a);
    const reg = await upload(link.hash, link.item);
    await mustReview(as.staff, reg.document_id as string, "needs_correction", "blurred scan");
    expect(await itemStatus(link.item)).toBe("open");
    const v2 = await uploadObject(officeId, "pdf", reg.document_id as string);
    const { error } = await as.staff.rpc("add_document_version", { p_document_id: reg.document_id, p_file: { storage_path: v2.path, file_name: "clear.pdf" } });
    if (error) throw new Error(error.message);
    const { data: d } = await admin().from("document").select("status").eq("id", reg.document_id).single();
    expect(d!.status).toBe("received"); // 03's BEFORE trigger reset the review
    expect(await itemStatus(link.item)).toBe("received");
  });

  it("moving the only document to another client reopens the item, and the link page no longer counts it", async () => {
    const link = await mustSend(as.staff, c.a);
    const reg = await upload(link.hash, link.item);
    expect(await itemStatus(link.item)).toBe("received");
    const { error } = await as.staff.rpc("update_document", { p_id: reg.document_id, p: { client_id: c.b } });
    if (error) throw new Error(error.message);
    expect(await itemStatus(link.item)).toBe("open");
    const page = await ok(call("link_open", { p_token_hash: link.hash, p_ip_hash: ip() }));
    expect((page.items as Array<{ files: number }>)[0].files).toBe(0);
  });
});

describe("I5: the upload_link channel is set only by a link and never changes", () => {
  it("staff can't file a document with channel upload_link", async () => {
    const obj = await uploadObject(officeId, "pdf");
    const r = await createDocument(as.staff, { client_id: c.a, doc_type_id: notice, received_as: "soft_copy",
      channel: "upload_link" as "other", file: { storage_path: obj.path, file_name: "x.pdf" } });
    expect(r.error?.message).toMatch(/CHANNEL_LOCKED/);
  });

  it("staff can't change a link upload's channel, nor give another document that channel; other edits still save", async () => {
    const link = await mustSend(as.staff, c.a);
    const reg = await upload(link.hash, link.item);
    const away = await as.staff.rpc("update_document", { p_id: reg.document_id, p: { channel: "email" } });
    expect(away.error?.message).toMatch(/CHANNEL_LOCKED/);
    const remark = await as.staff.rpc("update_document", { p_id: reg.document_id, p: { channel: "upload_link", remark: "checked the stamp" } });
    expect(remark.error).toBeNull();
    const other = await createSoftCopy(as.staff, officeId, { client_id: c.a, doc_type_id: notice, channel: "email" });
    const to = await as.staff.rpc("update_document", { p_id: other.id, p: { channel: "upload_link" } });
    expect(to.error?.message).toMatch(/CHANNEL_LOCKED/);
  });
});

describe("AC-22: ad-hoc activity never changes metric 1", () => {
  it("send, upload, Needs correction, cancel: collection_metric is unchanged", async () => {
    const metric = async () => ok(call("collection_metric", { p_from: "2026-04-01", p_to: "2026-07-15" }, as.admin));
    const before = await metric();
    const link = await mustSend(as.staff, c.b, [{ kind: "ad_hoc", doc_type_id: notice, needed_by: "2026-05-20" }]);
    const reg = await upload(link.hash, link.item);
    await mustReview(as.staff, reg.document_id as string, "needs_correction", "wrong year");
    await ok(call("cancel_request_item", { p_id: link.item, p_reason: "not needed" }, as.staff));
    expect(await metric()).toEqual(before);
  });
});
