import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createStaff, retireStaff, signedInClient } from "../support/db";
import { createCatalogueOffice } from "../support/catalogue";
import { createDocumentOffice, mustCreateDocument, mustCreateOriginal, mustDispatch, periodId, typeId } from "../support/documents";
import { T, bankOnlyClient, expectedOf, generateAsOf, mustRpc, planRow } from "../support/expected";
import { insertActivity, visibleActivity, type NewActivity } from "../support/activity";

// Feature 08 AC-11 — who reads which activity rows, enforced by the `activity_select` policy and tested by reading
// the table directly (not through the feed). Admin/Manager/Staff read the whole office. Limited read a row only
// when they are its actor, or its client is one they can see; the client comes from data.client_id, else from the
// row's entity (client · document · expected_doc · follow_up · dispatch · client_group · client_doc_type).
//
// Rows here are synthetic (service role) so each entity kind is tested on its own, with no data.client_id, and an
// actor who isn't Limited. Client A: Limited is incharge. Client B: Staff is incharge (Limited can't see it).

type Who = "admin" | "manager" | "staff" | "limited" | "outsider";
let officeId: string;
const u = {} as Record<Who, { id: string; email: string }>;
const as = {} as Record<Who, SupabaseClient>;
type Side = "A" | "B";
const ent = { A: {}, B: {} } as Record<Side, Record<string, string>>;
const rowsFor = { A: [] as number[], B: [] as number[] };
let noClient: number[] = [];
let limitedOwn: number[] = [];
let weird: number[] = [];

beforeAll(async () => {
  officeId = await createDocumentOffice("activity-visibility");
  const other = await createCatalogueOffice("activity-visibility-other");
  u.admin = await createStaff(officeId, "av-admin", "admin");
  u.manager = await createStaff(officeId, "av-manager", "manager");
  u.staff = await createStaff(officeId, "av-staff", "staff");
  u.limited = await createStaff(officeId, "av-limited", "limited");
  u.outsider = await createStaff(other, "av-outsider", "admin");
  for (const k of Object.keys(u) as Who[]) as[k] = await signedInClient(u[k].email);

  await generateAsOf(as.admin, "2026-04-10"); // plans start in April 2026
  const bank = await typeId(officeId, T.bank);
  const apr = await periodId(officeId, "2026-04");
  // Both clients are created at the April clock (so their plans start in April), then generated once in June.
  for (const side of ["A", "B"] as Side[]) {
    const incharge = side === "A" ? u.limited.id : u.staff.id;
    ent[side].client = await bankOnlyClient(as.staff, officeId, { name: `Visibility ${side}`, incharge_id: incharge });
  }
  await generateAsOf(as.admin, "2026-06-15");
  for (const side of ["A", "B"] as Side[]) {
    const e = ent[side];
    const client = e.client;
    e.document = (await mustCreateDocument(as.staff, { client_id: client, doc_type_id: bank, period_id: apr, received_on: "2026-05-02" })).id;
    const original = await mustCreateOriginal(as.staff, { client_id: client, doc_type_id: bank, period_id: apr, received_on: "2026-05-02" }, as.staff);
    e.dispatch = (await mustDispatch(as.staff, { client_id: client, document_ids: [original.id], dispatched_on: "2026-09-01" })).id;
    const items = (await expectedOf(client, T.bank)).filter((x) => x.status === "pending");
    if (items.length === 0) throw new Error("setup: no pending expected items");
    e.expected_doc = items[0].id;
    e.follow_up = await mustRpc<string>(as.staff, "record_follow_up", { p_client: client, p_items: [items[0].id], p_channel: "phone" });
    const row = await planRow(client, T.bank);
    e.client_doc_type = row.id as string;
    e.client_group = row.client_group_id as string;
  }

  // One row per entity kind and side, with no client in data and an admin actor.
  for (const side of ["A", "B"] as Side[]) {
    const e = ent[side];
    const rows: NewActivity[] = Object.entries(e).map(([kind, id]) => ({
      actor_id: u.admin.id, action: `${kind}.test_row`, entity_type: kind, entity_id: id,
    }));
    // data.client_id alone decides when present (entity without a client of its own).
    rows.push({ actor_id: u.admin.id, action: "doc_type.test_row", entity_type: "doc_type", entity_id: null, data: { client_id: e.client } });
    rowsFor[side] = await insertActivity(officeId, rows);
  }
  noClient = await insertActivity(officeId, [
    { actor_id: u.admin.id, action: "doc_type.created", entity_type: "doc_type", entity_id: null },
    { actor_id: u.admin.id, action: "staff.invited", entity_type: "staff_user", entity_id: u.limited.id },
    { actor_id: u.staff.id, action: "auth.signed_in", entity_type: "staff_user", entity_id: u.staff.id },
    { actor_id: null, action: "expected.generated", entity_type: "office", entity_id: officeId },
    { actor_id: u.staff.id, action: "client.imported", entity_type: "client", entity_id: null, data: { client_ids: [ent.A.client] } },
  ]);
  limitedOwn = await insertActivity(officeId, [
    { actor_id: u.limited.id, action: "auth.signed_in", entity_type: "staff_user", entity_id: u.limited.id },
    { actor_id: u.limited.id, action: "document.added", entity_type: "document", entity_id: ent.B.document }, // own row, client hidden
  ]);
  // Malformed entity IDs must not break reads (the policy runs on every row).
  weird = await insertActivity(officeId, [
    { actor_id: u.admin.id, action: "document.test_row", entity_type: "document", entity_id: "not-a-uuid" },
    { actor_id: u.admin.id, action: "client.test_row", entity_type: "client", entity_id: "" },
    { actor_id: u.admin.id, action: "doc_type.test_row", entity_type: "doc_type", entity_id: null, data: { client_id: "not-a-uuid" } },
  ]);
}, 240_000);

