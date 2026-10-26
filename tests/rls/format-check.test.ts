import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, mustCreateDocument, mustReview, typeId } from "../support/documents";
import { groupId, mergeType, mustOk, proposeType } from "../support/catalogue";
import { T, bankOnlyClient, expectedItem, generateAsOf, planRow } from "../support/expected";
import { EXCEL, addVersionAs, fileAs, formatCheck, same, setPreferred, uploadAs } from "../support/formats";

// Feature 11 — the format check on every filing path (spec AC-11, AC-14, AC-15, AC-18; plan step 1).
// The check lives in 03's document_before_write: set on create (via the version update), new version and
// client/type change; kept on everything else (review, archive, 05 merge, preference or exception changes).

type Who = "admin" | "staff" | "limited";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
const c = {} as Record<"a" | "exception", string>;
const admin = () => adminClient();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ip = () => sha(`ip-${randomBytes(6).toString("hex")}`);

type Res = { data: Record<string, unknown> | null; error: { message: string } | null };
const call = (fn: string, args: Record<string, unknown>, client: SupabaseClient = admin()) => client.rpc(fn, args) as unknown as Promise<Res>;
async function ok(p: Promise<Res>) { const r = await p; if (r.error) throw new Error(r.error.message); return r.data as Record<string, unknown>; }

beforeAll(async () => {
  officeId = await createDocumentOffice("formats-check");
  u.admin = await createStaff(officeId, "fc-admin", "admin");
  u.staff = await createStaff(officeId, "fc-staff", "staff");
  u.limited = await createStaff(officeId, "fc-limited", "limited");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  await generateAsOf(as.admin, "2026-03-15");
  c.a = await bankOnlyClient(as.staff, officeId, { name: "Formats check A", incharge_id: u.staff.id, mobile: "9876530001" });
  c.exception = await bankOnlyClient(as.staff, officeId, { name: "Formats check exception", incharge_id: u.staff.id });
  const row = await planRow(c.exception, T.bank);
  const { error } = await as.staff.from("client_doc_type").update({ any_format: true }).eq("id", row.id);
  if (error) throw error;
  await generateAsOf(as.admin, "2026-05-15");
}, 300_000);

afterAll(async () => {
  await retireStaff(Object.values(u).filter(Boolean).map((x) => x.id));
});

const bank = () => typeId(officeId, T.bank);

describe("staff filing (AC-14)", () => {
  it("a PDF bank statement is flagged with the preference it missed", async () => {
    const d = await fileAs(as.staff, officeId, "pdf", { client_id: c.a, doc_type_id: await bank() });
    expect(same(await formatCheck(d.id), EXCEL, false)).toBe(true);
  });

  it("a CSV bank statement is in a preferred format", async () => {
    const d = await fileAs(as.staff, officeId, "csv", { client_id: c.a, doc_type_id: await bank() });
    expect(same(await formatCheck(d.id), EXCEL, true)).toBe(true);
  });

  it("a type with no preference is never checked", async () => {
    const d = await fileAs(as.staff, officeId, "pdf", { client_id: c.a, doc_type_id: await typeId(officeId, T.notice) });
    expect(await formatCheck(d.id)).toEqual({ format_preferred: null, format_ok: null });
  });

  it("a client with an exception is never checked", async () => {
    const d = await fileAs(as.staff, officeId, "pdf", { client_id: c.exception, doc_type_id: await bank() });
    expect(await formatCheck(d.id)).toEqual({ format_preferred: null, format_ok: null });
  });

  it("a hard copy with no file is never checked", async () => {
    const d = await mustCreateDocument(as.staff, { client_id: c.a, doc_type_id: await bank(), received_as: "hard_copy" });
    expect(await formatCheck(d.id)).toEqual({ format_preferred: null, format_ok: null });
  });

  it("an Inbox document is unchecked until it is classified, and re-checked when re-classified", async () => {
    const d = await fileAs(as.limited, officeId, "pdf", {});
    expect(await formatCheck(d.id)).toEqual({ format_preferred: null, format_ok: null });
    const r1 = await as.staff.rpc("update_document", { p_id: d.id, p: { client_id: c.a, doc_type_id: await bank() } });
    expect(r1.error).toBeNull();
    expect(same(await formatCheck(d.id), EXCEL, false)).toBe(true);
    const r2 = await as.staff.rpc("update_document", { p_id: d.id, p: { doc_type_id: await typeId(officeId, T.notice) } });
    expect(r2.error).toBeNull();
    expect(await formatCheck(d.id)).toEqual({ format_preferred: null, format_ok: null });
  });

  it("a new version re-checks: a CSV clears the flag, a PDF sets it again (AC-18)", async () => {
    const d = await fileAs(as.staff, officeId, "pdf", { client_id: c.a, doc_type_id: await bank() });
    await addVersionAs(as.staff, officeId, d.id, "csv");
    expect(same(await formatCheck(d.id), EXCEL, true)).toBe(true);
    await addVersionAs(as.staff, officeId, d.id, "pdf");
    expect(same(await formatCheck(d.id), EXCEL, false)).toBe(true);
  });

  it("a .jpeg file counts as jpg", async () => {
    await setPreferred(officeId, T.form16, ["jpg"]);
    try {
      const d = await fileAs(as.staff, officeId, "jpeg", { client_id: c.a, doc_type_id: await typeId(officeId, T.form16) });
      expect(same(await formatCheck(d.id), ["jpg"], true)).toBe(true);
    } finally {
      await setPreferred(officeId, T.form16, null);
    }
  });
});

