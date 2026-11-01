import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, mustCreateDocument, periodId, typeId } from "../support/documents";
import { T, bankOnlyClient } from "../support/expected";
import { insertActivity, mustFeed } from "../support/activity";

// Feature 15 (spec AC-5, AC-6, AC-9, U2) — `document_last_activity(p_ids uuid[]) → jsonb`: for each document, the
// latest activity row the viewer may see (the first row `activity_feed` would show for that document), or nothing.
// Contract: an array of { document_id, id, at, action, entity_type, data, actor_id, actor_name } (documents with no
// visible event are absent); ≤ 50 IDs (TOO_MANY); invoker, office first; IDs the viewer can't see return nothing.

type Who = "staff" | "limited";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
let clientA: string, clientB: string, docA: string, docA2: string, docB: string, quiet: string;
type Last = { document_id: string; id: number; at: string; action: string; entity_type: string; data: Record<string, unknown>; actor_id: string | null; actor_name: string | null };

const last = async (who: SupabaseClient, ids: string[]) => {
  const { data, error } = await who.rpc("document_last_activity", { p_ids: ids });
  if (error) throw new Error(error.message);
  return data as Last[];
};
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

beforeAll(async () => {
  officeId = await createDocumentOffice("doc-last-activity");
  u.staff = await createStaff(officeId, "dla-staff", "staff");
  u.limited = await createStaff(officeId, "dla-limited", "limited");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);
  clientA = await bankOnlyClient(as.staff, officeId, { name: "Last activity A", incharge_id: u.limited.id });
  clientB = await bankOnlyClient(as.staff, officeId, { name: "Last activity B", incharge_id: u.staff.id });
  const bank = await typeId(officeId, T.bank);
  const apr = await periodId(officeId, "2026-04");
  const mk = async (c: string) => (await mustCreateDocument(as.staff, { client_id: c, doc_type_id: bank, period_id: apr, received_on: "2026-05-02" } as never)).id;
  docA = await mk(clientA);
  docA2 = await mk(clientA);
  docB = await mk(clientB);
  quiet = randomUUID(); // no events at all
  await insertActivity(officeId, [
    { actor_id: u.staff.id, action: "dispatch.created", entity_type: "dispatch", entity_id: randomUUID(), data: { client_id: clientA, document_ids: [docA2], method: "courier" }, created_at: at(-1) }, // docA2's latest: a packet
    // docA's newest row is about client B (Limited can't see it); the one before is visible to both.
    { actor_id: u.staff.id, action: "document.updated", entity_type: "document", entity_id: docA, data: { client_id: clientA, fields: ["remark"] }, created_at: at(-2) },
    { actor_id: u.staff.id, action: "upload_request_item.filed", entity_type: "upload_request_item", entity_id: randomUUID(), data: { client_id: clientB, document_id: docA }, created_at: at(-3) },
  ]);
}, 120_000);

afterAll(async () => {
  await retireStaff(Object.values(u).filter(Boolean).map((x) => x.id));
});

describe("document_last_activity (AC-5, AC-9)", () => {
  it("returns, per document, exactly the first row activity_feed shows for it (Staff and Limited)", async () => {
    for (const who of ["staff", "limited"] as Who[]) {
      const rows = await last(as[who], [docA, docA2, docB, quiet]);
      const byDoc = new Map(rows.map((r) => [r.document_id, r]));
      for (const d of [docA, docA2, docB, quiet]) {
        const first = (await mustFeed(as[who], { document_id: d, limit: 1 })).rows[0];
        if (!first) expect(byDoc.has(d), `${who} ${d}`).toBe(false);
        else expect(byDoc.get(d), `${who} ${d}`).toMatchObject({ id: first.id, action: first.action, actor_name: first.actor_name, entity_type: first.entity_type });
      }
    }
  });

  it("each kind of reference counts: docA2's latest is the dispatch packet; docA's differs by role", async () => {
    const staff = new Map((await last(as.staff, [docA, docA2])).map((r) => [r.document_id, r]));
    expect(staff.get(docA2)?.action).toBe("dispatch.created");
    expect(staff.get(docA)?.action).toBe("upload_request_item.filed");
    const limited = new Map((await last(as.limited, [docA, docB])).map((r) => [r.document_id, r]));
    expect(limited.get(docA)?.action).toBe("document.updated");
    expect(limited.has(docB)).toBe(false); // client B: nothing for Limited
  });

  it("an empty list returns []; more than 50 IDs is refused; actor names come under RLS", async () => {
    expect(await last(as.staff, [])).toEqual([]);
    const { error } = await as.staff.rpc("document_last_activity", { p_ids: Array.from({ length: 51 }, () => randomUUID()) });
    expect(error?.message ?? "").toMatch(/TOO_MANY/);
    const r = (await last(as.staff, [docA2]))[0];
    expect(r.actor_name).toBe("Test dla-staff");
  });
});
