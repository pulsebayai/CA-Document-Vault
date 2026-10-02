import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { DENIED } from "../support/catalogue";
import { createDocumentOffice, mustCreateDocument, periodId, typeId } from "../support/documents";
import {
  T, bankOnlyClient, emailReminder, expectedItem, followUpsOf, generateAsOf, mustRpc, planRow, reminderActivity, rpc,
} from "../support/expected";

// Feature 06 — follow-ups: the email cap, the office ceiling, item checks, WhatsApp / call records, visibility,
// no app write path, activity without PII, and the test-office purge (spec AC-7…AC-14, AC-16, AC-17).
// Written before the migration (plan step 1). Contract: tests/support/expected.ts ("Feature 06").
//
// Fixture: Bank statement only (monthly, asked +1/1, overdue +1/7). Clients enabled at clock 15 Mar 2026
// (start period Mar), clock then 15 Jul 2026 → Mar, Apr, May, Jun pending and overdue.

type Who = "admin" | "manager" | "staff" | "staff2" | "limited";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
const c = {} as Record<"a" | "b" | "noContact" | "limitedOwn" | "e" | "f" | "stale" | "items" | "call" | "other", string>;
const items = async (client: string) => (await Promise.all(["2026-03", "2026-04", "2026-05", "2026-06"]
  .map((p) => expectedItem(client, T.bank, p)))).map((e) => e.id);

beforeAll(async () => {
  officeId = await createDocumentOffice("followup");
  u.admin = await createStaff(officeId, "fu-admin", "admin");
  u.manager = await createStaff(officeId, "fu-manager", "manager");
  u.staff = await createStaff(officeId, "fu-staff", "staff");
  u.staff2 = await createStaff(officeId, "fu-staff2", "staff");
  u.limited = await createStaff(officeId, "fu-limited", "limited");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  await generateAsOf(as.admin, "2026-03-15");
  let n = 0;
  const mk = (name: string, extra: { email?: string | null; mobile?: string | null; incharge_id?: string } = {}) =>
    bankOnlyClient(as.staff, officeId, {
      name, incharge_id: extra.incharge_id ?? u.staff.id,
      email: extra.email === undefined ? `client${++n}@example.test` : extra.email,
      mobile: extra.mobile === undefined ? `98765000${String(++n).padStart(2, "0")}` : extra.mobile,
    });
  c.a = await mk("Follow A");
  c.b = await mk("Follow B");
  c.noContact = await mk("Follow No contact", { email: null, mobile: null });
  c.limitedOwn = await mk("Follow Limited own", { incharge_id: u.limited.id });
  c.e = await mk("Follow E");
  c.f = await mk("Follow F");
  c.stale = await mk("Follow Stale");
  c.items = await mk("Follow Items");
  c.call = await mk("Follow Call");
  c.other = await mk("Follow Other");
  await generateAsOf(as.admin, "2026-07-15");
}, 180_000);

afterAll(async () => {
  await retireStaff([u.manager, u.staff, u.staff2, u.limited].filter(Boolean).map((x) => x.id));
  if (u.admin) await retireStaff([u.admin.id]);
});

