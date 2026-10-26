import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, mustReview, typeId, uploadObject } from "../support/documents";
import { T, bankOnlyClient, expectedItem, generateAsOf } from "../support/expected";

// Feature 10 — the public path (spec AC-6…AC-15, AC-20, AC-21; plan step 4). Written before migration C.
// The server calls link_open / link_ticket / link_register as the service role with the token's hash and a
// salted IP hash. Fixture as in upload-links-staff: Bank statement only; clock 15 May 2026 → Mar, Apr pending.

type Who = "admin" | "staff" | "requester2" | "limited";
let officeId: string;
let otherOfficeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
const c = {} as Record<"a" | "b" | "inactive", string>;
let otherClient: string;
let otherAs: SupabaseClient;
let otherStaff: { id: string; email: string };
let notice: string;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const ip = (n = 1) => sha(`ip-${n}-${Date.now()}`);
const admin = () => adminClient();

type Res = { data: Record<string, unknown> | null; error: { message: string } | null };
const call = (fn: string, args: Record<string, unknown>, client: SupabaseClient = admin()) =>
  client.rpc(fn, args) as unknown as Promise<Res>;
async function ok(p: Promise<Res>) { const r = await p; if (r.error) throw new Error(r.error.message); return r.data as Record<string, unknown>; }

/** Sends a WhatsApp link as `who` and returns the raw token, its hash and the request/items. */
async function sendLink(who: SupabaseClient, client: string, items: unknown[]) {
  const token = newToken();
  const res = await ok(call("record_link_whatsapp", { p: { client_id: client, items, token_hash: sha(token) } }, who));
  const { data: rows } = await admin().from("upload_request_item").select("id, kind").eq("request_id", res.request_id);
  return { token, hash: sha(token), requestId: res.request_id as string, items: rows as Array<{ id: string; kind: string }> };
}
const sched = async (client: string, period = "2026-03") => ({ kind: "scheduled", expected_doc_id: (await expectedItem(client, T.bank, period)).id });
const adhoc = (extra: Record<string, unknown> = {}) => ({ kind: "ad_hoc", doc_type_id: notice, ...extra });
const open = (hash: string, ipHash: string) => ok(call("link_open", { p_token_hash: hash, p_ip_hash: ipHash }));
const ticket = (hash: string, item: string, file: { ext: string; size: number }, ipHash: string) =>
  call("link_ticket", { p_token_hash: hash, p_item_id: item, p_file: file, p_ip_hash: ipHash });

/** The whole browser flow: ticket → PUT (here: service-role upload of a tiny PDF) → register. */
async function upload(hash: string, item: string, ipHash = ip()) {
  const t = await ok(ticket(hash, item, { ext: "pdf", size: 60 }, ipHash));
  const obj = await uploadObject(t.office_id as string, "pdf", t.document_id as string);
  const reg = await ok(call("link_register", { p_token_hash: hash, p_item_id: item, p_file: { storage_path: obj.path, file_name: "invoice.pdf" }, p_ip_hash: ipHash }));
  return { ...reg, path: obj.path } as Record<string, unknown> & { path: string };
}

beforeAll(async () => {
  officeId = await createDocumentOffice("upload-public");
  otherOfficeId = await createDocumentOffice("upload-public-other");
  u.admin = await createStaff(officeId, "up-admin", "admin");
  u.staff = await createStaff(officeId, "up-staff", "staff");
  u.requester2 = await createStaff(officeId, "up-req2", "staff");
  u.limited = await createStaff(officeId, "up-limited", "limited");
  otherStaff = await createStaff(otherOfficeId, "up-other", "staff");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  otherAs = await signedInClient(otherStaff.email);
  await generateAsOf(as.admin, "2026-03-15");
  await generateAsOf(otherAs, "2026-03-15").catch(() => undefined);
  let n = 0;
  const mk = (who: SupabaseClient, office: string, name: string, incharge: string) =>
    bankOnlyClient(who, office, { name, incharge_id: incharge, email: `up${++n}@example.test`, mobile: `98765200${String(++n).padStart(2, "0")}` });
  c.a = await mk(as.staff, officeId, "Upload public A", u.staff.id);
  c.b = await mk(as.staff, officeId, "Upload public B", u.staff.id);
  c.inactive = await mk(as.staff, officeId, "Upload public inactive", u.staff.id);
  otherClient = await mk(otherAs, otherOfficeId, "Upload public other office", otherStaff.id);
  await generateAsOf(as.admin, "2026-05-15");
  notice = await typeId(officeId, T.notice);
}, 300_000);

