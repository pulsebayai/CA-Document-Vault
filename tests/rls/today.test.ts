import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { groupId } from "../support/catalogue";
import { createDocumentOffice } from "../support/documents";
import {
  T, bankOnlyClient, emailReminder, expectedItem, generateAsOf, mustRpc, planRow, rpc, type TodayData,
} from "../support/expected";

// Feature 06 — today_items (spec AC-2…AC-5, "Key definitions"): counts = rows, scope Mine / Everyone with the
// effective assignee (type → group → incharge), the due-this-week boundary on the office date, on hold and
// archived excluded, card/row order, paging, filters as enums, row history.
// Written before the migration (plan step 1). Contract: tests/support/expected.ts ("Feature 06").
//
// Fixture: Bank statement only (monthly, asked +1/1, overdue +1/7), enabled at clock 15 Mar 2026 (start Mar).
//   alpha    incharge s1 · Banking group assigned s2           → s2's
//   bravo    incharge s1 · group s2 · Bank row assigned s3      → s3's (type wins)
//   charlie  incharge s1                                       → s1's
//   delta    incharge limited                                  → limited's
//   hold     incharge s1 · Bank row paused                     → never on Today
//   archived incharge s1 · archived                            → never on Today
//   week     incharge s1 · Bank row overdue +1/20               → Jun item overdue from 20 Jul
// Clock 12 Jul: Mar–Jun overdue (4) for alpha/bravo/charlie/delta; week: Mar–May overdue, Jun 8 days away.

type Who = "admin" | "manager" | "s1" | "s2" | "s3" | "limited";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
const c = {} as Record<"alpha" | "bravo" | "charlie" | "delta" | "hold" | "archived" | "week", string>;

const today = async (who: SupabaseClient, scope: string, show: string | null = null, page = 0, limit?: number) =>
  mustRpc<TodayData>(who, "today_items", { p_scope: scope, p_show: show, p_page: page, ...(limit ? { p_limit: limit } : {}) });

/** Every card across all pages (limit 100 → one page for this fixture). */
const allCards = async (who: SupabaseClient, scope: string, show: string | null = null) => (await today(who, scope, show, 0, 100)).cards;
const names = (cards: TodayData["cards"]) => cards.map((x) => x.client_id);
const rowsOf = (cards: TodayData["cards"]) => cards.flatMap((x) => x.rows);

beforeAll(async () => {
  officeId = await createDocumentOffice("today");
  u.admin = await createStaff(officeId, "td-admin", "admin");
  u.manager = await createStaff(officeId, "td-manager", "manager");
  u.s1 = await createStaff(officeId, "td-s1", "staff");
  u.s2 = await createStaff(officeId, "td-s2", "staff");
  u.s3 = await createStaff(officeId, "td-s3", "staff");
  u.limited = await createStaff(officeId, "td-limited", "limited");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  await generateAsOf(as.admin, "2026-03-15");
  const mk = (name: string, incharge: string, overdue?: { months: number; day: number }) =>
    bankOnlyClient(as.s1, officeId, { name, incharge_id: incharge, overdue });
  c.alpha = await mk("Today Alpha", u.s1.id);
  c.bravo = await mk("Today Bravo", u.s1.id);
  c.charlie = await mk("Today Charlie", u.s1.id);
  c.delta = await mk("Today Delta", u.limited.id);
  c.hold = await mk("Today Hold", u.s1.id);
  c.archived = await mk("Today Archived", u.s1.id);
  c.week = await mk("Today Week", u.s1.id, { months: 1, day: 20 });

  const banking = await groupId(officeId, "Banking");
  for (const k of ["alpha", "bravo"] as const) {
    const { error } = await as.manager.from("client_group").update({ assigned_staff_id: u.s2.id })
      .eq("client_id", c[k]).eq("doc_group_id", banking);
    if (error) throw error;
  }
  const bravoRow = await planRow(c.bravo, T.bank);
  const { error: e1 } = await as.manager.from("client_doc_type").update({ assigned_staff_id: u.s3.id }).eq("id", bravoRow.id);
  if (e1) throw e1;
  const holdRow = await planRow(c.hold, T.bank);
  await generateAsOf(as.admin, "2026-07-12");
  const { error: e2 } = await as.manager.from("client_doc_type").update({ state: "paused" }).eq("id", holdRow.id);
  if (e2) throw e2;
  const { error: e3 } = await as.manager.from("client").update({ archived_at: new Date().toISOString() }).eq("id", c.archived);
  if (e3) throw e3;
}, 180_000);

