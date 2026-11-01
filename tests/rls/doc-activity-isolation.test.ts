import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, mustCreateDocument, periodId, typeId } from "../support/documents";
import { T, bankOnlyClient } from "../support/expected";

// Feature 15 (pre-PR review, Important 2) — the guarantees D-5's definer helper rests on, so a later migration can't
// weaken them with every other test green:
//   1. a document of another office returns nothing from activity_feed's document filter or document_last_activity;
//   2. private.doc_activity_ids is not reachable over the API (schema `private` is not exposed).

let a: { id: string; email: string };
let b: { id: string; email: string };
let asA: SupabaseClient;
let asB: SupabaseClient;
let docA: string;

beforeAll(async () => {
  const officeA = await createDocumentOffice("doc-activity-iso-a");
  const officeB = await createDocumentOffice("doc-activity-iso-b");
  a = await createStaff(officeA, "dai-a", "admin");
  b = await createStaff(officeB, "dai-b", "admin");
  asA = await signedInClient(a.email);
  asB = await signedInClient(b.email);
  const client = await bankOnlyClient(asA, officeA, { name: "Isolation client", incharge_id: a.id });
  docA = (await mustCreateDocument(asA, { client_id: client, doc_type_id: await typeId(officeA, T.bank), period_id: await periodId(officeA, "2026-04"), received_on: "2026-05-02" } as never)).id;
});
afterAll(async () => { await retireStaff([a?.id, b?.id].filter(Boolean) as string[]); });

describe("another office's document (D-5)", () => {
  it("its own office sees its events (sanity)", async () => {
    const { data, error } = await asA.rpc("activity_feed", { p: { document_id: docA } });
    expect(error).toBeNull();
    expect((data as { rows: unknown[] }).rows.length).toBeGreaterThan(0);
  });

  it("activity_feed and document_last_activity return nothing to an admin of another office", async () => {
    const feed = await asB.rpc("activity_feed", { p: { document_id: docA } });
    expect(feed.error).toBeNull();
    expect((feed.data as { rows: unknown[]; next: unknown }).rows).toEqual([]);
    expect((feed.data as { next: unknown }).next).toBeNull();
    const last = await asB.rpc("document_last_activity", { p_ids: [docA] });
    expect(last.error).toBeNull();
    expect(last.data).toEqual([]);
  });
});

describe("the IDs-only helper is not an API (D-5)", () => {
  it("private.doc_activity_ids can't be called through PostgREST", async () => {
    const { data, error } = await asA.schema("private").rpc("doc_activity_ids", { p_doc: docA });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });
});
