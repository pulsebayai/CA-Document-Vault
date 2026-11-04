import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createStaff, signedInClient } from "../../support/db";
import { groupId, proposeType } from "../../support/catalogue";
import {
  createDocumentOffice, mustCreateDocument, mustCreateOriginal, mustDispatch, mustReview, mustSetCustody, typeId, uploadObject,
} from "../../support/documents";
import { T, bankOnlyClient, expectedItem, generateAsOf, mustRpc } from "../../support/expected";
import { FAKE_CT, mustSaveDsc, newDsc } from "../../support/dsc";
import { testGstin, testPan } from "../../support/test-data";

// Feature 18 (spec AC-1) — two firms on one database, each with an Admin, a Staff and a Limited user and at least one
// row in every table that carries office_id, all made through the app's own functions as signed-in staff (02: the
// service role can't write clients). Firm B's free text carries a random marker (no PII) so aggregate reads can be
// checked for leaks by text as well as by ID. Both offices are reset at the start, so the seed is the same every run.

export type Role = "admin" | "staff" | "limited";
export type Firm = {
  key: "a" | "b";
  office: string;
  marker: string;
  users: Record<Role, { id: string; email: string }>;
  as: Record<Role, SupabaseClient>;
  ids: {
    client: string; registration: string; contact: string; group: string; bankType: string; proposedType: string;
    rejectedType: string; clientGroup: string; planRow: string; period: string; financialYear: string; expected: string;
    softDoc: string; softVersion: string; softPath: string; reviewedDoc: string; heldDoc: string; dispatchedDoc: string;
    dispatch: string; dispatchItem: string; followUp: string; request: string; scheduledItem: string; adHocItem: string;
    linkDoc: string; linkTokenHash: string; dsc: string; dscCustody: string; notification: string; activity: number;
    review: string; custody: string; laterExpected: string;
  };
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const one = async (q: PromiseLike<{ data: unknown; error: unknown }>, what: string) => {
  const { data, error } = await q;
  if (error) throw new Error(`seed ${what}: ${(error as { message: string }).message}`);
  return data as Record<string, unknown>;
};

async function seedFirm(key: "a" | "b"): Promise<Firm> {
  const marker = `XF-${key.toUpperCase()}-${randomBytes(4).toString("hex")}`;
  const office = await createDocumentOffice(`xfirm-${key}`);
  const users = {
    admin: await createStaff(office, `xfirm-${key}-admin`, "admin"),
    staff: await createStaff(office, `xfirm-${key}-staff`, "staff"),
    limited: await createStaff(office, `xfirm-${key}-limited`, "limited"),
  };
  const as = {
    admin: await signedInClient(users.admin.email),
    staff: await signedInClient(users.staff.email),
    limited: await signedInClient(users.limited.email),
  };
  const svc = adminClient();
  const ids = {} as Firm["ids"];

  // Clients and plan (02, 04): one client, incharge = the Limited user, so every role of the firm can see it.
  await generateAsOf(as.admin, "2026-03-15");
  ids.client = await bankOnlyClient(as.staff, office, {
    name: `${marker} Client`, incharge_id: users.limited.id, email: `${key}-client@example.test`, mobile: "9876500001",
  });
  const pan = testPan("P", key === "a" ? 1801 : 1802);
  await one(as.staff.from("client").update({ pan }).eq("id", ids.client), "pan");
  ids.registration = (await one(as.staff.from("client_registration")
    .insert({ office_id: office, client_id: ids.client, kind: "gstin", number: testGstin(pan) }).select("id").single(), "registration")).id as string;
  ids.contact = (await one(as.staff.from("client_contact")
    .insert({ office_id: office, client_id: ids.client, name: `${marker} Contact`, role: "accountant" }).select("id").single(), "contact")).id as string;
  ids.group = await groupId(office, "Banking");
  ids.bankType = await typeId(office, T.bank);
  ids.clientGroup = (await one(svc.from("client_group").select("id").eq("client_id", ids.client).eq("doc_group_id", ids.group).single(), "client_group")).id as string;
  ids.planRow = (await one(svc.from("client_doc_type").select("id").eq("client_id", ids.client).eq("doc_type_id", ids.bankType).single(), "plan row")).id as string;
  await generateAsOf(as.admin, "2026-05-15");
  const exp = await expectedItem(ids.client, T.bank, "2026-03");
  ids.expected = exp.id;
  ids.period = (await one(svc.from("expected_doc").select("period_id").eq("id", exp.id).single(), "period")).period_id as string;
  ids.financialYear = (await one(svc.from("period").select("financial_year_id").eq("id", ids.period).single(), "fy")).financial_year_id as string;

  // Proposed types (03, 05): one stays proposed; one is rejected by the Admin → a notification for the Staff proposer.
  ids.proposedType = await proposeType(as.staff, ids.client, ids.group, `${marker} Proposed`);
  ids.rejectedType = await proposeType(as.staff, ids.client, ids.group, `${marker} Rejected`);
  await mustRpc(as.admin, "reject_proposed_type", { p_type: ids.rejectedType, p_comment: "not needed" });
  ids.notification = (await one(svc.from("notification").select("id").eq("recipient_id", users.staff.id)
    .order("created_at", { ascending: false }).limit(1).single(), "notification")).id as string;

  // Documents (03, 07, 12, 13): a soft copy with a stored file, a reviewed one, a hard copy in custody, a dispatched one.
  const obj = await uploadObject(office, "pdf");
  const soft = await mustCreateDocument(as.staff, {
    client_id: ids.client, doc_type_id: ids.bankType, period_id: ids.period, received_as: "soft_copy", channel: "email",
    received_on: "2026-04-03", remark: `${marker} remark`, file: { storage_path: obj.path, file_name: `${marker}-statement.pdf` },
  });
  ids.softDoc = soft.id;
  ids.softPath = obj.path;
  ids.softVersion = (await one(svc.from("document").select("current_version_id").eq("id", soft.id).single(), "version")).current_version_id as string;
  const reviewed = await mustCreateDocument(as.staff, {
    client_id: ids.client, doc_type_id: ids.bankType, period_id: ids.period, received_on: "2026-04-04", remark: `${marker} reviewed`,
  });
  ids.reviewedDoc = reviewed.id;
  await mustReview(as.staff, reviewed.id);
  ids.review = (await one(svc.from("document_review").select("id").eq("document_id", reviewed.id).limit(1).single(), "review")).id as string;
  const held = await mustCreateOriginal(as.staff, { client_id: ids.client, doc_type_id: ids.bankType, period_id: ids.period, received_on: "2026-04-05" }, as.staff);
  ids.heldDoc = held.id;
  await mustSetCustody(as.staff, [held.id], "in_office");
  ids.custody = (await one(svc.from("document_custody").select("id").eq("document_id", held.id).limit(1).single(), "custody")).id as string;
  const sent = await mustCreateOriginal(as.staff, { client_id: ids.client, doc_type_id: ids.bankType, period_id: ids.period, received_on: "2026-04-06" }, as.staff);
  ids.dispatchedDoc = sent.id;
  await mustSetCustody(as.staff, [sent.id], "in_office");
  await mustSetCustody(as.staff, [sent.id], "ready");
  ids.dispatch = (await mustDispatch(as.staff, { client_id: ids.client, document_ids: [sent.id], dispatched_on: "2026-05-01", recipient_name: `${marker} Recipient` })).id;
  ids.dispatchItem = (await one(svc.from("dispatch_item").select("id").eq("dispatch_id", ids.dispatch).single(), "dispatch item")).id as string;

  // Follow-up (06) on a later pending item, and an upload link (10) with a scheduled and an ad-hoc item + one upload.
  const later = await expectedItem(ids.client, T.bank, "2026-04");
  ids.laterExpected = later.id;
  ids.followUp = await mustRpc<string>(as.staff, "record_follow_up", { p_client: ids.client, p_items: [later.id], p_channel: "phone" });
  const token = randomBytes(32).toString("base64url");
  ids.linkTokenHash = sha(token);
  const link = await mustRpc<{ request_id: string }>(as.staff, "record_link_whatsapp", { p: {
    client_id: ids.client, token_hash: ids.linkTokenHash,
    items: [{ kind: "scheduled", expected_doc_id: later.id }, { kind: "ad_hoc", doc_type_id: ids.bankType, note: `${marker} note` }],
  } });
  ids.request = link.request_id;
  const items = (await svc.from("upload_request_item").select("id, kind").eq("request_id", ids.request)).data as Array<{ id: string; kind: string }>;
  ids.scheduledItem = items.find((i) => i.kind === "scheduled")!.id;
  ids.adHocItem = items.find((i) => i.kind === "ad_hoc")!.id;
  const ip = sha(`xfirm-${key}-ip`);
  const t = await one(svc.rpc("link_ticket", { p_token_hash: ids.linkTokenHash, p_item_id: ids.adHocItem, p_file: { ext: "pdf", size: 60 }, p_ip_hash: ip }), "link ticket");
  const up = await uploadObject(office, "pdf", t.document_id as string);
  await one(svc.rpc("link_register", { p_token_hash: ids.linkTokenHash, p_item_id: ids.adHocItem, p_file: { storage_path: up.path, file_name: "invoice.pdf" }, p_ip_hash: ip }), "link register");
  ids.linkDoc = t.document_id as string;

  // DSC (14): a record, a custody move and a per-client reminder setting.
  ids.dsc = await mustSaveDsc(as.staff, newDsc(ids.client, { holder_name: `${marker} Holder`, password_ct: FAKE_CT, expires_on: "2026-06-10" }));
  await mustRpc(as.staff, "dsc_custody_log", { p: { dsc_id: ids.dsc, direction: "out", person_name: `${marker} Person`, on_date: "2026-05-01" } });
  ids.dscCustody = (await one(svc.from("dsc_custody").select("id").eq("dsc_id", ids.dsc).limit(1).single(), "dsc custody")).id as string;
  await mustRpc(as.staff, "dsc_set_remind_days", { p_client_id: ids.client, p_days: 45 });

  ids.activity = (await one(svc.from("activity").select("id").eq("office_id", office).order("id", { ascending: false }).limit(1).single(), "activity")).id as number;
  return { key, office, marker, users, as, ids };
}

/** Firm A and Firm B, freshly seeded. B's marker never appears in anything A can read (AC-8). */
export async function seedTwoFirms(): Promise<{ A: Firm; B: Firm }> {
  const A = await seedFirm("a");
  const B = await seedFirm("b");
  return { A, B };
}

/** Rows per firm-owned table for one office (service role), so a seed check can prove "≥ 1 in every table". */
export async function rowCounts(office: string, tables: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) {
    const { count, error } = await adminClient().from(t).select("*", { count: "exact", head: true }).eq("office_id", office);
    if (error) throw new Error(`count ${t}: ${error.message}`);
    out[t] = count ?? 0;
  }
  return out;
}

/** Firm C (spec AC-8): a firm with an Admin and nothing else, so every firm-wide figure it gets must be zero/empty. */
export async function seedEmptyFirm(): Promise<{ office: string; admin: SupabaseClient }> {
  const office = await createDocumentOffice("xfirm-c");
  const u = await createStaff(office, "xfirm-c-admin", "admin");
  return { office, admin: await signedInClient(u.email) };
}
