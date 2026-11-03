import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, createStaff, retireStaff } from "../support/db";
import { createDocumentOffice } from "../support/documents";
import { resetTestOffice } from "../support/catalogue";

// chore test-office-activity-purge (Sidambara 2026-11-03): reset_test_office also deletes the reset office's activity,
// so dev stops accumulating test activity (≈ 490k leftover rows were removed by hand on 2026-11-03). Activity stays
// append-only everywhere else: no update ever, and no delete outside the reset, which touches only its own office.

type U = { id: string; email: string };
let a: string, b: string;
let ua: U, ub: U;

const count = async (officeId: string) => {
  const { count: n, error } = await adminClient().from("activity").select("id", { count: "exact", head: true }).eq("office_id", officeId);
  if (error) throw error;
  return n ?? 0;
};
const ping = async (officeId: string, actor: string) => {
  const { data, error } = await adminClient().from("activity")
    .insert({ office_id: officeId, actor_id: actor, action: "test.ping", entity_type: "test" }).select("id").single();
  if (error) throw error;
  return data.id as number;
};

beforeAll(async () => {
  a = await createDocumentOffice("reset-activity-a");
  b = await createDocumentOffice("reset-activity-b");
  ua = await createStaff(a, "ra-a", "admin");
  ub = await createStaff(b, "ra-b", "admin");
});
afterAll(async () => { await retireStaff([ua?.id, ub?.id].filter(Boolean) as string[]); });

describe("reset_test_office purges the reset office's activity", () => {
  it("deletes that office's rows and leaves every other office's rows", async () => {
    await ping(a, ua.id);
    await ping(a, ua.id);
    const keep = await ping(b, ub.id);
    const before = await count(b);
    await resetTestOffice(a);
    expect(await count(a)).toBe(0);
    expect(await count(b)).toBe(before);
    const { data } = await adminClient().from("activity").select("id").eq("id", keep).maybeSingle();
    expect(data?.id).toBe(keep);
  });

  it("activity stays append-only outside the reset (no update, no delete, even for the service role)", async () => {
    const id = await ping(b, ub.id);
    const { error: upd } = await adminClient().from("activity").update({ action: "tampered" }).eq("id", id);
    expect(upd?.message).toMatch(/APPEND_ONLY/);
    const { error: del } = await adminClient().from("activity").delete().eq("id", id);
    expect(del?.message).toMatch(/APPEND_ONLY/);
  });
});