afterAll(async () => {
  await retireStaff([u.manager, u.s1, u.s2, u.s3, u.limited].filter(Boolean).map((x) => x.id));
  if (u.admin) await retireStaff([u.admin.id]);
});

describe("scope: Mine uses the effective assignee type → group → incharge (AC-3, Key definitions)", () => {
  it("each user's Mine holds exactly the clients whose items they own", async () => {
    expect(names(await allCards(as.s1, "mine")).sort()).toEqual([c.charlie, c.week].sort());
    expect(names(await allCards(as.s2, "mine"))).toEqual([c.alpha]);
    expect(names(await allCards(as.s3, "mine"))).toEqual([c.bravo]);
    expect(names(await allCards(as.limited, "mine"))).toEqual([c.delta]);
    expect(names(await allCards(as.admin, "mine"))).toEqual([]);
  });

  it("Everyone is everything the user can see; Limited still sees only their clients", async () => {
    expect(names(await allCards(as.s1, "everyone")).sort()).toEqual([c.alpha, c.bravo, c.charlie, c.delta, c.week].sort());
    expect(names(await allCards(as.limited, "everyone"))).toEqual([c.delta]);
  });

  it("on-hold and archived clients' items never appear", async () => {
    const ids = names(await allCards(as.manager, "everyone"));
    expect(ids).not.toContain(c.hold);
    expect(ids).not.toContain(c.archived);
  });

  it("rejects anything but the enums", async () => {
    expect((await rpc(as.s1, "today_items", { p_scope: "all", p_show: null })).error).toMatch(/BAD_SCOPE/);
    expect((await rpc(as.s1, "today_items", { p_scope: "mine", p_show: "Today Alpha" })).error).toMatch(/BAD_SHOW/);
  });
});

describe("counts, order and paging (AC-2, AC-4)", () => {
  it("reports the office date and counts = rows for every scope and filter", async () => {
    for (const who of [as.s1, as.s2, as.limited, as.manager]) {
      for (const scope of ["mine", "everyone"]) {
        const d = await today(who, scope, null, 0, 100);
        expect(d.today).toBe("2026-07-12");
        const rows = rowsOf(d.cards);
        expect(d.counts.overdue).toBe(rows.filter((r) => r.kind === "overdue").length);
        expect(d.counts.due_week).toBe(rows.filter((r) => r.kind !== "overdue").length);
        for (const show of ["overdue", "due_week"] as const) {
          const filtered = rowsOf(await allCards(who, scope, show));
          expect(filtered.length).toBe(d.counts[show]);
        }
      }
    }
    expect((await today(as.manager, "everyone")).counts).toMatchObject({ overdue: 19, due_week: 0 });
  });

  it("cards: most overdue first, then by name; rows: most days late first; header names incharge and group assignees", async () => {
    const cards = await allCards(as.manager, "everyone");
    expect(names(cards)).toEqual([c.alpha, c.bravo, c.charlie, c.delta, c.week]);
    const alpha = cards[0];
    expect(alpha).toMatchObject({ name: "Today Alpha", incharge: "Test td-s1", overdue: 4, due_week: 0 });
    expect(alpha.assignees).toEqual([{ group: "Banking", name: "Test td-s2" }]);
    expect(alpha.rows.map((r) => r.period)).toEqual(["Mar 2026", "Apr 2026", "May 2026", "Jun 2026"]);
    const late = alpha.rows.map((r) => r.days_late!);
    expect(late).toEqual([...late].sort((a, b) => b - a));
    expect(alpha.rows[0]).toMatchObject({ kind: "overdue", group: "Banking", type: T.bank, overdue_from: "2026-04-07", days_late: 97 });
  });

  it("pages by card with has_more", async () => {
    const p0 = await today(as.manager, "everyone", null, 0, 2);
    const p1 = await today(as.manager, "everyone", null, 1, 2);
    const p2 = await today(as.manager, "everyone", null, 2, 2);
    expect([names(p0.cards), names(p1.cards), names(p2.cards)]).toEqual([[c.alpha, c.bravo], [c.charlie, c.delta], [c.week]]);
    expect([p0.has_more, p1.has_more, p2.has_more]).toEqual([true, true, false]);
    expect(p2.counts).toEqual(p0.counts);
    expect((await today(as.manager, "everyone")).cards.length).toBe(5); // default page size 30
  });
});

