import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, periodId, typeId } from "../support/documents";
import { T, bankOnlyClient, expectedItem, generateAsOf } from "../support/expected";

// Feature 10 — staff functions (spec AC-1…AC-5, AC-16, AC-18, AC-21; plan step 2). Written before migration B.
// Fixture: Bank statement only (monthly). Clients enabled at clock 15 Mar 2026, clock then 15 May 2026 →
// Mar and Apr pending. "GST notice / order received" (as needed, period none) is the ad-hoc type.

type Who = "admin" | "manager" | "staff" | "staff2" | "limited";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
const c = {} as Record<"a" | "b" | "c" | "d" | "e" | "noContact" | "limitedOwn" | "other", string>;
let notice: string; // ad-hoc type, period none
let bank: string;   // monthly type
const hash = () => createHash("sha256").update(randomBytes(32)).digest("hex");
const admin = () => adminClient();
const sched = async (client: string, period = "2026-03") => ({ kind: "scheduled", expected_doc_id: (await expectedItem(client, T.bank, period)).id });
const adhoc = (extra: Record<string, unknown> = {}) => ({ kind: "ad_hoc", doc_type_id: notice, ...extra });

type Res = { data: Record<string, unknown> | null; error: { message: string } | null };
const rpc = (who: Who, fn: string, args: Record<string, unknown>) => as[who].rpc(fn, args) as unknown as Promise<Res>;
async function ok(p: Promise<Res>) { const r = await p; if (r.error) throw new Error(r.error.message); return r.data as Record<string, unknown>; }
const email = (who: Who, client: string, items: unknown[], extra: Record<string, unknown> = {}) =>
  rpc(who, "begin_link_email", { p: { client_id: client, items, token_hash: hash(), ...extra } });
const whatsapp = (who: Who, client: string, items: unknown[], extra: Record<string, unknown> = {}) =>
  rpc(who, "record_link_whatsapp", { p: { client_id: client, items, token_hash: hash(), ...extra } });

async function requestRow(id: string) {
  const { data, error } = await admin().from("upload_request").select("*").eq("id", id).single();
  if (error) throw error;
  return data;
}
async function itemsOf(id: string) {
  const { data, error } = await admin().from("upload_request_item").select("*").eq("request_id", id).order("kind");
  if (error) throw error;
  return data;
}

beforeAll(async () => {
  officeId = await createDocumentOffice("upload-staff");
  u.admin = await createStaff(officeId, "us-admin", "admin");
  u.manager = await createStaff(officeId, "us-manager", "manager");
  u.staff = await createStaff(officeId, "us-staff", "staff");
  u.staff2 = await createStaff(officeId, "us-staff2", "staff");
  u.limited = await createStaff(officeId, "us-limited", "limited");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  await generateAsOf(as.admin, "2026-03-15");
  let n = 0;
  const mk = (name: string, extra: { email?: string | null; mobile?: string | null; incharge_id?: string } = {}) =>
    bankOnlyClient(as.staff, officeId, {
      name, incharge_id: extra.incharge_id ?? u.staff.id,
      email: extra.email === undefined ? `uclient${++n}@example.test` : extra.email,
      mobile: extra.mobile === undefined ? `98765100${String(++n).padStart(2, "0")}` : extra.mobile,
    });
  for (const k of ["a", "b", "c", "d", "e", "other"] as const) c[k] = await mk(`Upload staff ${k.toUpperCase()}`);
  c.noContact = await mk("Upload staff none", { email: null, mobile: null });
  c.limitedOwn = await mk("Upload staff limited", { incharge_id: u.limited.id });
  await generateAsOf(as.admin, "2026-05-15");
  notice = await typeId(officeId, T.notice);
  bank = await typeId(officeId, T.bank);
}, 240_000);

afterAll(async () => {
  await retireStaff([u.manager, u.staff, u.staff2, u.limited].filter(Boolean).map((x) => x.id));
  if (u.admin) await retireStaff([u.admin.id]);
});

