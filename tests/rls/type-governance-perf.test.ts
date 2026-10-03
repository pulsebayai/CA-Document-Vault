import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { groupId, mergeType, mustInsertClient, proposalQueue, proposeType } from "../support/catalogue";
import { createDocumentOffice, periodId, typeId } from "../support/documents";
import { T, generateAsOf } from "../support/expected";

// Feature 05 spec AC-17: merging an item with 1,000 documents finishes in < 3 s on dev (2 s until 2026-10-03, spec change). RUN_SLOW only (nightly and
// before merge): seeding 1,000 documents takes ~1–2 min against dev. The documents have a June period and the target
// (Bank statement) is in the client's plan with a June item, so 04's linking trigger fires for every moved row —
// the cost the plan measures (fallback: deferred set-based relink). Timed as one round trip from the runner.
// Seeding files 4 documents at a time: every filing in an office queues on 03's DOC-ID counter row, so 20 at once
// let one slow transaction push the back of the queue past the 8 s statement timeout (Regression 37046419999).

const SEED_AT_ONCE = 4;

describe.skipIf(!process.env.RUN_SLOW)("merge at volume (AC-17)", () => {
  const who = {} as Record<"admin" | "staff", { id: string; email: string }>;
  const as = {} as Record<"admin" | "staff", SupabaseClient>;
  let proposed: string;
  let bank: string;

  beforeAll(async () => {
    const officeId = await createDocumentOffice("governance-perf");
    who.admin = await createStaff(officeId, "govp-admin", "admin");
    who.staff = await createStaff(officeId, "govp-staff", "staff");
    as.admin = await signedInClient(who.admin.email);
    as.staff = await signedInClient(who.staff.email);
    await generateAsOf(as.admin, "2026-07-01");
    const banking = await groupId(officeId, "Banking");
    bank = await typeId(officeId, T.bank);
    const jun = await periodId(officeId, "2026-06");
    const clients: string[] = [];
    for (let i = 0; i < 2; i++) {
      const c = (await mustInsertClient(as.staff, officeId, { name: `Merge volume ${i}`, client_type: "individual", incharge_id: who.staff.id })).id;
      clients.push(c);
    }
    const { error: ge } = await as.staff.rpc("enable_client_group", { p_client_id: clients[0], p_doc_group_id: banking });
    if (ge) throw new Error(ge.message);
    proposed = await proposeType(as.staff, clients[0], banking, "Bulk bank slips");
    const second = await proposeType(as.staff, clients[1], banking, "Bulk bank slips");
    const jobs = Array.from({ length: 1000 }, (_, i) => ({
      received_as: "hard_copy", channel: "courier", client_id: clients[i % 2], doc_type_id: i % 2 ? second : proposed, period_id: jun,
    }));
    for (let i = 0; i < jobs.length; i += SEED_AT_ONCE) {
      const results = await Promise.all(jobs.slice(i, i + SEED_AT_ONCE).map((p) => as.staff.rpc("create_document", { p })));
      const failed = results.find((r) => r.error);
      if (failed) throw new Error(failed.error!.message);
    }
  }, 600_000);

  afterAll(async () => { await retireStaff([who.staff, who.admin].filter(Boolean).map((x) => x.id)); });

  it("1,000 documents on 2 clients move in < 3 s", async () => {
    const t0 = performance.now();
    const { data, error } = await mergeType(as.admin, proposed, bank);
    const ms = performance.now() - t0;
    console.log("merge 1,000 documents (ms)", Math.round(ms));
    expect(error).toBeNull();
    expect(data).toMatchObject({ documents: 1000, clients: 2 });
    const { count } = await adminClient().from("document").select("id", { count: "exact", head: true }).eq("doc_type_id", bank);
    expect(count).toBe(1000);
    expect(ms).toBeLessThan(3000);
  });
});

// Spec AC-17 (second bullet; review I-6): the decision queue loads in < 1 s with 50 items. One round trip, best of 3
// (like 02's clients-list timing). RUN_SLOW only, with the merge above.
describe.skipIf(!process.env.RUN_SLOW)("queue at volume (AC-17)", () => {
  let admin: { id: string; email: string };
  let staff: { id: string; email: string };
  let asAdmin: SupabaseClient;

  beforeAll(async () => {
    const officeId = await createDocumentOffice("governance-queue");
    admin = await createStaff(officeId, "govq-admin", "admin");
    staff = await createStaff(officeId, "govq-staff", "staff");
    asAdmin = await signedInClient(admin.email);
    const asStaff = await signedInClient(staff.email);
    const groups = await Promise.all(["Banking", "Other", "Accounting", "Payroll", "GST"].map((g) => groupId(officeId, g)));
    const clients: string[] = [];
    for (let i = 0; i < 5; i++) {
      clients.push((await mustInsertClient(asStaff, officeId, { name: `Queue volume ${i}`, client_type: "individual", incharge_id: staff.id })).id);
    }
    // 50 items: 10 names × 5 groups, each proposed by 2 clients (100 rows), so grouping does real work.
    for (let n = 0; n < 10; n++) {
      for (const [gi, grp] of groups.entries()) {
        for (const c of [clients[(n + gi) % 5], clients[(n + gi + 1) % 5]]) await proposeType(asStaff, c, grp, `Queue type ${n}`);
      }
    }
  }, 600_000);

  afterAll(async () => { await retireStaff([staff, admin].filter(Boolean).map((x) => x.id)); });

  it("50 items in < 1 s", async () => {
    const times: number[] = [];
    let waiting = 0;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const { data, error } = await proposalQueue(asAdmin);
      times.push(performance.now() - t0);
      expect(error).toBeNull();
      waiting = data!.waiting;
    }
    console.log("proposal_queue 50 items (ms)", times.map(Math.round));
    expect(waiting).toBe(50);
    expect(Math.min(...times)).toBeLessThan(1000);
  });
});