describe("email: two-phase send and the one-per-client-per-day cap (AC-8, AC-14)", () => {
  it("begin records a pending follow-up with the client's email snapshot and the office date, before any send", async () => {
    const ids = await items(c.a);
    const begun = await mustRpc<{ id: string; recipient: string }>(as.staff, "begin_email_reminder", { p_client: c.a, p_items: ids });
    expect(begun.recipient).toMatch(/@example\.test$/);
    const [f] = await followUpsOf(officeId, c.a);
    expect(f).toMatchObject({ id: begun.id, channel: "email", status: "pending", sent_by: u.staff.id, sent_on: "2026-07-15",
      recipient: begun.recipient, finished_at: null });
    const { data: its } = await adminClient().from("follow_up_item").select("expected_doc_id").eq("follow_up_id", begun.id);
    expect(its!.map((r) => r.expected_doc_id).sort()).toEqual([...ids].sort());
  });

  it("a second begin the same day is refused while the first is pending (double click, second tab)", async () => {
    const r = await rpc(as.staff2, "begin_email_reminder", { p_client: c.a, p_items: await items(c.a) });
    expect(r.error).toMatch(/ALREADY_EMAILED_TODAY/);
  });

  it("finish records the result once, only by the sender, and the cap still holds after a send", async () => {
    const [f] = await followUpsOf(officeId, c.a);
    const byOther = await rpc(as.staff2, "finish_email_reminder", { p_id: f.id, p_status: "sent", p_provider_id: "x", p_error_code: null });
    expect(byOther.error).toMatch(/NOT_FOUND|permission|NOT_SENDER/);
    await mustRpc(as.staff, "finish_email_reminder", { p_id: f.id, p_status: "sent", p_provider_id: "brevo-123", p_error_code: null });
    const again = await rpc(as.staff, "finish_email_reminder", { p_id: f.id, p_status: "failed", p_provider_id: null, p_error_code: "X" });
    expect(again.error).toMatch(/NOT_PENDING/);
    expect((await followUpsOf(officeId, c.a))[0]).toMatchObject({ status: "sent", provider_message_id: "brevo-123" });
    expect((await followUpsOf(officeId, c.a))[0].finished_at).not.toBeNull();
    const r = await rpc(as.manager, "begin_email_reminder", { p_client: c.a, p_items: await items(c.a) });
    expect(r.error).toMatch(/ALREADY_EMAILED_TODAY/);
  });

  it("finish accepts only sent / failed / suppressed", async () => {
    const begun = await mustRpc<{ id: string }>(as.staff, "begin_email_reminder", { p_client: c.other, p_items: await items(c.other) });
    for (const s of ["pending", "opened", "logged"]) {
      expect((await rpc(as.staff, "finish_email_reminder", { p_id: begun.id, p_status: s, p_provider_id: null, p_error_code: null })).error)
        .toMatch(/BAD_STATUS|invalid input/);
    }
    await mustRpc(as.staff, "finish_email_reminder", { p_id: begun.id, p_status: "suppressed", p_provider_id: null, p_error_code: null });
  });

  it("the cap is in the database: a direct insert of a second email row for the day is refused", async () => {
    const [f] = await followUpsOf(officeId, c.a);
    const { error } = await adminClient().from("follow_up").insert({
      office_id: officeId, client_id: c.a, channel: "email", status: "sent", sent_by: u.staff.id, sent_on: f.sent_on, recipient: f.recipient,
    });
    expect(error?.message).toMatch(/duplicate key|follow_up_email_cap/);
  });

  it("a failed email does not use the day's email: Retry succeeds", async () => {
    await emailReminder(as.staff, c.b, await items(c.b), "failed");
    const retry = await emailReminder(as.staff, c.b, await items(c.b), "sent");
    const rows = await followUpsOf(officeId, c.b);
    expect(rows.map((r) => r.status)).toEqual(["failed", "sent"]);
    expect(rows[0].error_code).toBe("PROVIDER_ERROR");
    expect(rows[1].id).toBe(retry.id);
  });

  it("suppressed counts as the day's email (AC-13 environments still exercise the cap)", async () => {
    // c.other was finished as suppressed above.
    expect((await rpc(as.staff, "begin_email_reminder", { p_client: c.other, p_items: await items(c.other) })).error)
      .toMatch(/ALREADY_EMAILED_TODAY/);
  });

  it("a pending row older than 10 minutes is ignored by the cap and closed as failed (TIMEOUT)", async () => {
    const ids = await items(c.stale);
    const { data: old, error } = await adminClient().from("follow_up").insert({
      office_id: officeId, client_id: c.stale, channel: "email", status: "pending", sent_by: u.staff.id,
      sent_on: "2026-07-15", recipient: "old@example.test", sent_at: new Date(Date.now() - 11 * 60_000).toISOString(),
    }).select("id").single();
    expect(error).toBeNull();
    const begun = await mustRpc<{ id: string }>(as.staff, "begin_email_reminder", { p_client: c.stale, p_items: ids });
    const rows = await followUpsOf(officeId, c.stale);
    expect(rows.find((r) => r.id === old!.id)).toMatchObject({ status: "failed", error_code: "TIMEOUT" });
    expect(rows.find((r) => r.id === begun.id)).toMatchObject({ status: "pending" });
  });

  it("the cap is per office day: the next day the client can be emailed again", async () => {
    await generateAsOf(as.admin, "2026-07-16");
    const next = await emailReminder(as.staff, c.a, await items(c.a), "sent");
    expect((await followUpsOf(officeId, c.a)).find((r) => r.id === next.id)!.sent_on).toBe("2026-07-16");
  });
});

