import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, retireStaff, signedInClient } from "../support/db";
import { groupId, insertClient } from "../support/catalogue";
import { createDocument, createDocumentOffice, mustCreateDocument, mustCreateOriginal, mustDispatch, mustReview, periodId, typeId } from "../support/documents";
import { T, bankOnlyClient, expectedFor, generateAsOf, planRow } from "../support/expected";
import { insertActivity, visibleActivity } from "../support/activity";
import { PERMISSIONS, type Cell } from "@/lib/auth/permissions";
import { ROLES, type Role } from "@/lib/auth/roles";

// Feature 08 AC-12/AC-13 — every cell of "What each role can do" (src/lib/auth/permissions.ts, the same table the
// Users page shows) is proven by running that row's probe as each role's fixture user:
//   yes / all → allowed on client A (Limited's assigned client); "all" is also allowed on client B
//   assigned  → allowed on client A, refused on client B (Staff is incharge; Limited can't see it)
//   no        → refused on client A
// A row with no probe fails the run, so the screen can't drift from what is tested. A probe returns true when the
// action was allowed and took effect, false when it was refused; probes made of two actions throw if the parts
// disagree. Written before the 08 migration (plan step 2): only "see_activity" is red until `activity_select` is
// replaced. 05's approval function gets its probe part when main (05) is merged in (plan step 9).

let officeId: string;
const u = {} as Record<Role | "spare", { id: string; email: string }>;
const as = {} as Record<Role, SupabaseClient>;
const client = {} as Record<"A" | "B", string>;
const ids = {} as Record<"bank" | "apr" | "banking" | "gst" | "notice", string>;
const activityOn = {} as Record<string, number>;

type Probe = (who: SupabaseClient, clientId: string) => Promise<boolean>;
const ok = (r: { error: unknown }) => !r.error;
const changed = (r: { error: unknown; data: unknown[] | null }) => !r.error && (r.data?.length ?? 0) === 1;
const both = (a: boolean, b: boolean, what: string) => {
  if (a !== b) throw new Error(`probe ${what}: parts disagree (${a} vs ${b})`);
  return a;
};
const rpc = (who: SupabaseClient, fn: string, args: Record<string, unknown>) => who.rpc(fn, args);
const fileOn = (clientId: string, extra: Record<string, unknown> = {}) =>
  mustCreateDocument(as.staff, { client_id: clientId, doc_type_id: ids.bank, period_id: ids.apr, received_on: "2026-05-02", ...extra });

/** A pending expected item of the client nobody has used yet (each probe takes its own). */
const used = new Set<string>();
async function pendingItem(clientId: string) {
  const item = (await expectedFor(clientId)).filter((e) => e.status === "pending" && !used.has(e.id))
    .sort((a, b) => a.period.code.localeCompare(b.period.code))[0];
  if (!item) throw new Error("setup: ran out of pending expected items");
  used.add(item.id);
  return item;
}

// 10: helpers for the upload-link probes.
const linkHash = () => randomUUID().replace(/-/g, "").padEnd(64, "0");
let spare: SupabaseClient | undefined;
const spareClient = async () => (spare ??= await signedInClient(u.spare.email));
async function withMobile(clientId: string) {
  const { error } = await as.admin.from("client").update({ mobile: "9876500999" }).eq("id", clientId).is("mobile", null);
  if (error) throw new Error(`setup: ${error.message}`);
}