afterAll(async () => {
  await retireStaff([u.staff, u.requester2, u.limited, otherStaff].filter(Boolean).map((x) => x.id));
  if (u.admin) await retireStaff([u.admin.id]);
});

describe("only the service role can call the public functions (AC-10, AC-20)", () => {
  it("anon and signed-in staff are refused", async () => {
    const anon = (await import("@supabase/supabase-js")).createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
    for (const client of [anon, as.admin]) {
      const r = await call("link_open", { p_token_hash: sha("x"), p_ip_hash: ip() }, client);
      expect(r.error?.message ?? "").toMatch(/permission denied|not find|does not exist/i);
    }
  });
});

describe("opening a link (AC-6, AC-8)", () => {
  let link: Awaited<ReturnType<typeof sendLink>>;
  beforeAll(async () => { link = await sendLink(as.staff, c.a, [await sched(c.a), adhoc({ needed_by: "2026-05-30", note: "for the new office lease" })]); });

  it("returns only the allowed fields: firm, requester's first name, dates, caps and item labels", async () => {
    const page = await open(link.hash, ip());
    expect(page).toMatchObject({ active: true, requester: expect.any(String), open_until: "2026-05-29", files_count: 0, max_files: 30 });
    const items = page.items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.kind)).toEqual(["scheduled", "ad_hoc"]);
    expect(items[0]).toMatchObject({ group: "Banking", type: T.bank, received: false, files: 0 });
    expect(items[1]).toMatchObject({ note: "for the new office lease", needed_by: "2026-05-30" });
    const { data: client } = await admin().from("client").select("name, code, email, mobile, pan").eq("id", c.a).single();
    const text = JSON.stringify(page);
    for (const secret of [client!.name, client!.code, client!.email, client!.mobile, c.a, u.staff.email].filter(Boolean)) {
      expect(text).not.toContain(String(secret));
    }
  });

  it("gives the same answer for an unknown, revoked or expired link, and for a requester who has left", async () => {
    expect(await open(sha("unknown"), ip())).toEqual({ active: false });
    const revoked = await sendLink(as.staff, c.b, [adhoc()]);
    await ok(call("revoke_upload_request", { p_id: revoked.requestId }, as.staff));
    expect(await open(revoked.hash, ip())).toEqual({ active: false });
    const leaver = await sendLink(as.requester2, c.inactive, [adhoc()]);
    expect((await open(leaver.hash, ip())).active).toBe(true);
    await retireStaff([u.requester2.id]);
    expect(await open(leaver.hash, ip())).toEqual({ active: false });
  });
});

describe("rate limits (AC-9)", () => {
  it("after 20 failed lookups from one IP in 10 minutes, even a good link answers 'not active' for that IP", async () => {
    const good = await sendLink(as.staff, c.b, [adhoc()]);
    const bad = ip(99);
    for (let i = 0; i < 20; i++) await open(sha(`guess-${i}`), bad);
    expect(await open(good.hash, bad)).toEqual({ active: false });
    expect((await open(good.hash, ip(100))).active).toBe(true);
  });

  it("refuses more than 60 upload tickets per link per hour", async () => {
    const link = await sendLink(as.staff, c.b, [adhoc()]);
    const rows = Array.from({ length: 60 }, () => ({ office_id: officeId, request_id: link.requestId, ip_hash: ip(7), kind: "ticket" }));
    const { error } = await admin().from("link_attempt").insert(rows);
    if (error) throw error;
    expect((await ticket(link.hash, link.items[0].id, { ext: "pdf", size: 10 }, ip())).error?.message).toMatch(/RATE_LIMITED/);
  });
});