describe("what doesn't re-check (AC-14, S2)", () => {
  it("review, archive and unarchive keep the stored check", async () => {
    const d = await fileAs(as.staff, officeId, "pdf", { client_id: c.a, doc_type_id: await bank() });
    await mustReview(as.staff, d.id);
    expect(same(await formatCheck(d.id), EXCEL, false)).toBe(true);
    expect((await as.admin.rpc("archive_document", { p_id: d.id, p_reason: "format test" })).error).toBeNull();
    expect((await as.admin.rpc("unarchive_document", { p_id: d.id })).error).toBeNull();
    expect(same(await formatCheck(d.id), EXCEL, false)).toBe(true);
  });

  it("a later preference change or exception doesn't rewrite filed documents", async () => {
    const d = await fileAs(as.staff, officeId, "pdf", { client_id: c.a, doc_type_id: await bank() });
    const row = await planRow(c.a, T.bank);
    await setPreferred(officeId, T.bank, ["pdf"]);
    await as.staff.from("client_doc_type").update({ any_format: true }).eq("id", row.id);
    try {
      expect((await as.staff.rpc("update_document", { p_id: d.id, p: { remark: "touched" } })).error).toBeNull();
      expect(same(await formatCheck(d.id), EXCEL, false)).toBe(true);
    } finally {
      await setPreferred(officeId, T.bank, EXCEL);
      await as.staff.from("client_doc_type").update({ any_format: false }).eq("id", row.id);
    }
  });

  it("05's merge into a type with a preference moves documents without checking them", async () => {
    const proposed = await proposeType(as.staff, c.a, await groupId(officeId, "Banking"), "Formats check merge source");
    const d = await fileAs(as.staff, officeId, "pdf", { client_id: c.a, doc_type_id: proposed });
    expect(await formatCheck(d.id)).toEqual({ format_preferred: null, format_ok: null });
    await mustOk(mergeType(as.admin, proposed, await bank()));
    const { data } = await admin().from("document").select("doc_type_id").eq("id", d.id).single();
    expect(data?.doc_type_id).toBe(await bank());
    expect(await formatCheck(d.id)).toEqual({ format_preferred: null, format_ok: null });
  });
});

describe("nobody can set the check directly (AC-15)", () => {
  it("a direct update is refused for every role", async () => {
    const d = await fileAs(as.staff, officeId, "pdf", { client_id: c.a, doc_type_id: await bank() });
    for (const who of ["admin", "staff", "limited"] as const) {
      const { error } = await as[who].from("document").update({ format_ok: true }).eq("id", d.id);
      expect(error?.message ?? "", who).toMatch(/permission denied|documents change only/i);
    }
  });

  it("update_document ignores the columns", async () => {
    const d = await fileAs(as.staff, officeId, "pdf", { client_id: c.a, doc_type_id: await bank() });
    await as.staff.rpc("update_document", { p_id: d.id, p: { format_ok: true, format_preferred: ["pdf"], remark: "x" } });
    expect(same(await formatCheck(d.id), EXCEL, false)).toBe(true);
  });
});

