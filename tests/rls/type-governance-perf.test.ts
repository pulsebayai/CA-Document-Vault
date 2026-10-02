import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { groupId, mergeType, mustInsertClient, proposeType } from "../support/catalogue";
import { createDocumentOffice, periodId, typeId } from "../support/documents";
import { T, generateAsOf } from "../support/expected";

// Feature 05 spec AC-17: merging an item with 1,000 documents finishes in < 2 s on dev. RUN_SLOW only (nightly and
// before merge): seeding 1,000 documents takes ~1–2 min against dev. The documents have a June period and the target
// (Bank statement) is in the client's plan with a June item, so 04's linking trigger fires for every moved row —
// the cost the plan measures (fallback: deferred set-based relink). Timed as one round trip from the runner.

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
    for (let i = 0; i < jobs.length; i += 20) {
      const results = await Promise.all(jobs.slice(i, i + 20).map((p) => as.staff.rpc("create_document", { p })));
      const failed = results.find((r) => r.error);
      if (failed) throw new Error(failed.error!.message);
    }
  }, 600_000);

  afterAll(async () => { await retireStaff([who.staff, who.admin].filter(Boolean).map((x) => x.id)); });

  it("1,000 documents on 2 clients move in < 2 s", async () => {
    const t0 = performance.now();
    const { data, error } = await mergeType(as.admin, proposed, bank);
    const ms = performance.now() - t0;
    console.log("merge 1,000 documents (ms)", Math.round(ms));
    expect(error).toBeNull();
    expect(data).toMatchObject({ documents: 1000, clients: 2 });
    const { count } = await adminClient().from("document").select("id", { count: "exact", head: true }).eq("doc_type_id", bank);
    expect(count).toBe(1000);
    expect(ms).toBeLessThan(2000);
  });
});