describe("office daily ceiling EMAIL_DAILY_MAX (AC-14)", () => {
  it("counts sent and fresh pending emails of the office today; at the ceiling begin is refused", async () => {
    // Clock 16 Jul: so far today one email was sent (c.a). Ceiling 2 → one more may start.
    const e = await mustRpc<{ id: string }>(as.staff, "begin_email_reminder", { p_client: c.e, p_items: await items(c.e), p_daily_max: 2 });
    const r = await rpc(as.staff, "begin_email_reminder", { p_client: c.f, p_items: await items(c.f), p_daily_max: 2 });
    expect(r.error).toMatch(/DAILY_LIMIT/);
    // A suppressed email used no provider quota: once e is finished as suppressed, f may go.
    await mustRpc(as.staff, "finish_email_reminder", { p_id: e.id, p_status: "suppressed", p_provider_id: null, p_error_code: null });
    await emailReminder(as.staff, c.f, await items(c.f), "suppressed", 2);
  });
});

describe("items and contact checks (AC-7, AC-8, AC-9)", () => {
  it("refuses an empty list, another client's item, a received item and an on-hold item", async () => {
    const own = await items(c.items);
    expect((await rpc(as.staff, "record_follow_up", { p_client: c.items, p_items: [], p_channel: "phone" })).error).toMatch(/NO_ITEMS/);
    const foreign = (await items(c.b))[0];
    expect((await rpc(as.staff, "begin_email_reminder", { p_client: c.items, p_items: [own[0], foreign] })).error).toMatch(/ITEMS_INVALID/);
    expect((await rpc(as.staff, "record_follow_up", { p_client: c.items, p_items: [foreign], p_channel: "whatsapp" })).error).toMatch(/ITEMS_INVALID/);

    await mustCreateDocument(as.staff, { client_id: c.items, doc_type_id: await typeId(officeId, T.bank),
      period_id: await periodId(officeId, "2026-03"), received_on: "2026-07-16" });
    expect((await rpc(as.staff, "record_follow_up", { p_client: c.items, p_items: [own[0]], p_channel: "phone" })).error).toMatch(/ITEMS_INVALID/);

    const row = await planRow(c.items, T.bank);
    expect((await as.manager.from("client_doc_type").update({ state: "paused" }).eq("id", row.id)).error).toBeNull();
    expect((await rpc(as.staff, "record_follow_up", { p_client: c.items, p_items: [own[1]], p_channel: "phone" })).error).toMatch(/ITEMS_INVALID/);
    expect((await as.manager.from("client_doc_type").update({ state: "active" }).eq("id", row.id)).error).toBeNull();
    expect(await followUpsOf(officeId, c.items)).toEqual([]);
  });

  it("no email → NO_EMAIL; no mobile → NO_MOBILE; a call needs neither", async () => {
    const ids = await items(c.noContact);
    expect((await rpc(as.staff, "begin_email_reminder", { p_client: c.noContact, p_items: ids })).error).toMatch(/NO_EMAIL/);
    expect((await rpc(as.staff, "record_follow_up", { p_client: c.noContact, p_items: ids, p_channel: "whatsapp" })).error).toMatch(/NO_MOBILE/);
    await mustRpc(as.staff, "record_follow_up", { p_client: c.noContact, p_items: ids, p_channel: "phone" });
  });

  it("an item may be included even when its plan row has reminders off (unticked by default, not forbidden)", async () => {
    const row = await planRow(c.call, T.bank);
    expect((await as.staff.from("client_doc_type").update({ reminders: false }).eq("id", row.id)).error).toBeNull();
    await mustRpc(as.staff, "record_follow_up", { p_client: c.call, p_items: [(await items(c.call))[0]], p_channel: "phone" });
  });
});

