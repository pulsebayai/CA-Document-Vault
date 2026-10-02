import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createCatalogueOffice, mustInsertClient } from "../support/catalogue";
import {
  activityFor, createDocumentOffice, createSoftCopy, documentRow, mustCreateDocument, mustReview, periodId, reviewHistory,
  typeId, uploadObject,
} from "../support/documents";
import { T, bankOnlyClient, expectedItem, generateAsOf } from "../support/expected";
import { reviewDocuments } from "../support/activity";
import { createFileLink } from "@/lib/documents/storage-core";
import { MAX_LINKS_PER_CALL, MAX_ZIP_FILES, signLinks, zipManifest } from "@/lib/bulk/links-core";

// Feature 08 — bulk zip links and bulk Mark reviewed (spec AC-2 … AC-4, AC-15). Written before the code (plan step 2).
// Contracts: tests/support/activity.ts (review_documents) and src/lib/bulk/links-core.ts:
//   zipManifest(asUser, documentIds) → { ok: true, entries, missing, totalBytes } | { ok: false, error: TOO_MANY|TOO_LARGE }
//       entries: visible documents' current versions { documentId, docCode, versionId, fileName, size, entryName };
//       missing: { documentId, reason: not_found | no_file }. ≤ 100 IDs; ≤ 300 MB of stored sizes (checked in the DB).
//   signLinks(asUser, sign, versionIds) → [{ versionId, url | null }]: ≤ 10 IDs (TOO_MANY), RLS lookup as the user first,
//       current versions only; `sign` is storage.ts's signer (the only module that signs).
//
// Client A: Limited is incharge. Client B: Staff is incharge (Limited can't see it).

type Who = "admin" | "manager" | "staff" | "limited" | "outsider";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
let clientA: string;
let clientB: string;
const t = {} as Record<"bank", string>;
const p = {} as Record<"apr" | "may", string>;

const sign = (path: string, name: string) => createFileLink(adminClient(), path, name, "download");
const filed = async (client = clientA, extra: Record<string, unknown> = {}) =>
  mustCreateDocument(as.staff, { client_id: client, doc_type_id: t.bank, period_id: p.apr, received_on: "2026-05-02", ...extra });
const ids = (r: { id: string }[]) => r.map((x) => x.id);

beforeAll(async () => {
  officeId = await createDocumentOffice("bulk");
  const other = await createCatalogueOffice("bulk-other");
  u.admin = await createStaff(officeId, "bk-admin", "admin");
  u.manager = await createStaff(officeId, "bk-manager", "manager");
  u.staff = await createStaff(officeId, "bk-staff", "staff");
  u.limited = await createStaff(officeId, "bk-limited", "limited");
  u.outsider = await createStaff(other, "bk-outsider", "admin");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  clientA = (await mustInsertClient(as.staff, officeId, { name: "Bulk A", client_type: "individual", incharge_id: u.limited.id })).id;
  clientB = (await mustInsertClient(as.staff, officeId, { name: "Bulk B", client_type: "individual", incharge_id: u.staff.id })).id;
  t.bank = await typeId(officeId, T.bank);
  p.apr = await periodId(officeId, "2026-04");
  p.may = await periodId(officeId, "2026-05");
}, 120_000);

afterAll(async () => {
  await retireStaff([u.manager, u.staff, u.limited].filter(Boolean).map((x) => x.id));
  await retireStaff([u.admin, u.outsider].filter(Boolean).map((x) => x.id));
});

