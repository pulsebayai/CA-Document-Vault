import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, createSoftCopy, mustReview, typeId, uploadObject } from "../support/documents";
import { T, bankOnlyClient, expectedItem, generateAsOf, mustRpc } from "../support/expected";

// Feature 10 step 12 — Settings › Collection link figures (spec AC-23), written before migration I.
// Fixture (4 filed documents): link upload A (scheduled item) Reviewed; link upload B (ad-hoc item) Needs correction,
// which reopens the item; link upload C received for the same item; one document filed by staff (not by link).
// Documents are dated by the real IST day (03), so the window is wide and the needed-by date is late in 2026.

type Who = "admin" | "staff";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ip = () => sha(`ip-metric-${Date.now()}-${Math.random()}`);
const WIDE = { p_from: "2026-01-01", p_to: "2026-12-31" };
type Metric = Record<string, number | null>;

async function linkUpload(hash: string, item: string) {
  const t = await mustRpc<{ office_id: string; document_id: string }>(adminClient(), "link_ticket",
    { p_token_hash: hash, p_item_id: item, p_file: { ext: "pdf", size: 60 }, p_ip_hash: ip() });
  const obj = await uploadObject(t.office_id, "pdf", t.document_id);
  return (await mustRpc<{ document_id: string }>(adminClient(), "link_register",
    { p_token_hash: hash, p_item_id: item, p_file: { storage_path: obj.path, file_name: "x.pdf" }, p_ip_hash: ip() })).document_id;
}

beforeAll(async () => {
  officeId = await createDocumentOffice("upload-metrics");
  u.admin = await createStaff(officeId, "umx-admin", "admin");
  u.staff = await createStaff(officeId, "umx-staff", "staff");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  await generateAsOf(as.admin, "2026-03-10");
  const client = await bankOnlyClient(as.staff, officeId, { name: "Metric Client", incharge_id: u.staff.id, email: "umx@example.test", mobile: "9876541401" });
  await generateAsOf(as.admin, "2026-05-15");
  const notice = await typeId(officeId, T.notice);
  const token = randomBytes(32).toString("base64url");
  const { data, error } = await as.staff.rpc("record_link_whatsapp", { p: { client_id: client, token_hash: sha(token), items: [
    { kind: "scheduled", expected_doc_id: (await expectedItem(client, T.bank, "2026-03")).id },
    { kind: "ad_hoc", doc_type_id: notice, needed_by: "2026-12-31" },
  ] } });
  if (error) throw new Error(error.message);
  const { data: rows } = await adminClient().from("upload_request_item").select("id, kind").eq("request_id", (data as { request_id: string }).request_id);
  const sched = (rows as Array<{ id: string; kind: string }>).find((r) => r.kind === "scheduled")!.id;
  const adhoc = (rows as Array<{ id: string; kind: string }>).find((r) => r.kind === "ad_hoc")!.id;
  const a = await linkUpload(sha(token), sched);
  await mustReview(as.staff, a, "reviewed");
  const b = await linkUpload(sha(token), adhoc);
  await mustReview(as.staff, b, "needs_correction", "wrong year");
  await linkUpload(sha(token), adhoc); // C: the item is received again
  await createSoftCopy(as.staff, officeId, { client_id: client, doc_type_id: notice }); // staff-filed, not by link
}, 300_000);

afterAll(async () => { await retireStaff(Object.values(u).map((x) => x.id)); });

describe("link_metric (AC-23)", () => {
  it("share via links, review time, needs-correction share and ad-hoc turnaround", async () => {
    const m = await mustRpc<Metric>(as.admin, "link_metric", WIDE);
    expect(m).toMatchObject({ documents: 4, via_link: 3, link_pct: 75, reviewed: 2, needs_fix: 1, needs_fix_pct: 33.3,
      adhoc_received: 1, adhoc_with_date: 1, adhoc_on_time: 1, adhoc_on_time_pct: 100 });
    expect(m.review_median_hours).toBeGreaterThanOrEqual(0);
    expect(m.review_median_hours).toBeLessThan(1);
    expect(m.adhoc_median_days).toBeGreaterThanOrEqual(0);
  });

  it("a window with nothing gives zero counts and no percentages", async () => {
    expect(await mustRpc<Metric>(as.admin, "link_metric", { p_from: "2020-01-01", p_to: "2020-01-31" }))
      .toMatchObject({ documents: 0, via_link: 0, link_pct: null, needs_fix_pct: null, adhoc_received: 0, adhoc_on_time_pct: null });
  });

  it("Admin/Manager only", async () => {
    const r = await as.staff.rpc("link_metric", WIDE);
    expect(r.error?.message).toMatch(/ROLE_REQUIRED/);
  });
});
