import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, typeId, uploadObject } from "../support/documents";
import { T, bankOnlyClient, generateAsOf, mustRpc } from "../support/expected";

// Feature 10 step 10 — Today (spec AC-17, AC-13 requester part, D7). Written before migration G.
// Contract (additions to 06's today_items, nothing removed):
//   * open ad-hoc items are rows {item_id, kind: 'requested', due: 'overdue' | 'due_week', group, type, period,
//     needed_by, note} on the REQUESTER's Mine (the request's created_by) and on Everyone; Overdue = needed-by
//     passed; Due this week = needed-by within 7 days; other open items (no date, or later) are only counted (D7);
//   * counts gain requested (all open ad-hoc items in scope) and requested_later (those not shown as rows);
//     p_show adds 'requested'; cards gain a requested count; expected counts are unchanged;
//   * a link upload (channel upload_link) To review is also on its requester's Mine.
// Fixture: client incharge = s1; requests sent by s2. Clock 15 Mar 2026 (no expected items asked yet).

type Who = "admin" | "s1" | "s2";
type Row = { kind: string; item_id?: string; due?: string; document_id?: string; note?: string | null; needed_by?: string | null };
type Card = { client_id: string; requested?: number; rows: Row[] };
type Data = { counts: Record<string, number>; cards: Card[] };
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
let client: string;
let notice: string;
const items = {} as Record<"late" | "soon" | "undated" | "far", string>;
let linkHash: string;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ip = () => sha(`ip-today-${Date.now()}-${Math.random()}`);
const today = (who: SupabaseClient, scope: string, show: string | null = null) =>
  mustRpc<Data>(who, "today_items", { p_scope: scope, p_show: show, p_page: 0, p_limit: 100 });
const askRows = (d: Data) => d.cards.flatMap((c) => c.rows.filter((r) => r.kind === "requested"));
const docIds = (d: Data) => d.cards.flatMap((c) => c.rows.flatMap((r) => (r.document_id ? [r.document_id] : [])));

beforeAll(async () => {
  officeId = await createDocumentOffice("upload-today");
  u.admin = await createStaff(officeId, "utd-admin", "admin");
  u.s1 = await createStaff(officeId, "utd-s1", "staff");
  u.s2 = await createStaff(officeId, "utd-s2", "staff");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  await generateAsOf(as.admin, "2026-03-10");
  client = await bankOnlyClient(as.s1, officeId, { name: "Today Requested", incharge_id: u.s1.id, email: "utd@example.test", mobile: "9876541301" });
  notice = await typeId(officeId, T.notice);
  const token = randomBytes(32).toString("base64url");
  linkHash = sha(token);
  const { data, error } = await as.s2.rpc("record_link_whatsapp", { p: { client_id: client, token_hash: linkHash, items: [
    { kind: "ad_hoc", doc_type_id: notice, needed_by: "2026-03-12", note: "late one" },
    { kind: "ad_hoc", doc_type_id: notice, needed_by: "2026-03-20", note: "soon one" },
    { kind: "ad_hoc", doc_type_id: notice, note: "undated one" },
    { kind: "ad_hoc", doc_type_id: notice, needed_by: "2026-04-30", note: "far one" },
  ] } });
  if (error) throw new Error(error.message);
  const { data: rows } = await adminClient().from("upload_request_item").select("id, note").eq("request_id", (data as { request_id: string }).request_id);
  for (const r of rows as Array<{ id: string; note: string }>) items[r.note.split(" ")[0] as keyof typeof items] = r.id;
  await generateAsOf(as.admin, "2026-03-15"); // late one is now past its needed-by date
}, 300_000);

afterAll(async () => { await retireStaff(Object.values(u).map((x) => x.id)); });

describe("requested rows (AC-17, D7)", () => {
  it("are on the requester's Mine: overdue past needed-by, due this week within 7 days; others only counted", async () => {
    const d = await today(as.s2, "mine");
    const rows = askRows(d);
    expect(rows.map((r) => [r.item_id, r.due]).sort()).toEqual([[items.late, "overdue"], [items.soon, "due_week"]].sort());
    expect(d.counts).toMatchObject({ requested: 4, requested_later: 2, overdue: 0, due_week: 0 });
    expect(rows.find((r) => r.item_id === items.late)).toMatchObject({ note: "late one", needed_by: "2026-03-12" });
  });

  it("are not on the incharge's Mine (the requester chases them), but are on Everyone", async () => {
    expect(askRows(await today(as.s1, "mine"))).toEqual([]);
    expect((await today(as.s1, "mine")).counts.requested ?? 0).toBe(0);
    expect(askRows(await today(as.s1, "everyone")).map((r) => r.item_id).sort()).toEqual([items.late, items.soon].sort());
  });

  it("the 'requested' filter keeps only requested rows; other filters keep none of them", async () => {
    const f = await today(as.s2, "mine", "requested");
    expect(f.cards.flatMap((c) => c.rows).every((r) => r.kind === "requested")).toBe(true);
    expect(askRows(f)).toHaveLength(2);
    for (const show of ["overdue", "due_week", "to_review", "ready"]) expect(askRows(await today(as.s2, "mine", show))).toEqual([]);
  });

  it("a cancelled item leaves Today", async () => {
    const { error } = await as.s2.rpc("cancel_request_item", { p_id: items.soon, p_reason: "not needed" });
    if (error) throw new Error(error.message);
    const d = await today(as.s2, "mine");
    expect(askRows(d).map((r) => r.item_id)).toEqual([items.late]);
    expect(d.counts.requested).toBe(3);
  });
});

describe("link uploads To review are on the requester's Mine (AC-13)", () => {
  it("the requester sees the client's upload To review; the item leaves Requested as Received", async () => {
    const t = await mustRpc<{ office_id: string; document_id: string }>(adminClient(), "link_ticket",
      { p_token_hash: linkHash, p_item_id: items.late, p_file: { ext: "pdf", size: 60 }, p_ip_hash: ip() });
    const obj = await uploadObject(t.office_id, "pdf", t.document_id);
    const reg = await mustRpc<{ document_id: string }>(adminClient(), "link_register",
      { p_token_hash: linkHash, p_item_id: items.late, p_file: { storage_path: obj.path, file_name: "late.pdf" }, p_ip_hash: ip() });
    const mine = await today(as.s2, "mine");
    expect(docIds(mine)).toContain(reg.document_id);
    expect(askRows(mine).map((r) => r.item_id)).not.toContain(items.late);
    expect(docIds(await today(as.s1, "mine"))).toContain(reg.document_id); // still the assignee's too (06's rule)
  });
});