describe("tickets: item, file rules and caps (AC-7, AC-20)", () => {
  let link: Awaited<ReturnType<typeof sendLink>>;
  beforeAll(async () => { link = await sendLink(as.staff, c.b, [adhoc()]); });

  it("refuses ZIP, empty and over-25 MB files", async () => {
    const item = link.items[0].id;
    expect((await ticket(link.hash, item, { ext: "zip", size: 10 }, ip())).error?.message).toMatch(/FILE_TYPE_NOT_ALLOWED/);
    expect((await ticket(link.hash, item, { ext: "pdf", size: 0 }, ip())).error?.message).toMatch(/FILE_EMPTY/);
    expect((await ticket(link.hash, item, { ext: "pdf", size: 26214401 }, ip())).error?.message).toMatch(/FILE_TOO_LARGE/);
  });

  it("refuses an item that isn't on this link: another link's, another client's, another office's, a made-up one", async () => {
    const otherLink = await sendLink(as.staff, c.a, [adhoc()]);
    const foreign = await sendLink(otherAs, otherClient, [{ kind: "ad_hoc", doc_type_id: await typeId(otherOfficeId, T.notice) }]);
    for (const item of [otherLink.items[0].id, foreign.items[0].id, crypto.randomUUID()]) {
      expect((await ticket(link.hash, item, { ext: "pdf", size: 10 }, ip())).error?.message).toMatch(/ITEM_NOT_ON_LINK/);
    }
  });

  it("refuses once the link's file or size cap is reached", async () => {
    const capped = await sendLink(as.staff, c.b, [adhoc()]);
    await ok(call("test_set_link_caps", { p_request: capped.requestId, p_max_files: 1, p_max_bytes: 1000 }));
    expect((await ticket(capped.hash, capped.items[0].id, { ext: "pdf", size: 1001 }, ip())).error?.message).toMatch(/CAP_REACHED/);
    await upload(capped.hash, capped.items[0].id);
    expect((await ticket(capped.hash, capped.items[0].id, { ext: "pdf", size: 10 }, ip())).error?.message).toMatch(/CAP_REACHED/);
  });
});

describe("registering an upload (AC-7, AC-11, AC-13, AC-15, AC-21)", () => {
  let link: Awaited<ReturnType<typeof sendLink>>;
  let first: Record<string, unknown> & { path: string };
  beforeAll(async () => {
    link = await sendLink(as.staff, c.a, [await sched(c.a, "2026-04"), adhoc()]);
    first = await upload(link.hash, link.items.find((i) => i.kind === "scheduled")!.id);
  });

  it("files one document classified by the item, owned by the requester, To review, channel upload_link", async () => {
    const { data: d } = await admin().from("document")
      .select("client_id, doc_type_id, period_id, channel, received_as, received_by, created_by, status, upload_request_item_id, classified_at")
      .eq("id", first.document_id).single();
    const e = await expectedItem(c.a, T.bank, "2026-04");
    expect(d).toMatchObject({ client_id: c.a, doc_type_id: e.doc_type_id, period_id: e.period_id, channel: "upload_link",
      received_as: "soft_copy", received_by: u.staff.id, created_by: u.staff.id, status: "received" });
    expect(d!.classified_at).not.toBeNull();
    expect(first.doc_code).toMatch(/^DOC-FY\d{2}-\d{2}-\d{5}$/);
  });

  it("marks the scheduled item's expected document received through 04's linking (AC-11)", async () => {
    expect((await expectedItem(c.a, T.bank, "2026-04")).status).toBe("received");
  });

  it("counts the file on the link, logs document.link_upload with no actor, and notifies the requester once a day", async () => {
    const { data: r } = await admin().from("upload_request").select("files_count, bytes_total").eq("id", link.requestId).single();
    expect(r!.files_count).toBe(1);
    expect(Number(r!.bytes_total)).toBeGreaterThan(0);
    const { data: act } = await admin().from("activity").select("actor_id, data").eq("entity_id", first.document_id).eq("action", "document.link_upload");
    expect(act).toEqual([{ actor_id: null, data: { client_id: c.a, request_id: link.requestId, item_id: link.items.find((i) => i.kind === "scheduled")!.id } }]);
    await upload(link.hash, link.items.find((i) => i.kind === "ad_hoc")!.id);
    const { data: n } = await admin().from("notification").select("recipient_id, data").eq("kind", "link_upload").eq("entity_id", link.requestId);
    expect(n).toEqual([{ recipient_id: u.staff.id, data: { request_id: link.requestId } }]);
  });

  it("is idempotent for the same stored file, and refuses a path outside the link's office", async () => {
    const item = link.items.find((i) => i.kind === "scheduled")!.id;
    const again = await ok(call("link_register", { p_token_hash: link.hash, p_item_id: item, p_file: { storage_path: first.path, file_name: "invoice.pdf" }, p_ip_hash: ip() }));
    expect(again).toMatchObject({ document_id: first.document_id, duplicate: true });
    const foreign = await uploadObject(otherOfficeId, "pdf");
    const r = await call("link_register", { p_token_hash: link.hash, p_item_id: item, p_file: { storage_path: foreign.path, file_name: "x.pdf" }, p_ip_hash: ip() });
    expect(r.error?.message).toMatch(/PATH/);
  });

  it("the Limited user can't see a document for a client they don't have, even though it came by link", async () => {
    const { data } = await as.limited.from("document").select("id").eq("id", first.document_id);
    expect(data).toEqual([]);
  });
});

