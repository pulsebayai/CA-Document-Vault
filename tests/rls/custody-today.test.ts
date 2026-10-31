import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import {
  createDocumentOffice, mustCreateDocument, mustDispatch, mustMarkReady, mustReview, mustSetCustody, periodId, typeId,
} from "../support/documents";
import { T, bankOnlyClient, generateAsOf, mustRpc } from "../support/expected";

// Feature 13 — Today "To place in office" and "In office > 30 days" (spec AC-10, AC-11, S4) and the /documents
// Custody filter (AC-12). Written before migrations A/B (plan step 1).
// Contract: today_items counts gain `to_place` and `held`; p_show gains 'to_place' and 'held'. Their rows (kind
// 'to_place' | 'held') come only when that show is chosen — the default list stays To review / Ready to dispatch
// (Sidambara 2026-10-31, like 10's "requested later"). `ready` counts stored Ready only.
//   To place = filed hard copy, Reviewed or Needs correction, no custody step, live document and client.
//   Held = returnable, in office or ready, not in a live packet, live, marked in office > 30 office days ago.
// search_documents / facets: filters.return ∈ to_place | in_office | ready | dispatched; filters.held = true.

type Who = "admin" | "s1" | "s2";
type Row = { document_id?: string; kind: string };
type Card = { client_id: string; rows: Row[] };
type Data = { counts: Record<string, number>; cards: Card[] };
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
let alpha: string, bravo: string;
const d = {} as Record<"toPlace" | "toPlaceFix" | "inOffice" | "ready" | "sent" | "plainInOffice" | "bravoToPlace" | "toReview", string>;

const istToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const plusDays = (day: string, n: number) => { const t = new Date(`${day}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const today = (who: SupabaseClient, scope: string, show: string | null = null) =>
  mustRpc<Data>(who, "today_items", { p_scope: scope, p_show: show, p_page: 0, p_limit: 100 });
const docIds = (data: Data, kind?: string) =>
  data.cards.flatMap((c) => c.rows).filter((r) => r.document_id && (!kind || r.kind === kind)).map((r) => r.document_id!).sort();
const search = async (filters: Record<string, unknown>) => {
  const { data, error } = await as.s1.rpc("search_documents", { p: { filters: { client_id: alpha, ...filters } } });
  if (error) throw new Error(error.message);
  return (data as { total: number; rows: Array<{ id: string }> });
};

beforeAll(async () => {
  officeId = await createDocumentOffice("custody-today");
  u.admin = await createStaff(officeId, "ct-admin", "admin");
  u.s1 = await createStaff(officeId, "ct-s1", "staff");
  u.s2 = await createStaff(officeId, "ct-s2", "staff");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  await generateAsOf(as.admin, istToday());
  alpha = await bankOnlyClient(as.s1, officeId, { name: "Custody Alpha", incharge_id: u.s1.id });
  bravo = await bankOnlyClient(as.s1, officeId, { name: "Custody Bravo", incharge_id: u.s2.id });
  const bank = await typeId(officeId, T.bank);
  const doc = async (client: string, period: string, extra: Record<string, unknown> = {}) =>
    (await mustCreateDocument(as.s1, { client_id: client, doc_type_id: bank, period_id: await periodId(officeId, period),
      received_as: "hard_copy", received_on: "2026-05-02", ...extra } as never)).id;
  d.toPlace = await doc(alpha, "2026-04", { returnable: true });
  await mustReview(as.s1, d.toPlace);
  d.toPlaceFix = await doc(alpha, "2026-03");
  await mustReview(as.s1, d.toPlaceFix, "needs_correction", "Pages missing");
  d.inOffice = await doc(alpha, "2026-02", { returnable: true });
  await mustReview(as.s1, d.inOffice);
  await mustSetCustody(as.s1, [d.inOffice], "in_office");
  d.ready = await doc(alpha, "2026-01", { returnable: true });
  await mustReview(as.s1, d.ready);
  await mustMarkReady(as.s1, d.ready);
  d.sent = await doc(alpha, "2025-12", { returnable: true });
  await mustReview(as.s1, d.sent);
  await mustMarkReady(as.s1, d.sent);
  await mustDispatch(as.s1, { client_id: alpha, document_ids: [d.sent], dispatched_on: istToday() });
  d.plainInOffice = await doc(alpha, "2025-11");
  await mustReview(as.s1, d.plainInOffice);
  await mustSetCustody(as.s1, [d.plainInOffice], "in_office");
  d.bravoToPlace = await doc(bravo, "2026-04");
  await mustReview(as.s1, d.bravoToPlace);
  d.toReview = await doc(alpha, "2025-10");
}, 180_000);

afterAll(async () => {
  await generateAsOf(as.admin, istToday()).catch(() => undefined);
  await retireStaff([u.s1, u.s2].filter(Boolean).map((x) => x.id));
  if (u.admin) await retireStaff([u.admin.id]);
});

describe("Today: To place in office (AC-11, S4)", () => {
  it("counts reviewed or Needs-correction hard copies with no custody step, for Everyone and Mine", async () => {
    expect((await today(as.s1, "everyone")).counts).toMatchObject({ to_place: 3, ready: 1 });
    expect((await today(as.s1, "mine")).counts).toMatchObject({ to_place: 2 });
    expect((await today(as.s2, "mine")).counts).toMatchObject({ to_place: 1 });
  });

  it("its rows come only when chosen; the default list keeps To review and Ready to dispatch", async () => {
    const all = await today(as.s1, "everyone");
    expect(docIds(all)).toEqual([d.toReview, d.ready].sort());
    const chosen = await today(as.s1, "everyone", "to_place");
    expect(docIds(chosen, "to_place")).toEqual([d.toPlace, d.toPlaceFix, d.bravoToPlace].sort());
    expect(docIds(chosen).length).toBe(3);
  });

  it("Ready to dispatch counts and lists stored Ready only", async () => {
    const r = await today(as.s1, "everyone", "ready");
    expect(docIds(r, "ready")).toEqual([d.ready]);
  });
});

describe("Today: In office > 30 days (AC-10, AC-11)", () => {
  it("is 0 on the day of marking and at exactly 30 days", async () => {
    expect((await today(as.s1, "everyone")).counts).toMatchObject({ held: 0 });
    await generateAsOf(as.admin, plusDays(istToday(), 30));
    expect((await today(as.s1, "everyone")).counts).toMatchObject({ held: 0 });
  });

  it("after 30 days counts returnable documents in office or ready, not plain or dispatched ones", async () => {
    await generateAsOf(as.admin, plusDays(istToday(), 31));
    expect((await today(as.s1, "everyone")).counts).toMatchObject({ held: 2 });
    expect(docIds(await today(as.s1, "everyone", "held"), "held")).toEqual([d.inOffice, d.ready].sort());
    expect((await today(as.s2, "mine")).counts).toMatchObject({ held: 0 });
    expect((await search({ held: true })).rows.map((r) => r.id).sort()).toEqual([d.inOffice, d.ready].sort());
    await generateAsOf(as.admin, istToday());
  });
});

describe("/documents Custody filter (AC-12)", () => {
  it("to_place · in_office · ready · dispatched each list their documents; facets count the same", async () => {
    const ids = async (ret: string) => (await search({ return: ret })).rows.map((r) => r.id).sort();
    expect(await ids("to_place")).toEqual([d.toPlace, d.toPlaceFix].sort());
    expect(await ids("in_office")).toEqual([d.inOffice, d.plainInOffice].sort());
    expect(await ids("ready")).toEqual([d.ready]);
    expect(await ids("dispatched")).toEqual([d.sent]);
    const { data, error } = await as.s1.rpc("search_document_facets", { p: { filters: { client_id: alpha } } });
    expect(error).toBeNull();
    const f = data as Array<{ facet: string; value: string; n: number }>;
    for (const ret of ["to_place", "in_office", "ready", "dispatched"]) {
      expect(f.find((x) => x.facet === "return" && x.value === ret)?.n ?? 0, ret).toBe((await search({ return: ret })).total);
    }
  });

  it("an unknown value is refused", async () => {
    await expect(search({ return: "lost" })).rejects.toThrow(/INVALID_FILTER/);
  });
});