describe("10's paths (AC-11, AC-14)", () => {
  async function sendLink(items: unknown[]) {
    const token = randomBytes(32).toString("base64url");
    const res = await ok(call("record_link_whatsapp", { p: { client_id: c.a, items, token_hash: sha(token) } }, as.staff));
    const { data: rows } = await admin().from("upload_request_item").select("id").eq("request_id", res.request_id);
    return { hash: sha(token), items: (rows ?? []) as Array<{ id: string }> };
  }
  async function linkUpload(hash: string, item: string, ext: string) {
    const ipHash = ip();
    const t = await ok(call("link_ticket", { p_token_hash: hash, p_item_id: item, p_file: { ext, size: 60 }, p_ip_hash: ipHash }));
    const obj = await uploadAs(t.office_id as string, ext, t.document_id as string);
    return ok(call("link_register", { p_token_hash: hash, p_item_id: item, p_file: { storage_path: obj.path, file_name: `upload.${ext}` }, p_ip_hash: ipHash }));
  }

  it("a client's PDF through the link is flagged; a CSV is not", async () => {
    const link = await sendLink([{ kind: "scheduled", expected_doc_id: (await expectedItem(c.a, T.bank, "2026-04")).id }]);
    const pdf = await linkUpload(link.hash, link.items[0].id, "pdf");
    expect(same(await formatCheck(pdf.document_id as string), EXCEL, false)).toBe(true);
    const csv = await linkUpload(link.hash, link.items[0].id, "csv");
    expect(same(await formatCheck(csv.document_id as string), EXCEL, true)).toBe(true);
  });

  it("every format 10 accepted before is still accepted for an item with a preference", async () => {
    const link = await sendLink([{ kind: "ad_hoc", doc_type_id: await bank() }]);
    for (const ext of ["pdf", "jpg", "jpeg", "png", "heic", "xlsx", "xls", "csv", "docx"]) {
      const r = await call("link_ticket", { p_token_hash: link.hash, p_item_id: link.items[0].id, p_file: { ext, size: 60 }, p_ip_hash: ip() });
      expect(r.error?.message ?? null, ext).toBeNull();
    }
  });

  it("staff Upload for a requested item is checked like any filing", async () => {
    const link = await sendLink([{ kind: "ad_hoc", doc_type_id: await bank() }]);
    const obj = await uploadAs(officeId, "pdf");
    const d = await ok(call("create_document_for_item", { p_item: link.items[0].id, p: {
      client_id: c.a, doc_type_id: await bank(), received_as: "soft_copy", channel: "email",
      file: { storage_path: obj.path, file_name: "statement.pdf" },
    } }, as.staff));
    expect(same(await formatCheck(d.id as string), EXCEL, false)).toBe(true);
  });
});

describe("one rule in TS and SQL (spec: one rule, three mirrors)", () => {
  const lists: string[][] = [["pdf"], ["xlsx"], ["csv"], ["xlsx", "xls"], ["xlsx", "xls", "csv"], ["pdf", "xlsx", "xls", "csv"],
    ["jpg", "png", "heic"], ["docx"], ["pdf", "docx"], ["jpg"], ["pdf", "jpg", "png", "heic", "xlsx", "xls", "csv", "docx"]];
  // Loaded inside the tests so the rest of this file runs (and fails for its own reasons) before formats.ts exists.
  const rule = () => import("../../src/lib/validation/formats");
  it("labels match", async () => {
    const { formatLabel } = await rule();
    for (const l of lists) {
      const { data, error } = await admin().rpc("format_label", { p_formats: l });
      if (error) throw new Error(error.message);
      expect(data, l.join(",")).toBe(formatLabel(l));
    }
  });

  it("formats read from a stored path match", async () => {
    const { normaliseFormat } = await rule();
    for (const ext of ["pdf", "PDF", "jpeg", "jpg", "xlsx", "csv", "heic", "docx", "zip"]) {
      const path = `office/x/doc/y/z.${ext}`;
      const { data, error } = await admin().rpc("format_of_path", { p_path: path });
      if (error) throw new Error(error.message);
      expect(data, ext).toBe(normaliseFormat(ext));
    }
  });

  it("the helpers are service-role only", async () => {
    const r = await as.admin.rpc("format_label", { p_formats: ["pdf"] });
    expect(r.error?.message ?? "").toMatch(/permission denied|not find|does not exist/i);
  });
});
