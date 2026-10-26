import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, mustReview, typeId } from "../support/documents";
import { T, bankOnlyClient, expectedItem, generateAsOf, mustRpc, planRow } from "../support/expected";
import { EXCEL, fileAs, uploadAs } from "../support/formats";

// Feature 11 — what reads the check (spec AC-12, AC-13, AC-21, AC-22, AC-24; plan step 1).
//   link_open: each item gains `preferred` (format list) when a preference applies; absent otherwise.
//   link_register: p_file.warned (boolean, from the page) → data.warned on its document.link_upload row.
//   search_documents / search_document_facets: filters.format = 'not_preferred'; facet 'format' (value not_preferred).
//   format_metric(p_from, p_to) → FormatMetric (Admin/Manager).

type FormatMetric = {
  applied: { link: { total: number; preferred: number }; staff: { total: number; preferred: number } };
  warned: { total: number; switched: number; anyway: number };
  flagged_review_hours_median: number | null;
  exceptions: Array<{ type_id: string; type: string; n: number }>;
};

type Who = "admin" | "staff" | "limited";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
const c = {} as Record<"a" | "b" | "exception", string>;
const admin = () => adminClient();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ip = () => sha(`ip-${randomBytes(6).toString("hex")}`);
const TAG = `zfmt${Date.now().toString(36)}`;
const WIDE = { p_from: "2020-01-01", p_to: "2099-12-31" };

type Res = { data: Record<string, unknown> | null; error: { message: string } | null };
const call = (fn: string, args: Record<string, unknown>, client: SupabaseClient = admin()) => client.rpc(fn, args) as unknown as Promise<Res>;
async function ok(p: Promise<Res>) { const r = await p; if (r.error) throw new Error(r.error.message); return r.data as Record<string, unknown>; }

async function sendLink(client: string, items: unknown[]) {
  const token = randomBytes(32).toString("base64url");
  const res = await ok(call("record_link_whatsapp", { p: { client_id: client, items, token_hash: sha(token) } }, as.staff));
  const { data: rows } = await admin().from("upload_request_item").select("id, kind").eq("request_id", res.request_id).order("kind");
  return { hash: sha(token), items: (rows ?? []) as Array<{ id: string; kind: string }> };
}
async function linkUpload(hash: string, item: string, ext: string, warned?: boolean) {
  const ipHash = ip();
  const t = await ok(call("link_ticket", { p_token_hash: hash, p_item_id: item, p_file: { ext, size: 60 }, p_ip_hash: ipHash }));
  const obj = await uploadAs(t.office_id as string, ext, t.document_id as string);
  const file: Record<string, unknown> = { storage_path: obj.path, file_name: `upload.${ext}` };
  if (warned !== undefined) file.warned = warned;
  return ok(call("link_register", { p_token_hash: hash, p_item_id: item, p_file: file, p_ip_hash: ipHash }));
}
async function linkActivity(documentId: string) {
  const { data, error } = await admin().from("activity").select("data").eq("action", "document.link_upload").eq("entity_id", documentId).single();
  if (error) throw error;
  return data.data as Record<string, unknown>;
}

beforeAll(async () => {
  officeId = await createDocumentOffice("formats-reads");
  u.admin = await createStaff(officeId, "fr-admin", "admin");
  u.staff = await createStaff(officeId, "fr-staff", "staff");
  u.limited = await createStaff(officeId, "fr-limited", "limited");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  await generateAsOf(as.admin, "2026-03-15");
  c.a = await bankOnlyClient(as.staff, officeId, { name: "Formats reads A", incharge_id: u.limited.id, mobile: "9876540001" });
  c.b = await bankOnlyClient(as.staff, officeId, { name: "Formats reads B", incharge_id: u.staff.id, mobile: "9876540002" });
  c.exception = await bankOnlyClient(as.staff, officeId, { name: "Formats reads exception", incharge_id: u.staff.id, mobile: "9876540003" });
  const row = await planRow(c.exception, T.bank);
  const { error } = await as.staff.from("client_doc_type").update({ any_format: true }).eq("id", row.id);
  if (error) throw error;
  await generateAsOf(as.admin, "2026-05-15");
}, 300_000);