describe("WhatsApp and calls (AC-9, AC-11)", () => {
  it("WhatsApp records 'opened' with the mobile snapshot and today's date; it is not capped", async () => {
    const ids = await items(c.call);
    const one = await mustRpc<string>(as.staff, "record_follow_up", { p_client: c.call, p_items: ids, p_channel: "whatsapp" });
    await mustRpc<string>(as.staff, "record_follow_up", { p_client: c.call, p_items: ids, p_channel: "whatsapp" });
    const f = (await followUpsOf(officeId, c.call)).find((r) => r.id === one)!;
    expect(f).toMatchObject({ channel: "whatsapp", status: "opened", sent_on: "2026-07-16", note: null });
    expect(f.recipient).toMatch(/^[6-9][0-9]{9}$/);
  });

  it("a call is 'logged' with its date (default today, never future) and an optional note ≤ 300", async () => {
    const ids = await items(c.call);
    const id = await mustRpc<string>(as.staff, "record_follow_up",
      { p_client: c.call, p_items: ids, p_channel: "phone", p_on: "2026-07-14", p_note: "Spoke to accountant; sending Friday" });
    const f = (await followUpsOf(officeId, c.call)).find((r) => r.id === id)!;
    expect(f).toMatchObject({ channel: "phone", status: "logged", sent_on: "2026-07-14", recipient: null,
      note: "Spoke to accountant; sending Friday" });
    expect((await rpc(as.staff, "record_follow_up", { p_client: c.call, p_items: ids, p_channel: "phone", p_on: "2026-07-17" })).error)
      .toMatch(/FUTURE_DATE/);
    expect((await rpc(as.staff, "record_follow_up", { p_client: c.call, p_items: ids, p_channel: "phone", p_note: "x".repeat(301) })).error)
      .toMatch(/NOTE_TOO_LONG/);
    expect((await rpc(as.staff, "record_follow_up", { p_client: c.call, p_items: ids, p_channel: "email" })).error)
      .toMatch(/BAD_CHANNEL|invalid input/);
  });
});