describe("ad-hoc item status follows its documents (AC-12)", () => {
  it("received on upload; back to open on Needs correction; received again on the next upload; reopen waits for a new one", async () => {
    const link = await sendLink(as.staff, c.b, [adhoc()]);
    const item = link.items[0].id;
    const status = async () => (await admin().from("upload_request_item").select("status, received_on").eq("id", item).single()).data!;
    const d1 = await upload(link.hash, item);
    const { data: doc1 } = await admin().from("document").select("received_on").eq("id", d1.document_id).single();
    expect(await status()).toEqual({ status: "received", received_on: doc1!.received_on }); // 03: received on = filing day (IST)
    await mustReview(as.staff, d1.document_id as string, "needs_correction", "blurred scan");
    expect((await status()).status).toBe("open");
    await upload(link.hash, item);
    expect((await status()).status).toBe("received");
    await ok(call("reopen_request_item", { p_id: item }, as.staff));
    expect((await status()).status).toBe("open");
    await upload(link.hash, item);
    expect((await status()).status).toBe("received");
  });

  it("a cancelled item disappears from the page and refuses uploads (D4)", async () => {
    const link = await sendLink(as.staff, c.b, [adhoc(), adhoc({ note: "second" })]);
    await ok(call("cancel_request_item", { p_id: link.items[0].id, p_reason: "not needed" }, as.staff));
    const page = await open(link.hash, ip());
    expect((page.items as unknown[]).length).toBe(1);
    expect((await ticket(link.hash, link.items[0].id, { ext: "pdf", size: 10 }, ip())).error?.message).toMatch(/ITEM_NOT_ON_LINK/);
  });
});

describe("expiry (AC-19)", () => {
  it("a link is open through its 14th office day and not on the 15th", async () => {
    const link = await sendLink(as.staff, c.b, [adhoc()]);
    await generateAsOf(as.admin, "2026-05-29");
    expect((await open(link.hash, ip())).active).toBe(true);
    await generateAsOf(as.admin, "2026-05-30");
    expect(await open(link.hash, ip())).toEqual({ active: false });
    await generateAsOf(as.admin, "2026-05-15");
  });
});

describe("test helper is confined to test offices", () => {
  it("test_set_link_caps refuses a request id that isn't in an is_test office", async () => {
    const r = await call("test_set_link_caps", { p_request: crypto.randomUUID(), p_max_files: 1, p_max_bytes: 1 });
    expect(r.error?.message).toMatch(/NOT_TEST_OFFICE/);
  });
});