describe("sending a link by email (AC-1, AC-2)", () => {
  let res: Record<string, unknown>;
  it("creates a pending follow-up for the scheduled items and the request with all items, in one call", async () => {
    res = await ok(email("staff", c.a, [await sched(c.a), adhoc({ needed_by: "2026-05-30", note: "for the new office lease" })]));
    const { data: fu } = await admin().from("follow_up").select("status, channel, recipient, sent_by").eq("id", res.follow_up_id).single();
    expect(fu).toMatchObject({ status: "pending", channel: "email", sent_by: u.staff.id });
    const { data: fi } = await admin().from("follow_up_item").select("expected_doc_id").eq("follow_up_id", res.follow_up_id);
    expect(fi).toHaveLength(1);
    const r = await requestRow(res.request_id as string);
    expect(r).toMatchObject({ client_id: c.a, created_by: u.staff.id, follow_up_id: res.follow_up_id, revoked_at: null });
    const items = await itemsOf(r.id);
    expect(items.map((i) => i.kind).sort()).toEqual(["ad_hoc", "scheduled"]);
    expect(items.find((i) => i.kind === "ad_hoc")).toMatchObject({ doc_type_id: notice, needed_by: "2026-05-30", note: "for the new office lease", status: "open" });
  });

  it("the link stays open through the 14th office day (expires at the start of day 15, IST)", async () => {
    const r = await requestRow(res.request_id as string);
    expect(new Date(r.expires_at).toISOString()).toBe(new Date("2026-05-29T18:30:00Z").toISOString()); // 30 May 00:00 IST
  });

  it("writes one activity row with IDs and counts only", async () => {
    const { data } = await admin().from("activity").select("actor_id, data").eq("entity_id", res.request_id).eq("action", "upload_request.created");
    expect(data).toHaveLength(1);
    expect(data![0].actor_id).toBe(u.staff.id);
    expect(data![0].data).toEqual({ client_id: c.a, follow_up_id: res.follow_up_id, scheduled: 1, ad_hoc: 1 });
  });

  it("shares 06's one-email-per-client-per-day cap, both ways", async () => {
    const again = await email("staff", c.a, [adhoc()]);
    expect(again.error?.message).toMatch(/ALREADY_EMAILED_TODAY/);
    const plain = await as.staff.rpc("begin_email_reminder", { p_client: c.a, p_items: [(await expectedItem(c.a, T.bank, "2026-04")).id] });
    expect(plain.error?.message).toMatch(/ALREADY_EMAILED_TODAY/);
  });

  it("respects the office ceiling and needs an email address", async () => {
    expect((await email("staff", c.b, [adhoc()], { daily_max: 0 })).error?.message).toMatch(/DAILY_LIMIT/);
    expect((await email("staff", c.noContact, [adhoc()])).error?.message).toMatch(/NO_EMAIL/);
  });
});

describe("retry after a failed email (AC-2)", () => {
  it("only the requester can retry, only after a failure; the token is replaced and a new follow-up attached", async () => {
    const res = await ok(email("staff", c.c, [await sched(c.c)]));
    const before = await requestRow(res.request_id as string);
    expect((await rpc("staff", "retry_link_email", { p_request: res.request_id, p_token_hash: hash() })).error?.message).toMatch(/NOT_FAILED/);
    await ok(rpc("staff", "finish_email_reminder", { p_id: res.follow_up_id, p_status: "failed", p_error_code: "TIMEOUT" }));
    expect((await rpc("staff2", "retry_link_email", { p_request: res.request_id, p_token_hash: hash() })).error?.message).toMatch(/NOT_SENDER/);
    const retried = await ok(rpc("staff", "retry_link_email", { p_request: res.request_id, p_token_hash: hash() }));
    const after = await requestRow(res.request_id as string);
    expect(after.token_hash).not.toBe(before.token_hash);
    expect(after.follow_up_id).toBe(retried.follow_up_id);
    expect(retried.follow_up_id).not.toBe(res.follow_up_id);
    const { data: act } = await admin().from("activity").select("id").eq("entity_id", res.request_id).eq("action", "upload_request.retried");
    expect(act).toHaveLength(1);
  });
});

describe("sending a link by WhatsApp (AC-1, AC-2)", () => {
  it("an ad-hoc-only request records an opened WhatsApp follow-up with no expected items", async () => {
    const res = await ok(whatsapp("staff", c.d, [adhoc({ note: "rent agreement" })]));
    const { data: fu } = await admin().from("follow_up").select("status, channel").eq("id", res.follow_up_id).single();
    expect(fu).toMatchObject({ status: "opened", channel: "whatsapp" });
    const { data: fi } = await admin().from("follow_up_item").select("id").eq("follow_up_id", res.follow_up_id);
    expect(fi).toEqual([]);
    expect(await itemsOf(res.request_id as string)).toHaveLength(1);
  });

  it("needs a mobile number", async () => {
    expect((await whatsapp("staff", c.noContact, [adhoc()])).error?.message).toMatch(/NO_MOBILE/);
  });
});

describe("item checks (AC-3)", () => {
  it("refuses an empty request, another client's item, and an unknown kind", async () => {
    expect((await whatsapp("staff", c.e, [])).error?.message).toMatch(/NO_ITEMS/);
    expect((await whatsapp("staff", c.e, [await sched(c.other)])).error?.message).toMatch(/ITEMS_INVALID/);
    expect((await whatsapp("staff", c.e, [{ kind: "other" }])).error?.message).toMatch(/ITEM_KIND/);
  });

  it("refuses a type the client can't use, a period of the wrong kind, and a past needed-by date", async () => {
    const proposed = await as.staff.rpc("create_proposed_type", {
      p_client_id: c.other, p_doc_group_id: (await admin().from("doc_type").select("doc_group_id").eq("id", notice).single()).data!.doc_group_id,
      p_name: "Other client's special letter",
    });
    if (proposed.error) throw new Error(proposed.error.message);
    const otherType = (proposed.data as { id?: string } | string);
    const otherId = typeof otherType === "string" ? otherType : otherType.id;
    expect((await whatsapp("staff", c.e, [adhoc({ doc_type_id: otherId })])).error?.message).toMatch(/TYPE_INVALID/);
    expect((await whatsapp("staff", c.e, [adhoc({ period_id: await periodId(officeId, "2026-04") })])).error?.message).toMatch(/PERIOD_INVALID/);
    const okPeriod = await whatsapp("staff", c.e, [adhoc({ doc_type_id: bank, period_id: await periodId(officeId, "2026-04") })]);
    expect(okPeriod.error).toBeNull();
    expect((await whatsapp("staff", c.e, [adhoc({ needed_by: "2026-05-14" })])).error?.message).toMatch(/NEEDED_BY_PAST/);
  });
});