describe("due this week: overdue date within the next 7 days on the office date (Key definitions, Raja Q5)", () => {
  const weekJun = () => expectedItem(c.week, T.bank, "2026-06");
  const rowFor = async (id: string) => rowsOf(await allCards(as.s1, "mine")).find((r) => r.expected_doc_id === id);

  it("8 days away: not on Today", async () => {
    expect(await rowFor((await weekJun()).id)).toBeUndefined();
  });

  it("7 days away (13 Jul): Due this week, counted and shown by the filter", async () => {
    await generateAsOf(as.admin, "2026-07-13");
    const id = (await weekJun()).id;
    expect(await rowFor(id)).toMatchObject({ kind: "due_week", days_late: null, overdue_from: "2026-07-20" });
    const d = await today(as.s1, "mine", "due_week");
    expect(d.counts.due_week).toBe(1);
    expect(names(d.cards)).toEqual([c.week]);
    expect(d.cards[0].rows.map((r) => r.expected_doc_id)).toEqual([id]);
    expect(d.cards[0].due_week).toBe(1);
  });

  it("the day before the overdue date (19 Jul): Due today, still within Due this week's count", async () => {
    await generateAsOf(as.admin, "2026-07-19");
    expect(await rowFor((await weekJun()).id)).toMatchObject({ kind: "due_today" });
    expect((await today(as.s1, "mine")).counts.due_week).toBe(1);
  });

  it("on the overdue date (20 Jul): Overdue, 1 day late", async () => {
    await generateAsOf(as.admin, "2026-07-20");
    expect(await rowFor((await weekJun()).id)).toMatchObject({ kind: "overdue", days_late: 1 });
    expect((await today(as.s1, "mine")).counts.due_week).toBe(0);
  });
});

describe("row history and flags (AC-5, AC-12)", () => {
  it("counts reminders (sent, suppressed, opened, logged), not failed ones; shows the last date, person and channel", async () => {
    const mar = await expectedItem(c.charlie, T.bank, "2026-03");
    await emailReminder(as.s2, c.charlie, [mar.id], "failed");
    await mustRpc(as.s1, "record_follow_up", { p_client: c.charlie, p_items: [mar.id], p_channel: "phone", p_on: "2026-07-18" });
    await mustRpc(as.s2, "record_follow_up", { p_client: c.charlie, p_items: [mar.id], p_channel: "phone", p_on: "2026-07-19" });
    const row = rowsOf(await allCards(as.s1, "mine")).find((r) => r.expected_doc_id === mar.id)!;
    expect(row).toMatchObject({ reminded: 2, last_reminded_on: "2026-07-19", last_reminded_by: "Test td-s2", last_channel: "phone" });
    const apr = await expectedItem(c.charlie, T.bank, "2026-04");
    expect(rowsOf(await allCards(as.s1, "mine")).find((r) => r.expected_doc_id === apr.id))
      .toMatchObject({ reminded: 0, last_reminded_on: null, last_channel: null });
  });

  it("carries the plan row's reminders flag (Remind unticks reminders-off items)", async () => {
    const row = await planRow(c.bravo, T.bank);
    expect((await as.manager.from("client_doc_type").update({ reminders: false }).eq("id", row.id)).error).toBeNull();
    const rows = rowsOf(await allCards(as.s3, "mine"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.reminders === false)).toBe(true);
    expect(rowsOf(await allCards(as.s2, "mine")).every((r) => r.reminders === true)).toBe(true);
  });
});