afterAll(async () => {
  await retireStaff(Object.values(u).filter(Boolean).map((x) => x.id));
});

describe("the upload page (AC-9, AC-12)", () => {
  it("an item whose type has a preference carries it; one without, doesn't", async () => {
    const link = await sendLink(c.b, [
      { kind: "scheduled", expected_doc_id: (await expectedItem(c.b, T.bank, "2026-03")).id },
      { kind: "ad_hoc", doc_type_id: await typeId(officeId, T.notice) },
    ]);
    const page = await ok(call("link_open", { p_token_hash: link.hash, p_ip_hash: ip() }));
    const items = page.items as Array<Record<string, unknown>>;
    const sched = items.find((i) => i.kind === "scheduled")!;
    const adhoc = items.find((i) => i.kind === "ad_hoc")!;
    expect([...(sched.preferred as string[])].sort()).toEqual([...EXCEL].sort());
    expect(adhoc.preferred ?? null).toBeNull();
  });

  it("a client with an exception sees no preference, and nothing on the page says why", async () => {
    const link = await sendLink(c.exception, [{ kind: "scheduled", expected_doc_id: (await expectedItem(c.exception, T.bank, "2026-03")).id }]);
    const page = await ok(call("link_open", { p_token_hash: link.hash, p_ip_hash: ip() }));
    const item = (page.items as Array<Record<string, unknown>>)[0];
    expect(item.preferred ?? null).toBeNull();
    expect(JSON.stringify(page)).not.toMatch(/any_format|exception/i);
  });

  it("the page's 'warned' answer is kept on the link-upload activity row (AC-13)", async () => {
    const link = await sendLink(c.b, [{ kind: "ad_hoc", doc_type_id: await typeId(officeId, T.bank) }]);
    const warned = await linkUpload(link.hash, link.items[0].id, "pdf", true);
    expect(await linkActivity(warned.id as string)).toMatchObject({ warned: true });
    const plain = await linkUpload(link.hash, link.items[0].id, "csv");
    expect(await linkActivity(plain.id as string)).toMatchObject({ warned: false });
  });

  it("a 'warned' that isn't a boolean is stored as false", async () => {
    const link = await sendLink(c.b, [{ kind: "ad_hoc", doc_type_id: await typeId(officeId, T.bank) }]);
    const ipHash = ip();
    const t = await ok(call("link_ticket", { p_token_hash: link.hash, p_item_id: link.items[0].id, p_file: { ext: "pdf", size: 60 }, p_ip_hash: ipHash }));
    const obj = await uploadAs(t.office_id as string, "pdf", t.document_id as string);
    const reg = await ok(call("link_register", { p_token_hash: link.hash, p_item_id: link.items[0].id,
      p_file: { storage_path: obj.path, file_name: "x.pdf", warned: "<script>" }, p_ip_hash: ipHash }));
    expect(await linkActivity(reg.id as string)).toMatchObject({ warned: false });
  });
});

