import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, signedInClient } from "./db";
import { resetTestOffice } from "./catalogue";
import { mustCreateDocument, periodId, typeId } from "./documents";
import { T } from "./expected";

// Feature 15 (spec U6) — the K4 office: one persistent test office with ≈ 200k activity rows, shared by every lane
// and by local runs (like 09's volume office), so dev grows by 200k rows once, not per run. It is never reset after
// its first set-up (reset_test_office would not delete activity anyway); it is topped up only when below the target.
// On CI's throwaway local stack it is built fresh each run (≈ 10 seed calls).
//
// Source rows for the seed are varied on purpose: seed_test_activity copies the office's own rows, so ≈ 5,000
// synthetic source rows over ≈ 4,000 entity IDs (+ dispatch and requested-item references) spread the 200k copies at
// ≈ 40–50 per entity (5k rows per seed call: 20k and 10k hit the 8 s statement limit on dev at ≈ 165k, 2026-11-01; the seed reads the whole office each call), instead of piling tens of thousands onto the few real documents. The documents the tests
// measure are created after seeding and keep a small, realistic history.

export const K4_OFFICE = "e2e office k4";
export const K4_TARGET = 200_000;
export const k4Email = (role: "admin" | "staff" | "limited") => `e2e-k4-${role}@example.test`;

type U = { id: string; email: string };
export type K4Ctx = {
  officeId: string;
  u: Record<"admin" | "staff" | "limited", U>;
  as: Record<"admin" | "staff" | "limited", SupabaseClient>;
  clientId: string; // Limited is its incharge
  documentId: string; // a real document of that client with a small history
  pageIds: string[]; // 20 real documents of that client (Last activity for a page)
  seeded: { ms: number; calls: number } | null;
};

async function getOrCreateOffice(): Promise<{ id: string; fresh: boolean }> {
  const admin = adminClient();
  const { data: found } = await admin.from("office").select("id").eq("name", K4_OFFICE).maybeSingle();
  if (found) {
    const { count } = await admin.from("doc_group").select("id", { count: "exact", head: true }).eq("office_id", found.id);
    return { id: found.id as string, fresh: (count ?? 0) === 0 };
  }
  const { data, error } = await admin.from("office").insert({ name: K4_OFFICE, branch: "test", is_test: true }).select("id").single();
  if (error) throw error;
  return { id: data.id as string, fresh: true };
}

export async function activityCount(officeId: string): Promise<number> {
  const { count, error } = await adminClient().from("activity").select("id", { count: "exact", head: true }).eq("office_id", officeId);
  if (error) throw error;
  return count ?? 0;
}

/** Get the K4 office ready: users, one client, 20 documents, ≥ 200k activity rows. */
export async function k4Office(): Promise<K4Ctx> {
  const office = await getOrCreateOffice();
  if (office.fresh) await resetTestOffice(office.id); // seeds the catalogue once
  const u = {
    admin: await createStaff(office.id, "k4-admin", "admin", "active", k4Email("admin")),
    staff: await createStaff(office.id, "k4-staff", "staff", "active", k4Email("staff")),
    limited: await createStaff(office.id, "k4-limited", "limited", "active", k4Email("limited")),
  };
  const as = { admin: await signedInClient(u.admin.email), staff: await signedInClient(u.staff.email), limited: await signedInClient(u.limited.email) };
  const admin = adminClient();

  // One client the Limited user can see (incharge), with 20 documents.
  let { data: client } = await admin.from("client").select("id").eq("office_id", office.id).eq("name", "K4 client").maybeSingle();
  if (!client) {
    const { data, error } = await as.staff.from("client").insert({ office_id: office.id, name: "K4 client", client_type: "individual", incharge_id: u.limited.id })
      .select("id").single();
    if (error) throw error;
    client = data;
  }
  const clientId = client!.id as string;
  const { data: docs } = await admin.from("document").select("id").eq("client_id", clientId).order("created_at").limit(20);
  const pageIds = (docs ?? []).map((d) => d.id as string);
  if (pageIds.length < 20) {
    const bank = await typeId(office.id, T.bank);
    const apr = await periodId(office.id, "2026-04");
    for (let i = pageIds.length; i < 20; i++) {
      const d = await mustCreateDocument(as.staff, { client_id: clientId, doc_type_id: bank, period_id: apr, received_on: "2026-05-02", received_as: "hard_copy" } as never);
      pageIds.push(d.id);
    }
  }

  // Seed to the target (top up only).
  let seeded: K4Ctx["seeded"] = null;
  let n = await activityCount(office.id);
  if (n < K4_TARGET) {
    const t0 = performance.now();
    if (n < 5_000) {
      const rows = Array.from({ length: 5_000 }, (_, i) => {
        if (i % 100 === 0) return { office_id: office.id, actor_id: u.staff.id, action: "dispatch.created", entity_type: "dispatch", entity_id: randomUUID(),
          data: { client_id: clientId, document_ids: [randomUUID(), randomUUID()], method: "courier" } };
        if (i % 100 === 1) return { office_id: office.id, actor_id: u.staff.id, action: "upload_request_item.filed", entity_type: "upload_request_item", entity_id: randomUUID(),
          data: { client_id: clientId, document_id: randomUUID() } };
        return { office_id: office.id, actor_id: u.staff.id, action: "document.updated", entity_type: "document", entity_id: randomUUID(),
          data: { client_id: clientId, fields: ["remark"] } };
      });
      for (let i = 0; i < rows.length; i += 1_000) {
        const { error } = await admin.from("activity").insert(rows.slice(i, i + 1_000));
        if (error) throw error;
      }
    }
    let calls = 0;
    const to = new Date();
    const from = new Date(to.getTime() - 365 * 86_400_000);
    while ((n = await activityCount(office.id)) < K4_TARGET) {
      const { error } = await as.admin.rpc("seed_test_activity", { p_count: Math.min(5_000, K4_TARGET - n), p_from: from.toISOString(), p_to: to.toISOString() });
      if (error) throw new Error(`seed_test_activity: ${error.message}`);
      calls++;
    }
    seeded = { ms: Math.round(performance.now() - t0), calls };
  }
  return { officeId: office.id, u, as, clientId, documentId: pageIds[0], pageIds, seeded };
}

/** Median of `runs` warm calls (one unmeasured warm-up), as 02's clients-list timing. */
export async function medianMs(fn: () => Promise<unknown>, runs = 5): Promise<number> {
  await fn();
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    t.push(performance.now() - t0);
  }
  return t.sort((a, b) => a - b)[Math.floor(runs / 2)];
}
