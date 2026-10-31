import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import {
  createDocumentOffice, mustCreateDocument, mustDispatch, mustMarkReady, mustReview, mustSetCustody, periodId, typeId,
} from "../support/documents";
import { T, bankOnlyClient } from "../support/expected";

// Feature 13 — custody_metric(p_from date, p_to date) (spec AC-18; success metrics 1 and 2). Written before migration B.
// Contract (SECURITY INVOKER, Admin/Manager only → ROLE_REQUIRED otherwise):
//   { reviewed: N hard copies whose latest review decision falls in [from, to] (office dates),
//     placed_2d: of those, marked in office (by a person, not implied or migrated) within 2 working days (Mon–Fri) of review,
//     ready_to_dispatched_median_days: median office days from Ready (by a person) to a dispatch in range, null if none,
//     held_now: returnable documents in office > 30 days now }.
// Migrated rows (in_office_by null) and implied steps never count in the timing figures.

type Who = "manager" | "staff";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
const istToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
type Metric = { reviewed: number; placed_2d: number; ready_to_dispatched_median_days: number | null; held_now: number };

beforeAll(async () => {
  officeId = await createDocumentOffice("custody-metric");
  u.manager = await createStaff(officeId, "cmt-manager", "manager");
  u.staff = await createStaff(officeId, "cmt-staff", "staff");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  const client = await bankOnlyClient(as.staff, officeId, { name: "Metric client", incharge_id: u.staff.id });
  const base = { client_id: client, doc_type_id: await typeId(officeId, T.bank), period_id: await periodId(officeId, "2026-04"),
    received_as: "hard_copy" as const };
  const mk = async (extra: Record<string, unknown> = {}) => (await mustCreateDocument(as.staff, { ...base, ...extra } as never)).id;
  const placed = await mk(); await mustReview(as.staff, placed); await mustSetCustody(as.staff, [placed], "in_office");
  const notPlaced = await mk(); await mustReview(as.staff, notPlaced);
  const sent = await mk({ returnable: true }); await mustReview(as.staff, sent); await mustMarkReady(as.staff, sent);
  await mustDispatch(as.staff, { client_id: client, document_ids: [sent], dispatched_on: istToday() });
  const implied = await mk({ returnable: true }); await mustReview(as.staff, implied); // dispatched without the clicks (S2)
  await mustDispatch(as.staff, { client_id: client, document_ids: [implied], dispatched_on: istToday() });
  await mk(); // To review: not counted
  await mustCreateDocument(as.staff, { ...base, received_as: "hard_copy", doc_type_id: null }); // Untagged: not counted
}, 120_000);

afterAll(async () => {
  await retireStaff([u.manager, u.staff].filter(Boolean).map((x) => x.id));
});

describe("custody_metric (AC-18)", () => {
  it("is Admin/Manager only", async () => {
    expect((await as.staff.rpc("custody_metric", { p_from: istToday(), p_to: istToday() })).error?.message ?? "").toMatch(/ROLE_REQUIRED/);
  });

  it("counts placements within 2 working days and the median days Ready → Dispatched; implied steps don't count as placed", async () => {
    const { data, error } = await as.manager.rpc("custody_metric", { p_from: istToday(), p_to: istToday() });
    expect(error).toBeNull();
    expect(data as Metric).toEqual({ reviewed: 4, placed_2d: 2, ready_to_dispatched_median_days: 0, held_now: 0 });
  });

  it("a range with nothing in it returns zeros and a null median", async () => {
    const { data } = await as.manager.rpc("custody_metric", { p_from: "2020-01-01", p_to: "2020-01-31" });
    expect(data as Metric).toEqual({ reviewed: 0, placed_2d: 0, ready_to_dispatched_median_days: null, held_now: 0 });
  });
});