describe("notes are shown publicly, so personal data is refused (AC-4)", () => {
  const cases: Array<[string, string]> = [
    ["PAN", "pan abcde1234f please"],
    ["GSTIN", "for 33ABCDE1234F1Z5"],
    ["TAN", "TAN CHEA12345B"],
    ["EMAIL", "send to ravi@example.com"],
    ["MOBILE", "call +91 98765 43210"],
    ["NUMBER", "account 1234 5678 9012"],
  ];
  for (const [kind, note] of cases) {
    it(`refuses a note with a ${kind}`, async () => {
      const r = await whatsapp("staff", c.e, [adhoc({ note })]);
      expect(r.error?.message).toMatch(new RegExp(`NOTE_PII: ${kind}`));
    });
  }
  it("accepts an ordinary note, and refuses one over 200 characters", async () => {
    expect((await whatsapp("staff", c.e, [adhoc({ note: "Rent agreement for the new office, FY 2026-27 (2 pages)" })])).error).toBeNull();
    expect((await whatsapp("staff", c.e, [adhoc({ note: "x".repeat(201) })])).error?.message).toMatch(/NOTE_TOO_LONG/);
  });
});

describe("roles (AC-5)", () => {
  it("Limited users send links for their own clients only", async () => {
    expect((await whatsapp("limited", c.limitedOwn, [adhoc()])).error).toBeNull();
    expect((await whatsapp("limited", c.e, [adhoc()])).error?.message).toMatch(/NOT_FOUND/);
  });
});

describe("revoke and send again (AC-18)", () => {
  it("only the requester or Admin/Manager revokes; once", async () => {
    const res = await ok(whatsapp("staff", c.b, [adhoc()]));
    expect((await rpc("staff2", "revoke_upload_request", { p_id: res.request_id })).error?.message).toMatch(/ROLE_REQUIRED/);
    await ok(rpc("manager", "revoke_upload_request", { p_id: res.request_id }));
    expect((await requestRow(res.request_id as string)).revoked_by).toBe(u.manager.id);
    expect((await rpc("staff", "revoke_upload_request", { p_id: res.request_id })).error?.message).toMatch(/ALREADY_REVOKED/);
  });

  it("send again revokes the old link and points it at the new request", async () => {
    const first = await ok(whatsapp("staff", c.b, [adhoc()]));
    const second = await ok(whatsapp("staff", c.b, [adhoc()], { replaces: first.request_id }));
    const old = await requestRow(first.request_id as string);
    expect(old.replaced_by).toBe(second.request_id);
    expect(old.revoked_at).not.toBeNull();
    expect((await whatsapp("staff", c.b, [adhoc()], { replaces: first.request_id })).error?.message).toMatch(/NOT_FOUND/);
  });
});

describe("cancel and reopen ad-hoc items (AC-16)", () => {
  it("cancels an open ad-hoc item with a reason; scheduled items and other states are refused", async () => {
    const res = await ok(whatsapp("staff", c.e, [await sched(c.e, "2026-04"), adhoc()]));
    const items = await itemsOf(res.request_id as string);
    const ad = items.find((i) => i.kind === "ad_hoc")!;
    const sc = items.find((i) => i.kind === "scheduled")!;
    expect((await rpc("staff", "cancel_request_item", { p_id: ad.id, p_reason: " " })).error?.message).toMatch(/REASON_REQUIRED/);
    expect((await rpc("staff", "cancel_request_item", { p_id: sc.id, p_reason: "not needed" })).error?.message).toMatch(/ITEM_STATE/);
    await ok(rpc("staff2", "cancel_request_item", { p_id: ad.id, p_reason: "client sent it by courier" }));
    const { data } = await admin().from("upload_request_item").select("status, cancelled_by, cancel_reason").eq("id", ad.id).single();
    expect(data).toMatchObject({ status: "cancelled", cancelled_by: u.staff2.id, cancel_reason: "client sent it by courier" });
    expect((await rpc("staff", "reopen_request_item", { p_id: ad.id })).error?.message).toMatch(/ITEM_STATE/);
    expect((await rpc("limited", "cancel_request_item", { p_id: ad.id, p_reason: "x" })).error?.message).toMatch(/NOT_FOUND/);
  });
});
