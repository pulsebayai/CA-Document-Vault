import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, periodId, typeId } from "../support/documents";
import { CLIENT_DOCUMENTS_SELECT, INBOX_SELECT } from "@/lib/documents/selects";

// Feature 03 spec NFR (performance): Client › Documents with 500 documents and the Inbox with 200 items load
// in < 1 s. Nightly only (RUN_SLOW=1 in regression.yml): seeding 700 documents takes ~1 min against dev.
// Timed as round trips from the runner (US) to dev (Mumbai), best of 3 — the same queries the app runs.

describe.skipIf(!process.env.RUN_SLOW)("document lists at volume (nightly)", () => {
  let staff: { id: string; email: string };
  let as: SupabaseClient;
  let clientId: string;

  beforeAll(async () => {
    const officeId = await createDocumentOffice("docs-perf");
    staff = await createStaff(officeId, "docs-perf-staff", "staff");
    as = await signedInClient(staff.email);
    const { data, error } = await as.rpc("create_client", { p: { name: "Volume client", client_type: "individual", incharge_id: staff.id } });
    if (error) throw error;
    clientId = data.id;
    // Every type below accepts a financial-year period (month-types take month/quarter/year; Form 16 is yearly).
    const types = await Promise.all(["Form 16 from employer", "Sales invoices / sales register", "Bank statement"].map((n) => typeId(officeId, n)));
    const periods = await Promise.all(["2025-26", "2026-27"].map((c) => periodId(officeId, c)));
    const jobs: Array<Record<string, unknown>> = [
      ...Array.from({ length: 500 }, (_, i) => ({
        received_as: "hard_copy", channel: "courier", client_id: clientId, doc_type_id: types[i % 3], period_id: periods[i % 2],
      })),
      ...Array.from({ length: 200 }, (_, i) => ({ received_as: "hard_copy", channel: "whatsapp", remark: `Inbox item ${i}` })),
    ];
    for (let i = 0; i < jobs.length; i += 20) {
      const results = await Promise.all(jobs.slice(i, i + 20).map((p) => as.rpc("create_document", { p })));
      const failed = results.find((r) => r.error);
      if (failed) throw new Error(failed.error!.message);
    }
  }, 300_000);

  afterAll(async () => { if (staff) await retireStaff([staff.id]); });

  const bestOf3 = async (run: () => PromiseLike<{ data: unknown[] | null; error: unknown }>) => {
    let best = Infinity; let rows = 0;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const { data, error } = await run();
      best = Math.min(best, performance.now() - t0);
      expect(error).toBeNull();
      rows = data?.length ?? 0;
    }
    return { best, rows };
  };

  it("Client › Documents: 500 documents in < 1 s", async () => {
    const r = await bestOf3(() => as.from("document").select(CLIENT_DOCUMENTS_SELECT)
      .eq("client_id", clientId).not("classified_at", "is", null).is("archived_at", null)
      .order("received_on", { ascending: false }).limit(2000));
    console.log("client documents (ms)", Math.round(r.best), "rows", r.rows);
    expect(r.rows).toBe(500);
    expect(r.best).toBeLessThan(1000);
  });

  it("Inbox: 200 items in < 1 s", async () => {
    const r = await bestOf3(() => as.from("document").select(INBOX_SELECT)
      .is("classified_at", null).is("archived_at", null).order("created_at", { ascending: false }).limit(200));
    console.log("inbox (ms)", Math.round(r.best), "rows", r.rows);
    expect(r.rows).toBe(200);
    expect(r.best).toBeLessThan(1000);
  });
});
