import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { createDocumentOffice, mustCreateDocument, periodId, typeId } from "../support/documents";
import {
  T, bankOnlyClient, emailReminder, expectedItem, generateAsOf, mustRpc, rpc, type ChasingMetric,
} from "../support/expected";

// Feature 06 — metric 2, chasing load (spec AC-15) on Settings › Collection.
// Written before the migration (plan step 1). Contract: tests/support/expected.ts ("Feature 06").
//
// Definition: items received in [from, to]; a reminder counts for an item when it is a counting follow-up
// (sent, suppressed, opened, logged — never failed or pending) that includes the item and was recorded on or
// before the day it was received (sent_on ≤ received_on). per_item = reminders / received;
// needed_pct = share of received items with ≥ 1 reminder; by_channel counts reminder × item pairs.
//
// Fixture (Bank statement, overdue +1/7; clock 10 May 2026 → Mar and Apr open):
//   K1  Mar: failed email (not counted), WhatsApp (counted) · Apr: WhatsApp, call, sent email (3) · both received 12 May
//   K2  Mar: call on 10 May, but the document says received 8 May → not counted · Apr: call, never received → not in the metric
//   K3  Mar: call on 12 May and received 12 May → counted (same day)

type Who = "admin" | "manager" | "staff" | "limited";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
const k = {} as Record<"k1" | "k2" | "k3", string>;
const metric = (who: SupabaseClient, from: string, to: string) => mustRpc<ChasingMetric>(who, "chasing_metric", { p_from: from, p_to: to });
const receive = async (client: string, period: string, on: string) => mustCreateDocument(as.staff, {
  client_id: client, doc_type_id: await typeId(officeId, T.bank), period_id: await periodId(officeId, period), received_on: on,
});

beforeAll(async () => {
  officeId = await createDocumentOffice("chasing");
  u.admin = await createStaff(officeId, "ch-admin", "admin");
  u.manager = await createStaff(officeId, "ch-manager", "manager");
  u.staff = await createStaff(officeId, "ch-staff", "staff");
  u.limited = await createStaff(officeId, "ch-limited", "limited");
  for (const w of Object.keys(u) as Who[]) as[w] = await signedInClient(u[w].email);
  await generateAsOf(as.admin, "2026-03-15");
  let n = 0;
  for (const key of ["k1", "k2", "k3"] as const) {
    k[key] = await bankOnlyClient(as.staff, officeId, {
      name: `Chasing ${key}`, incharge_id: u.staff.id, email: `chase${++n}@example.test`, mobile: `98765100${String(n).padStart(2, "0")}`,
    });
  }
  await generateAsOf(as.admin, "2026-05-10");
  const item = async (key: keyof typeof k, p: string) => (await expectedItem(k[key], T.bank, p)).id;
  const k1Mar = await item("k1", "2026-03"), k1Apr = await item("k1", "2026-04");
  await emailReminder(as.staff, k.k1, [k1Mar], "failed");
  await mustRpc(as.staff, "record_follow_up", { p_client: k.k1, p_items: [k1Mar, k1Apr], p_channel: "whatsapp" });
  await mustRpc(as.staff, "record_follow_up", { p_client: k.k1, p_items: [k1Apr], p_channel: "phone" });
  await emailReminder(as.staff, k.k1, [k1Apr], "sent");
  await mustRpc(as.staff, "record_follow_up", { p_client: k.k2, p_items: [await item("k2", "2026-03")], p_channel: "phone" });
  await mustRpc(as.staff, "record_follow_up", { p_client: k.k2, p_items: [await item("k2", "2026-04")], p_channel: "phone" });
  await generateAsOf(as.admin, "2026-05-12");
  await mustRpc(as.staff, "record_follow_up", { p_client: k.k3, p_items: [await item("k3", "2026-03")], p_channel: "phone" });
  await receive(k.k1, "2026-03", "2026-05-12");
  await receive(k.k1, "2026-04", "2026-05-12");
  await receive(k.k2, "2026-03", "2026-05-08");
  await receive(k.k3, "2026-03", "2026-05-12");
}, 180_000);

afterAll(async () => {
  await retireStaff([u.manager, u.staff, u.limited].filter(Boolean).map((x) => x.id));
  if (u.admin) await retireStaff([u.admin.id]);
});

describe("metric 2 — chasing load (AC-15)", () => {
  it("counts reminders recorded on or before receipt, per received item and per channel", async () => {
    const m = await metric(as.manager, "2026-05-01", "2026-05-31");
    expect(m).toMatchObject({ received: 4, reminders: 5, by_channel: { email: 1, whatsapp: 2, phone: 2 } });
    expect(m.per_item).toBeCloseTo(1.25, 2);
    expect(m.needed_pct).toBeCloseTo(75, 1);
  });

  it("the window is on the received date; no received items → no figure", async () => {
    expect(await metric(as.admin, "2026-06-01", "2026-06-30"))
      .toMatchObject({ received: 0, reminders: 0, per_item: null, needed_pct: null, by_channel: { email: 0, whatsapp: 0, phone: 0 } });
    const only8 = await metric(as.admin, "2026-05-08", "2026-05-08");
    expect(only8).toMatchObject({ received: 1, reminders: 0, needed_pct: 0 });
  });

  it("is Admin/Manager only", async () => {
    for (const who of [as.staff, as.limited]) {
      expect((await rpc(who, "chasing_metric", { p_from: "2026-05-01", p_to: "2026-05-31" })).error).toMatch(/ROLE_REQUIRED/);
    }
  });
});