describe("search filter and facet (AC-21, AC-22)", () => {
  const flagged: string[] = [];
  beforeAll(async () => {
    const bank = await typeId(officeId, T.bank);
    flagged.push((await fileAs(as.staff, officeId, "pdf", { client_id: c.a, doc_type_id: bank, remark: `${TAG} a1` })).id);
    flagged.push((await fileAs(as.staff, officeId, "docx", { client_id: c.b, doc_type_id: bank, remark: `${TAG} b1` })).id);
    await fileAs(as.staff, officeId, "csv", { client_id: c.a, doc_type_id: bank, remark: `${TAG} a2` });
    await fileAs(as.staff, officeId, "pdf", { client_id: c.a, doc_type_id: await typeId(officeId, T.notice), remark: `${TAG} a3` });
  }, 120_000);

  type Search = { text?: string; filters?: Record<string, unknown> };
  const search = async (who: Who, s: Search) => {
    const { data, error } = await as[who].rpc("search_documents", { p: s });
    if (error) throw new Error(error.message);
    return data as { total: number; rows: Array<{ id: string }> };
  };
  const facets = async (who: Who, s: Search) => {
    const { data, error } = await as[who].rpc("search_document_facets", { p: s });
    if (error) throw new Error(error.message);
    return (data as Array<{ facet: string; value: string; n: number }>).filter((f) => f.facet === "format");
  };

  it("the filter lists only flagged documents", async () => {
    const r = await search("staff", { text: TAG, filters: { format: "not_preferred" } });
    expect(r.rows.map((x) => x.id).sort()).toEqual([...flagged].sort());
    expect(r.total).toBe(2);
  });

  it("an unknown filter value is refused, not ignored", async () => {
    const { error } = await as.staff.rpc("search_documents", { p: { text: TAG, filters: { format: "preferred" } } });
    expect(error?.message ?? "").toMatch(/INVALID|format/i);
  });

  it("the facet counts flagged matches and combines with other filters", async () => {
    expect(await facets("staff", { text: TAG })).toEqual([expect.objectContaining({ value: "not_preferred", n: 2 })]);
    await mustReview(as.staff, flagged[0]);
    expect((await search("staff", { text: TAG, filters: { format: "not_preferred", status: "received" } })).rows.map((x) => x.id)).toEqual([flagged[1]]);
  });

  it("the facet is hidden when nothing is flagged", async () => {
    expect(await facets("staff", { text: `${TAG} a2` })).toEqual([]);
  });

  it("a Limited user counts only clients they can see", async () => {
    const r = await search("limited", { text: TAG, filters: { format: "not_preferred" } });
    expect(r.rows.map((x) => x.id)).toEqual([flagged[0]]);
    expect(await facets("limited", { text: TAG })).toEqual([expect.objectContaining({ value: "not_preferred", n: 1 })]);
  });

  it("searches without the filter return what they returned before, plus one facet row", async () => {
    const r = await search("staff", { text: TAG });
    expect(r.total).toBe(4);
  });
});

describe("format_metric (AC-24)", () => {
  it("is Admin/Manager only", async () => {
    const r = await as.staff.rpc("format_metric", WIDE);
    expect(r.error?.message ?? "").toMatch(/ROLE_REQUIRED/);
  });

  it("counts filings where a preference applied, by channel; warned uploads; and exceptions", async () => {
    const m = await mustRpc<FormatMetric>(as.admin, "format_metric", WIDE);
    // Link uploads above: pdf(warned) + csv + pdf("<script>") on Bank statement = 3 applied, 1 preferred; warned 1, anyway 1.
    expect(m.applied.link).toEqual({ total: 3, preferred: 1 });
    // Staff filings above (search fixtures): pdf + docx + csv on Bank statement = 3 applied, 1 preferred (notice has no preference).
    expect(m.applied.staff).toEqual({ total: 3, preferred: 1 });
    expect(m.warned).toEqual({ total: 1, switched: 0, anyway: 1 });
    expect(m.exceptions).toEqual([expect.objectContaining({ type: T.bank, n: 1 })]);
    expect(m.flagged_review_hours_median === null || typeof m.flagged_review_hours_median === "number").toBe(true);
  });

  it("an empty window returns zeros", async () => {
    const m = await mustRpc<FormatMetric>(as.admin, "format_metric", { p_from: "2020-01-01", p_to: "2020-01-31" });
    expect(m.applied).toEqual({ link: { total: 0, preferred: 0 }, staff: { total: 0, preferred: 0 } });
    expect(m.warned).toEqual({ total: 0, switched: 0, anyway: 0 });
    expect(m.flagged_review_hours_median).toBeNull();
  });
});