// ── Bulk Mark reviewed (AC-3, AC-4) ──────────────────────────────────────────
describe("review_documents (AC-3)", () => {
  it("reviews each eligible document exactly like a single review, and skips the rest with a reason", async () => {
    const ok1 = await filed();
    const ok2 = await filed(clientB);
    const done = await filed();
    await mustReview(as.staff, done.id);
    const wrong = await filed();
    await mustReview(as.staff, wrong.id, "needs_correction", "Blurred");
    const inbox = await mustCreateDocument(as.staff, { received_on: "2026-05-02" });
    const archived = await filed();
    const { error: ea } = await as.manager.rpc("archive_document", { p_id: archived.id, p_reason: "Duplicate" });
    if (ea) throw new Error(ea.message);
    const ghost = randomUUID();

    const { data, error } = await reviewDocuments(as.staff, [ok1.id, done.id, wrong.id, inbox.id, archived.id, ghost, ok2.id]);
    expect(error).toBeNull();
    expect(data).toEqual([
      { id: ok1.id, result: "reviewed", reason: null },
      { id: done.id, result: "skipped", reason: "already_reviewed" },
      { id: wrong.id, result: "skipped", reason: "needs_correction" },
      { id: inbox.id, result: "skipped", reason: "in_inbox" },
      { id: archived.id, result: "skipped", reason: "archived" },
      { id: ghost, result: "skipped", reason: "not_found" },
      { id: ok2.id, result: "reviewed", reason: null },
    ]);

    for (const d of [ok1, ok2]) {
      const row = await documentRow(d.id);
      expect(row).toMatchObject({ status: "reviewed", reviewed_by: u.staff.id, correction_reason: null });
      expect((await reviewHistory(d.id)).map((h) => [h.outcome, h.actor_id])).toEqual([["reviewed", u.staff.id]]);
      expect((await activityFor(officeId, d.id)).filter((a) => a.action === "document.reviewed")).toHaveLength(1);
    }
    // Skipped documents are untouched.
    expect((await documentRow(done.id)).status).toBe("reviewed");
    expect(await documentRow(wrong.id)).toMatchObject({ status: "needs_correction", correction_reason: "Blurred" });
    expect((await documentRow(inbox.id)).status).toBe("received");
    expect((await documentRow(archived.id)).status).toBe("received");
    expect((await reviewHistory(done.id))).toHaveLength(1);
    expect((await activityFor(officeId, inbox.id)).some((a) => a.action === "document.reviewed")).toBe(false);
  });

  it("returns one entry per distinct ID, in input order", async () => {
    const a = await filed();
    const b = await filed();
    const { data, error } = await reviewDocuments(as.staff, [b.id, a.id, b.id]);
    expect(error).toBeNull();
    expect(data!.map((r) => [r.id, r.result])).toEqual([[b.id, "reviewed"], [a.id, "reviewed"]]);
    expect(await reviewHistory(b.id)).toHaveLength(1);
  });

  it("refuses more than 200 IDs and changes nothing", async () => {
    const d = await filed();
    const many = [d.id, ...Array.from({ length: 200 }, () => randomUUID())];
    const { error } = await reviewDocuments(as.staff, many);
    expect(error ?? "").toMatch(/TOO_MANY/);
    expect((await documentRow(d.id)).status).toBe("received");
  });

  it("an empty list is a no-op", async () => {
    const { data, error } = await reviewDocuments(as.staff, []);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("a linked expected item stays received after a bulk review (07/04 triggers run as for a single review)", async () => {
    await generateAsOf(as.admin, "2026-06-15");
    const client = await bankOnlyClient(as.staff, officeId, { name: "Bulk linked", incharge_id: u.staff.id });
    await generateAsOf(as.admin, "2026-06-15");
    const item = await expectedItem(client, T.bank, "2026-05");
    const d = await mustCreateDocument(as.staff, { client_id: client, doc_type_id: t.bank, period_id: p.may, received_on: "2026-06-02" });
    expect((await documentRow(d.id)).expected_doc_id).toBe(item.id);
    expect((await reviewDocuments(as.staff, [d.id])).data).toEqual([{ id: d.id, result: "reviewed", reason: null }]);
    expect((await documentRow(d.id)).expected_doc_id).toBe(item.id);
    expect((await expectedItem(client, T.bank, "2026-05")).status).toBe("received");
  });
});

describe("review_documents: who (AC-4)", () => {
  it("Limited reviews documents of its own clients; IDs of documents it can't see are 'not found' and unchanged", async () => {
    const mine = await filed(clientA);
    const hidden = await filed(clientB);
    const { data, error } = await reviewDocuments(as.limited, [mine.id, hidden.id]);
    expect(error).toBeNull();
    expect(data).toEqual([
      { id: mine.id, result: "reviewed", reason: null },
      { id: hidden.id, result: "skipped", reason: "not_found" },
    ]);
    expect((await documentRow(mine.id)).reviewed_by).toBe(u.limited.id);
    expect((await documentRow(hidden.id)).status).toBe("received");
  });

  it("another office's user changes nothing", async () => {
    const d = await filed();
    const { data } = await reviewDocuments(as.outsider, [d.id]);
    expect(data).toEqual([{ id: d.id, result: "skipped", reason: "not_found" }]);
    expect((await documentRow(d.id)).status).toBe("received");
  });
});

// ── Zip links (AC-2) ─────────────────────────────────────────────────────────
describe("zipManifest (AC-2)", () => {
  it("lists visible documents' current files with '<DOC-ID> <file name>' entries; others are missing with a reason", async () => {
    const soft = await createSoftCopy(as.staff, officeId, { client_id: clientA, doc_type_id: t.bank, period_id: p.apr, received_on: "2026-05-02" });
    const hard = await filed();
    const ghost = randomUUID();
    const m = await zipManifest(as.staff, [soft.id, hard.id, ghost]);
    if (!m.ok) throw new Error(m.error);
    expect(m.entries).toEqual([expect.objectContaining({
      documentId: soft.id, docCode: soft.doc_code, fileName: "statement.pdf", size: soft.object.size,
      entryName: `${soft.doc_code} statement.pdf`,
    })]);
    expect(m.missing).toEqual([{ documentId: hard.id, reason: "no_file" }, { documentId: ghost, reason: "not_found" }]);
    expect(m.totalBytes).toBe(soft.object.size);
  });

  it("Limited gets only documents it can see (its own Inbox included); others are not found", async () => {
    const hidden = await createSoftCopy(as.staff, officeId, { client_id: clientB, doc_type_id: t.bank, period_id: p.apr, received_on: "2026-05-02" });
    const ownInbox = await createSoftCopy(as.limited, officeId, { received_on: "2026-05-02" });
    const m = await zipManifest(as.limited, [hidden.id, ownInbox.id]);
    if (!m.ok) throw new Error(m.error);
    expect(m.entries.map((e) => e.documentId)).toEqual([ownInbox.id]);
    expect(m.missing).toEqual([{ documentId: hidden.id, reason: "not_found" }]);
  });

  it("archived documents the user can see are included (same as a single download)", async () => {
    const soft = await createSoftCopy(as.staff, officeId, { client_id: clientA, doc_type_id: t.bank, period_id: p.apr, received_on: "2026-05-02" });
    const { error } = await as.admin.rpc("archive_document", { p_id: soft.id, p_reason: "Old" });
    if (error) throw new Error(error.message);
    const m = await zipManifest(as.staff, [soft.id]);
    expect(m.ok && m.entries.map((e) => e.documentId)).toEqual([soft.id]);
  });

  it(`refuses more than ${MAX_ZIP_FILES} documents`, async () => {
    const m = await zipManifest(as.staff, Array.from({ length: MAX_ZIP_FILES + 1 }, () => randomUUID()));
    expect(m).toEqual({ ok: false, error: "TOO_MANY" });
  });
});

describe("signLinks (AC-2)", () => {
  it("signs ≤ 60 s download links for current versions the user can see; the bytes match", async () => {
    const soft = await createSoftCopy(as.staff, officeId, { client_id: clientA, doc_type_id: t.bank, period_id: p.apr, received_on: "2026-05-02" });
    const m = await zipManifest(as.limited, [soft.id]);
    if (!m.ok) throw new Error(m.error);
    const [link] = await signLinks(as.limited, sign, [m.entries[0].versionId]);
    expect(link.versionId).toBe(m.entries[0].versionId);
    const token = new URL(link.url!).searchParams.get("token")!;
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(60);
    const res = await fetch(link.url!);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).length).toBe(soft.object.size);
  });

  it("returns no link for versions the user can't see or that aren't current", async () => {
    const hidden = await createSoftCopy(as.staff, officeId, { client_id: clientB, doc_type_id: t.bank, period_id: p.apr, received_on: "2026-05-02" });
    const hm = await zipManifest(as.staff, [hidden.id]);
    if (!hm.ok) throw new Error(hm.error);
    const old = hm.entries[0].versionId;
    const obj = await uploadObject(officeId, "pdf", hidden.id);
    const { error } = await as.staff.rpc("add_document_version", { p_document_id: hidden.id, p_file: { storage_path: obj.path, file_name: "v2.pdf" } });
    if (error) throw new Error(error.message);
    expect(await signLinks(as.staff, sign, [old])).toEqual([{ versionId: old, url: null }]);
    const current = (await documentRow(hidden.id)).current_version_id!;
    expect((await signLinks(as.limited, sign, [current]))[0].url).toBeNull();
    expect((await signLinks(as.outsider, sign, [current]))[0].url).toBeNull();
    expect((await signLinks(as.staff, sign, [current]))[0].url).toMatch(/^https:/);
  });

  it(`refuses more than ${MAX_LINKS_PER_CALL} versions per call`, async () => {
    await expect(signLinks(as.staff, sign, Array.from({ length: MAX_LINKS_PER_CALL + 1 }, () => randomUUID()))).rejects.toThrow(/TOO_MANY/);
  });
});

// ── Speed (AC-15) — nightly only: seeding 200 documents takes ~1 min against dev ──────────────────────────────────
describe.skipIf(!process.env.RUN_SLOW)("bulk review at chunk size (nightly)", () => {
  it("marks 200 documents reviewed in one call in < 5 s", async () => {
    const docs: string[] = [];
    for (let i = 0; i < 200; i += 10) {
      docs.push(...ids(await Promise.all(Array.from({ length: 10 }, () => filed()))));
    }
    const t0 = performance.now();
    const { data, error } = await reviewDocuments(as.staff, docs);
    const ms = performance.now() - t0;
    expect(error).toBeNull();
    expect(data!.every((r) => r.result === "reviewed")).toBe(true);
    expect(ms).toBeLessThan(5000);
  }, 300_000);
});