const PROBES: Record<string, Probe> = {
  see_clients: async (who, c) => {
    const doc = await fileOn(c);
    const cl = await who.from("client").select("id").eq("id", c);
    const d = await who.from("document").select("id").eq("id", doc.id);
    return both(changed(cl), changed(d), "see_clients");
  },
  manage_clients: async (who, c) => {
    const add = await insertClient(who, officeId, { name: `Matrix ${randomUUID().slice(0, 8)}`, client_type: "individual", incharge_id: u.staff.id });
    const edit = await who.from("client").update({ previous_reference: `M-${Date.now()}` }).eq("id", c).select("id");
    return both(ok(add), changed(edit), "manage_clients");
  },
  add_documents: async (who, c) =>
    ok(await createDocument(who, { client_id: c, doc_type_id: ids.bank, period_id: ids.apr, received_on: "2026-05-02" })),
  propose_type: async (who, c) =>
    ok(await rpc(who, "create_proposed_type", { p_client_id: c, p_doc_group_id: ids.banking, p_name: `Matrix type ${randomUUID().slice(0, 8)}` })),
  review_dispatch: async (who, c) => {
    const review = await rpc(who, "review_document", { p_id: (await fileOn(c)).id, p_outcome: "reviewed", p_reason: null });
    const original = await mustCreateOriginal(as.staff, { client_id: c, doc_type_id: ids.bank, period_id: ids.apr, received_on: "2026-05-02" }, as.staff);
    const dispatch = await rpc(who, "create_dispatch", { p: { client_id: c, document_ids: [original.id], dispatched_on: "2026-09-01", method: "hand_delivery", recipient_name: "Matrix" } });
    return both(ok(review), ok(dispatch), "review_dispatch");
  },
  undo_review_dispatch: async (who, c) => {
    const reviewed = await fileOn(c);
    await mustReview(as.staff, reviewed.id);
    const original = await mustCreateOriginal(as.staff, { client_id: c, doc_type_id: ids.bank, period_id: ids.apr, received_on: "2026-05-02" }, as.staff);
    await mustDispatch(as.staff, { client_id: c, document_ids: [original.id], dispatched_on: "2026-09-01" });
    const a = await rpc(who, "undo_review", { p_id: reviewed.id, p_reason: "Matrix" });
    const b = await rpc(who, "undo_dispatch_item", { p_document_id: original.id, p_reason: "Matrix" });
    return both(ok(a), ok(b), "undo_review_dispatch");
  },
  archive: async (who, c) => {
    const doc = await fileOn(c);
    const a = ok(await rpc(who, "archive_document", { p_id: doc.id, p_reason: "Matrix" }));
    const b = a ? ok(await rpc(who, "unarchive_document", { p_id: doc.id })) : false;
    const { data: spare, error } = await as.staff.from("client")
      .insert({ office_id: officeId, name: `Archive ${randomUUID().slice(0, 8)}`, client_type: "individual", incharge_id: u.limited.id })
      .select("id").single();
    if (error) throw error;
    void c;
    const cl = await who.from("client").update({ archived_at: new Date().toISOString(), archive_reason: "Matrix" }).eq("id", spare.id).select("id");
    return both(both(a, b, "archive document"), changed(cl), "archive");
  },
  waive: async (who, c) => ok(await rpc(who, "waive_expected", { p_id: (await pendingItem(c)).id, p_reason: "Matrix" })),
  reopen: async (who, c) => {
    const item = await pendingItem(c);
    await mustCreateDocument(as.staff, { client_id: c, doc_type_id: ids.bank, period_id: item.period_id, received_on: "2026-10-01" });
    const now = (await expectedFor(c)).find((e) => e.id === item.id)!;
    if (now.status !== "received") throw new Error("setup: item did not link");
    return ok(await rpc(who, "reopen_expected", { p_id: item.id }));
  },
  undo_waive: async (who, c) => {
    const item = await pendingItem(c);
    const { error } = await rpc(as.admin, "waive_expected", { p_id: item.id, p_reason: "Matrix" });
    if (error) throw new Error(error.message);
    return ok(await rpc(who, "undo_waive_expected", { p_id: item.id }));
  },
  remind: async (who, c) => {
    const item = (await expectedFor(c)).find((e) => e.status === "pending" && !used.has(e.id));
    if (!item) throw new Error("setup: no pending item to remind about");
    return ok(await rpc(who, "record_follow_up", { p_client: c, p_items: [item.id], p_channel: "phone" }));
  },
  // 10: an ad-hoc WhatsApp link (the fixture clients get a mobile first — Admin edits clients).
  send_upload_link: async (who, c) => {
    await withMobile(c);
    return ok(await rpc(who, "record_link_whatsapp", { p: { client_id: c, items: [{ kind: "ad_hoc", doc_type_id: ids.notice }], token_hash: linkHash() } }));
  },
  // 10: a link sent by another staff member ("spare"); only Admin/Manager may revoke it.
  revoke_upload_link: async (who, c) => {
    await withMobile(c);
    const spare = await spareClient();
    const sent = await rpc(spare, "record_link_whatsapp", { p: { client_id: c, items: [{ kind: "ad_hoc", doc_type_id: ids.notice }], token_hash: linkHash() } });
    if (sent.error) throw new Error(`setup: ${sent.error.message}`);
    return ok(await rpc(who, "revoke_upload_request", { p_id: (sent.data as { request_id: string }).request_id }));
  },
  change_plans: async (who, c) => {
    const on = ok(await rpc(who, "enable_client_group", { p_client_id: c, p_doc_group_id: ids.gst }));
    const off = ok(await rpc(who, "disable_client_group", { p_client_id: c, p_doc_group_id: ids.gst }));
    return both(on, off, "change_plans");
  },
  // 11: the "any format" exception on the client's Bank statement plan row; put back as Admin afterwards.
  format_exception: async (who, c) => {
    const row = (await planRow(c, T.bank)).id as string;
    const allowed = changed(await who.from("client_doc_type").update({ any_format: true }).eq("id", row).select("id"));
    if (allowed) {
      const { error } = await as.admin.from("client_doc_type").update({ any_format: false }).eq("id", row);
      if (error) throw error;
    }
    return allowed;
  },
  assign_pause: async (who, c) => {
    const groupRow = (await planRow(c, T.bank)).client_group_id as string;
    const res = await who.from("client_group").update({ assigned_staff_id: u.staff.id }).eq("id", groupRow).select("id");
    const allowed = changed(res);
    if (allowed) {
      const { error } = await as.admin.from("client_group").update({ assigned_staff_id: null }).eq("id", groupRow);
      if (error) throw error;
    }
    return allowed;
  },
  manage_catalogue: async (who, c) => {
    const { data: g } = await adminClient().from("doc_group").select("name").eq("id", ids.banking).single();
    const edit = await who.from("doc_group").update({ name: g!.name }).eq("id", ids.banking).select("id");
    const metric = await rpc(who, "collection_metric", { p_from: "2026-04-01", p_to: "2027-03-31" });
    // 05 (plan step 9): approving a proposed type. Staff proposes one on the client; the role approves it.
    const { data: proposed, error } = await rpc(as.staff, "create_proposed_type",
      { p_client_id: c, p_doc_group_id: ids.banking, p_name: `Matrix approve ${randomUUID().slice(0, 8)}` });
    if (error) throw new Error(error.message);
    const typeId = (proposed as { doc_type_id: string } | null)?.doc_type_id;
    if (!typeId) throw new Error("setup: create_proposed_type returned no doc_type_id");
    const approve = await rpc(who, "approve_proposed_type", { p: { type_id: typeId } });
    return both(both(changed(edit), ok(metric), "manage_catalogue (edit · metric)"), ok(approve), "manage_catalogue (approve)");
  },
  add_financial_year: async (who) => ok(await rpc(who, "add_financial_year", {})),
  see_activity: async (who, c) => (await visibleActivity(who, [activityOn[c]])).length === 1,
  manage_users: async (who) => {
    const res = await who.from("staff_user").update({ full_name: "Test rm-spare" }).eq("id", u.spare.id).select("id");
    return changed(res);
  },
};