afterAll(async () => {
  await retireStaff([u.manager, u.staff, u.limited].filter(Boolean).map((x) => x.id));
  await retireStaff([u.admin, u.outsider].filter(Boolean).map((x) => x.id));
});

const all = () => [...rowsFor.A, ...rowsFor.B, ...noClient, ...limitedOwn, ...weird].sort((a, b) => a - b);

describe("activity visibility (AC-11)", () => {
  it("Admin, Manager and Staff read every row of the office", async () => {
    for (const k of ["admin", "manager", "staff"] as const) {
      expect(await visibleActivity(as[k], all())).toEqual(all());
    }
  });

  it("Limited reads each entity kind's rows for a client it can see", async () => {
    const seen = await visibleActivity(as.limited, rowsFor.A);
    expect(seen).toEqual([...rowsFor.A].sort((a, b) => a - b));
  });

  it("Limited reads none of the rows for a client it can't see, whatever the entity kind", async () => {
    expect(await visibleActivity(as.limited, rowsFor.B)).toEqual([]);
  });

  it("Limited reads rows with no client only when it is the actor (its own row on a hidden client included)", async () => {
    expect(await visibleActivity(as.limited, noClient)).toEqual([]);
    expect(await visibleActivity(as.limited, limitedOwn)).toEqual([...limitedOwn].sort((a, b) => a - b));
  });

  it("malformed entity IDs neither break reads nor leak rows to Limited", async () => {
    expect(await visibleActivity(as.limited, weird)).toEqual([]);
    const { error } = await as.limited.from("activity").select("id").eq("office_id", officeId).limit(500);
    expect(error).toBeNull();
  });

  it("another office reads nothing", async () => {
    expect(await visibleActivity(as.outsider, all())).toEqual([]);
  });

  it("a Limited user whose client is reassigned loses its rows at once (RLS, not a copy)", async () => {
    // Service-role writes to client are refused by design (02), so the Admin reassigns.
    const { error } = await as.admin.from("client").update({ incharge_id: u.staff.id }).eq("id", ent.A.client);
    if (error) throw error;
    try {
      expect(await visibleActivity(as.limited, rowsFor.A)).toEqual([]);
    } finally {
      const { error: e3 } = await as.admin.from("client").update({ incharge_id: u.limited.id }).eq("id", ent.A.client);
      if (e3) throw e3;
    }
  });
});