describe("visibility and write paths (AC-16)", () => {
  it("Limited can remind and see follow-ups only for their own clients", async () => {
    const own = await items(c.limitedOwn);
    await mustRpc(as.limited, "record_follow_up", { p_client: c.limitedOwn, p_items: own, p_channel: "phone" });
    await emailReminder(as.limited, c.limitedOwn, own, "suppressed");
    const r = await rpc(as.limited, "record_follow_up", { p_client: c.b, p_items: await items(c.b), p_channel: "phone" });
    expect(r.error).toMatch(/NOT_FOUND/);
    expect((await rpc(as.limited, "begin_email_reminder", { p_client: c.e, p_items: await items(c.e) })).error).toMatch(/NOT_FOUND/);

    const { data: seen } = await as.limited.from("follow_up").select("client_id");
    expect(new Set(seen!.map((r) => r.client_id))).toEqual(new Set([c.limitedOwn]));
    const { data: seenItems } = await as.limited.from("follow_up_item").select("follow_up_id");
    const ownIds = new Set((await followUpsOf(officeId, c.limitedOwn)).map((f) => f.id));
    expect(seenItems!.length).toBeGreaterThan(0);
    expect(seenItems!.every((r) => ownIds.has(r.follow_up_id))).toBe(true);
  });

  it("Staff see every follow-up of the office; another office sees none", async () => {
    const { data } = await as.staff2.from("follow_up").select("id");
    expect(data!.length).toBe((await followUpsOf(officeId)).length);
    const otherOffice = await createDocumentOffice("followup-other");
    const outsider = await createStaff(otherOffice, "fu-outsider", "admin");
    const asOut = await signedInClient(outsider.email);
    const { data: none } = await asOut.from("follow_up").select("id");
    expect(none).toEqual([]);
    expect((await rpc(asOut, "record_follow_up", { p_client: c.a, p_items: await items(c.a), p_channel: "phone" })).error).toMatch(/NOT_FOUND/);
    await retireStaff([outsider.id]);
  });

  it("there is no app write path: direct insert, update and delete are refused for every role", async () => {
    const [f] = await followUpsOf(officeId, c.b);
    for (const who of [as.admin, as.staff, as.limited]) {
      const ins = await who.from("follow_up").insert({ office_id: officeId, client_id: c.b, channel: "phone", status: "logged", sent_by: u.staff.id, sent_on: "2026-07-16" });
      expect(ins.error?.message).toMatch(DENIED);
      const insItem = await who.from("follow_up_item").insert({ office_id: officeId, follow_up_id: f.id, expected_doc_id: (await items(c.b))[0] });
      expect(insItem.error?.message).toMatch(DENIED);
      const upd = await who.from("follow_up").update({ status: "sent" }).eq("id", f.id).select("id");
      expect(upd.error?.message ?? (upd.data!.length === 0 ? "permission denied (0 rows)" : "")).toMatch(DENIED);
      const del = await who.from("follow_up").delete().eq("id", f.id).select("id");
      expect(del.error?.message ?? (del.data!.length === 0 ? "permission denied (0 rows)" : "")).toMatch(DENIED);
    }
    expect((await followUpsOf(officeId, c.b))[0]).toMatchObject({ id: f.id, status: f.status });
  });

  it("even the service role cannot rewrite or delete a finished follow-up (outside the test purge)", async () => {
    const [f] = await followUpsOf(officeId, c.b);
    expect((await adminClient().from("follow_up").update({ status: "sent" }).eq("id", f.id)).error?.message).toMatch(/IMMUTABLE|permission|NO_DELETE/);
    expect((await adminClient().from("follow_up").delete().eq("id", f.id)).error?.message).toMatch(/NO_DELETE|permission/);
  });
});

describe("activity (AC-17)", () => {
  it("one row per finished follow-up, with IDs, channel, status and item count only — never address, text or note", async () => {
    // Activity is append-only and survives reset_test_office, so earlier runs' rows remain: check this run's only.
    const all = await followUpsOf(officeId);
    const current = new Set(all.map((f) => f.id));
    const acts = (await reminderActivity(officeId)).filter((a) => current.has(a.entity_id));
    expect(acts.map((a) => a.action)).toEqual(expect.arrayContaining(["reminder.email", "reminder.whatsapp", "reminder.call"]));
    for (const a of acts) {
      expect(a.entity_type).toBe("follow_up");
      const f = all.find((x) => x.id === a.entity_id)!;
      expect(f).toBeDefined();
      expect(Object.keys(a.data).sort()).toEqual(["channel", "client_id", "items", "status"]);
      expect(a.data).toMatchObject({ client_id: f.client_id, channel: f.channel, status: f.status });
      const text = JSON.stringify(a.data);
      expect(text).not.toMatch(/@|accountant|[6-9][0-9]{9}/);
    }
    // Every finished email has exactly one row; pending ones have none yet.
    const finishedEmails = all.filter((f) => f.channel === "email" && f.status !== "pending");
    expect(acts.filter((a) => a.action === "reminder.email").length).toBe(finishedEmails.length);
    expect(acts.filter((a) => a.action !== "reminder.email").length).toBe(all.filter((f) => f.channel !== "email").length);
  });
});

describe("test-office purge (data model: cascades only for reset_test_office)", () => {
  it("reset_test_office removes the office's follow-ups and their items", async () => {
    expect((await followUpsOf(officeId)).length).toBeGreaterThan(0);
    const { error } = await adminClient().rpc("reset_test_office", { p_office_id: officeId });
    expect(error).toBeNull();
    expect(await followUpsOf(officeId)).toEqual([]);
    const { data } = await adminClient().from("follow_up_item").select("id").eq("office_id", officeId);
    expect(data).toEqual([]);
  });
});