beforeAll(async () => {
  officeId = await createDocumentOffice("role-matrix");
  for (const r of ROLES) u[r] = await createStaff(officeId, `rm-${r}`, r);
  u.spare = await createStaff(officeId, "rm-spare", "staff");
  for (const r of ROLES) as[r] = await signedInClient(u[r].email);
  ids.bank = await typeId(officeId, T.bank);
  ids.apr = await periodId(officeId, "2026-04");
  ids.banking = await groupId(officeId, "Banking");
  ids.gst = await groupId(officeId, "GST");
  ids.notice = await typeId(officeId, T.notice); // 10
  // Plans start in April 2026; generating as of September 2027 gives each client ~16 pending monthly items.
  await generateAsOf(as.admin, "2026-04-10");
  client.A = await bankOnlyClient(as.staff, officeId, { name: "Matrix A", incharge_id: u.limited.id });
  client.B = await bankOnlyClient(as.staff, officeId, { name: "Matrix B", incharge_id: u.staff.id });
  await generateAsOf(as.admin, "2027-09-15");
  const [a, b] = await insertActivity(officeId, [
    { actor_id: u.admin.id, action: "client.updated", entity_type: "client", entity_id: client.A },
    { actor_id: u.admin.id, action: "client.updated", entity_type: "client", entity_id: client.B },
  ]);
  activityOn[client.A] = a;
  activityOn[client.B] = b;
}, 240_000);

afterAll(async () => {
  await retireStaff([u.manager, u.staff, u.limited, u.spare].filter(Boolean).map((x) => x.id));
  await retireStaff([u.admin].filter(Boolean).map((x) => x.id));
});

describe("permissions matrix (AC-12, AC-13)", () => {
  it("every row has a probe, and every probe belongs to a row", () => {
    expect(PERMISSIONS.map((r) => r.id).filter((id) => !PROBES[id])).toEqual([]);
    expect(Object.keys(PROBES).filter((id) => !PERMISSIONS.some((r) => r.id === id))).toEqual([]);
  });

  const expectations = (cell: Cell): Array<["A" | "B", boolean]> =>
    cell === "no" ? [["A", false]] : cell === "yes" ? [["A", true]] : cell === "all" ? [["A", true], ["B", true]] : [["A", true], ["B", false]];

  for (const row of PERMISSIONS) {
    for (const role of ROLES) {
      it(`${row.label} — ${role}: ${row.values[role]}`, async () => {
        const probe = PROBES[row.id];
        if (!probe) throw new Error(`no probe for ${row.id}`);
        for (const [side, allowed] of expectations(row.values[role])) {
          expect({ side, allowed: await probe(as[role], client[side]) }).toEqual({ side, allowed });
        }
      }, 60_000);
    }
  }
});
