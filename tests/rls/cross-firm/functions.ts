import { createHash, randomBytes } from "node:crypto";
import { adminClient } from "../../support/db";
import { uploadObject } from "../../support/documents";
import type { Firm, Role } from "./seed";

// Feature 18 (spec AC-6–AC-8, X5) — one entry per function staff can call. Each attempt is made as a member of Firm A
// with Firm B's IDs, or with Firm A's own object combined with one of B's ("mixed", the cross-reference case for
// functions). Each attempt has a **control**: the same call with the same payload shape on Firm A's own objects, which
// must succeed — so a refusal can't come from a bad argument (pre-PR review I-4, I-6). Where no control can be built,
// the case says why (`controlExempt`) and names the refusal it expects (`expect`).
// Kinds:
//   write      — must be refused or do nothing; the file's afterAll snapshot proves Firm B is unchanged and scans that
//                no Firm A row points at Firm B (so a void function that "succeeds" is still checked, I-1)
//   read       — may answer, but never with Firm B's IDs or marker text; its control must return Firm A's data
//   firm-wide  — an aggregate of the caller's firm: Firm C (no data) must get all zeros while Firm A's control doesn't
//   own-office — takes no ID and acts on the caller's own office only; the snapshot proves Firm B is unchanged
// Order matters: controls change Firm A's state, so the cases run in this order and each "undo" follows its "do".
// Running one case alone with `-t` can therefore give misleading results (review N-6).

type Args = Record<string, unknown>;
type ArgsFn<T extends unknown[]> = (...f: T) => Args | Promise<Args>;
export type Attempt = { label: string; args: ArgsFn<[Firm, Firm]>; control?: ArgsFn<[Firm]> };
export type FnCase = {
  fn: string;
  kind: "write" | "read" | "firm-wide" | "own-office";
  as?: Role;
  attempts: Attempt[];
  /** the default control for attempts without their own */
  control?: ArgsFn<[Firm]>;
  /** why no control can be built (write cases only), and the refusal expected instead */
  controlExempt?: string;
  expect?: RegExp;
};

const D = "2026-05-02";
const hash = () => createHash("sha256").update(randomBytes(32)).digest("hex");
const B_ = (label: string, args: (B: Firm) => Args | Promise<Args>, control?: ArgsFn<[Firm]>): Attempt =>
  ({ label, args: (_A: Firm, B: Firm) => args(B), control });
const doc = (f: Firm, extra: Args = {}) => ({
  client_id: f.ids.client, doc_type_id: f.ids.bankType, period_id: f.ids.period, received_as: "hard_copy",
  channel: "hand_delivery", received_on: D, handed_over_name: "Cross firm test", ...extra,
});
const softDoc = async (f: Firm, extra: Args = {}) => doc(f, {
  received_as: "soft_copy", channel: "email", handed_over_name: null,
  file: { storage_path: (await uploadObject(f.office, "pdf")).path, file_name: "x.pdf" }, ...extra,
});
const clientBody = (f: Firm, incharge: string) => ({
  name: `${f.marker} Client`, client_type: "individual", incharge_id: incharge, previous_reference: "XF",
  email: `${f.key}-client@example.test`, mobile: "9876500001", pan: f.ids.pan, // the PAN stays: its GSTIN depends on it
});
const linkBody = (client: string, items: Args[], extra: Args = {}) => ({ client_id: client, items, token_hash: hash(), ...extra });
const adHoc = (f: Firm, extra: Args = {}) => ({ kind: "ad_hoc", doc_type_id: f.ids.bankType, ...extra });
const RANGE = { p_from: "2026-01-01", p_to: "2026-12-31" };

/** Firm A's open ad-hoc items, set by the upload-links section (sweep.test.ts) before the function cases run. */
export const shared = { aOpenItem: "", aFileItem: "" };

export const FN_CASES: FnCase[] = [
  // ── reads (AC-8) ────────────────────────────────────────────────────────────────────────────────────────────────
  { fn: "activity_feed", kind: "read", attempts: [
    B_("B's document", (B) => ({ p: { document_id: B.ids.softDoc } })), B_("B's client", (B) => ({ p: { client_id: B.ids.client } })),
    { label: "no filter", args: () => ({ p: {} }) },
  ], control: (A) => ({ p: { document_id: A.ids.softDoc } }) },
  { fn: "document_last_activity", kind: "read", attempts: [B_("B's documents", (B) => ({ p_ids: [B.ids.softDoc, B.ids.reviewedDoc] }))],
    control: (A) => ({ p_ids: [A.ids.softDoc] }) },
  { fn: "search_documents", kind: "read", attempts: [
    B_("B's marker", (B) => ({ p: { text: B.marker } })), B_("B's client", (B) => ({ p: { client_id: B.ids.client } })),
    B_("B's type", (B) => ({ p: { doc_type_id: B.ids.bankType } })), { label: "no filter", args: () => ({ p: {} }) },
  ], control: (A) => ({ p: { text: A.marker } }) },
  { fn: "search_document_facets", kind: "read", attempts: [B_("B's client", (B) => ({ p: { client_id: B.ids.client } })),
    { label: "no filter", args: () => ({ p: {} }) }], control: () => ({ p: {} }) },
  { fn: "search_clients", kind: "read", attempts: [B_("B's marker", (B) => ({ p_query: B.marker })),
    B_("B's incharge", (B) => ({ p_query: null, p_incharge_id: B.users.limited.id })), { label: "no filter", args: () => ({ p_query: null }) }],
    control: (A) => ({ p_query: A.marker }) },
  { fn: "suggest_doc_types", kind: "read", attempts: [B_("B's client", (B) => ({ p_client_id: B.ids.client, p_query: "XF" })),
    { label: "B's type names", args: (A, B) => ({ p_client_id: A.ids.client, p_query: B.marker }) }],
    control: (A) => ({ p_client_id: A.ids.client, p_query: "Bank" }) },
  { fn: "preview_type_decision", kind: "read", attempts: [
    B_("B's proposed type", (B) => ({ p: { action: "approve", type_id: B.ids.proposedType } })),
    { label: "mixed: merge A's into B's type", args: (A, B) => ({ p: { action: "merge", type_id: A.ids.proposedType, target_id: B.ids.bankType } }),
      control: (A) => ({ p: { action: "merge", type_id: A.ids.proposedType, target_id: A.ids.bankType } }) },
  ], control: (A) => ({ p: { action: "approve", type_id: A.ids.proposedType } }) },
  { fn: "today_items", kind: "read", attempts: [{ label: "everyone", args: () => ({ p_scope: "everyone", p_show: null, p_page: 1, p_limit: 50 }) }],
    control: () => ({ p_scope: "everyone", p_show: null, p_page: 1, p_limit: 50 }) },
  { fn: "dsc_due", kind: "read", attempts: [{ label: "everyone", args: () => ({ p_scope: "everyone" }) }], control: () => ({ p_scope: "everyone" }) },
  { fn: "proposal_queue", kind: "read", attempts: [{ label: "queue", args: () => ({}) }], control: () => ({}) },
  // ── firm-wide aggregates (AC-8): Firm C has no data, so any non-zero is another firm's; Firm A's control isn't zero
  ...["catalogue_metric", "chasing_metric", "collection_metric", "custody_metric", "format_metric", "link_metric"].map((fn): FnCase => ({
    fn, kind: "firm-wide",
    attempts: [{ label: "as Firm C", args: () => (fn === "catalogue_metric" ? {} : RANGE) }],
    control: () => (fn === "catalogue_metric" ? {} : RANGE),
  })),
  // ── own-office functions: no ID to point elsewhere (the snapshot, incl. B's office row, proves B is unchanged) ──
  { fn: "add_financial_year", kind: "own-office", attempts: [{ label: "next year", args: () => ({}) }] },
  { fn: "mark_notifications_read", kind: "own-office", as: "staff", attempts: [{ label: "all", args: () => ({}) }] },
  { fn: "run_expected_generation", kind: "own-office", attempts: [{ label: "today", args: () => ({ p_as_of: "2026-05-15" }) }] },
  { fn: "seed_test_activity", kind: "own-office", attempts: [{ label: "one row", args: () => ({ p_count: 1, p_from: "2026-05-01T00:00:00Z", p_to: "2026-05-02T00:00:00Z" }) }] },

  // ── writes (AC-6): clients and plans ────────────────────────────────────────────────────────────────────────────
  { fn: "create_client", kind: "write", attempts: [
    { label: "mixed: B's staff as incharge", args: (_A, B) => ({ p: { name: "XF incharge", client_type: "individual", incharge_id: B.users.staff.id } }) },
  ], control: (A) => ({ p: { name: `${A.marker} control`, client_type: "individual", incharge_id: A.users.staff.id } }) },
  { fn: "import_clients", kind: "write", attempts: [
    { label: "mixed: B's staff as incharge", args: (_A, B) => ({ p_rows: [{ name: "XF import", client_type: "individual", incharge_id: B.users.staff.id }] }) },
  ], control: (A) => ({ p_rows: [{ name: `${A.marker} import`, client_type: "individual", incharge_id: A.users.staff.id }] }) },
  { fn: "update_client", kind: "write", attempts: [
    B_("B's client", (B) => ({ p_client_id: B.ids.client, p: clientBody(B, B.users.limited.id) })),
    { label: "mixed: B's staff as incharge", args: (A, B) => ({ p_client_id: A.ids.client, p: clientBody(A, B.users.staff.id) }) },
  ], control: (A) => ({ p_client_id: A.ids.client, p: clientBody(A, A.users.limited.id) }) },
  { fn: "enable_client_group", kind: "write", attempts: [
    B_("B's client + group", (B) => ({ p_client_id: B.ids.client, p_doc_group_id: B.ids.otherGroup })),
    { label: "mixed: A's client, B's group", args: (A, B) => ({ p_client_id: A.ids.client, p_doc_group_id: B.ids.otherGroup }) },
    { label: "mixed: B's client, A's group", args: (A, B) => ({ p_client_id: B.ids.client, p_doc_group_id: A.ids.otherGroup }) },
  ], control: (A) => ({ p_client_id: A.ids.client, p_doc_group_id: A.ids.otherGroup }) },
  { fn: "add_client_doc_type", kind: "write", attempts: [
    B_("B's client + type", (B) => ({ p_client_id: B.ids.client, p_doc_type_id: B.ids.bankType })),
    { label: "mixed: A's client, B's type", args: (A, B) => ({ p_client_id: A.ids.client, p_doc_type_id: B.ids.bankType }) },
    { label: "mixed: B's client, A's type", args: (A, B) => ({ p_client_id: B.ids.client, p_doc_type_id: A.ids.bankType }) },
  // control: a type already in A's plan is accepted (on conflict do nothing → its row ID), the same shape
  ], control: (A) => ({ p_client_id: A.ids.client, p_doc_type_id: A.ids.bankType }) },
  { fn: "create_proposed_type", kind: "write", attempts: [
    B_("B's client + group", (B) => ({ p_client_id: B.ids.client, p_doc_group_id: B.ids.group, p_name: "XF proposed" })),
    { label: "mixed: A's client, B's group", args: (A, B) => ({ p_client_id: A.ids.client, p_doc_group_id: B.ids.group, p_name: "XF mixed" }) },
  ], control: (A) => ({ p_client_id: A.ids.client, p_doc_group_id: A.ids.group, p_name: `${A.marker} control ${randomBytes(2).toString("hex")}` }) },
  { fn: "dsc_set_remind_days", kind: "write", attempts: [B_("B's client", (B) => ({ p_client_id: B.ids.client, p_days: 31 }))],
    control: (A) => ({ p_client_id: A.ids.client, p_days: 46 }) },

  // ── documents ───────────────────────────────────────────────────────────────────────────────────────────────────
  { fn: "create_document", kind: "write", attempts: [
    B_("B's client", (B) => ({ p: doc(B) })),
    { label: "mixed: B's type", args: (A, B) => ({ p: doc(A, { doc_type_id: B.ids.bankType }) }) },
    { label: "mixed: B's period", args: (A, B) => ({ p: doc(A, { period_id: B.ids.period }) }) },
    { label: "mixed: B's registration", args: (A, B) => ({ p: doc(A, { doc_type_id: A.ids.gstType, registration_id: B.ids.registration }) }),
      control: (A) => ({ p: doc(A, { doc_type_id: A.ids.gstType, registration_id: A.ids.registration }) }) },
    { label: "mixed: B's staff receives", args: (A, B) => ({ p: doc(A, { received_by: B.users.staff.id }) }),
      control: (A) => ({ p: doc(A, { received_by: A.users.staff.id }) }) },
    { label: "mixed: B's stored file", args: async (A, B) => ({ p: await softDoc(A, { file: { storage_path: B.ids.softPath, file_name: "x.pdf" } }) }),
      control: async (A) => ({ p: await softDoc(A) }) },
  ], control: (A) => ({ p: doc(A) }) },
  { fn: "seed_test_documents", kind: "write", attempts: [
    B_("B's client", (B) => ({ p_docs: [doc(B)] })),
    { label: "mixed: B's type", args: (A, B) => ({ p_docs: [doc(A, { doc_type_id: B.ids.bankType })] }) },
  ], control: (A) => ({ p_docs: [doc(A)] }) },
  { fn: "log_receipt", kind: "write", attempts: [
    B_("B's client", (B) => ({ p: { client_id: B.ids.client, doc_type_id: B.ids.bankType, period_id: B.ids.period, count: 1, handed_over_name: "XF" } })),
    { label: "mixed: B's type", args: (A, B) => ({ p: { client_id: A.ids.client, doc_type_id: B.ids.bankType, period_id: A.ids.period, count: 1, handed_over_name: "XF" } }) },
  ], control: (A) => ({ p: { client_id: A.ids.client, doc_type_id: A.ids.bankType, period_id: A.ids.period, count: 1, handed_over_name: "XF" } }) },
  { fn: "add_document_version", kind: "write", attempts: [
    { label: "B's document", args: async (_A, B) => ({ p_document_id: B.ids.softDoc, p_file: { storage_path: (await uploadObject(B.office, "pdf", B.ids.softDoc)).path, file_name: "x.pdf" }, p_received_on: null }) },
    { label: "mixed: A's document, B's stored file", args: (A, B) => ({ p_document_id: A.ids.softDoc, p_file: { storage_path: B.ids.softPath, file_name: "x.pdf" }, p_received_on: null }) },
  ], control: async (A) => ({ p_document_id: A.ids.softDoc, p_file: { storage_path: (await uploadObject(A.office, "pdf", A.ids.softDoc)).path, file_name: "x.pdf" }, p_received_on: null }) },
  { fn: "update_document", kind: "write", attempts: [
    B_("B's document", (B) => ({ p_id: B.ids.softDoc, p: { remark: "XF" } })),
    { label: "mixed: B's client", args: (A, B) => ({ p_id: A.ids.reviewedDoc, p: { client_id: B.ids.client } }),
      control: (A) => ({ p_id: A.ids.reviewedDoc, p: { client_id: A.ids.client } }) },
    { label: "mixed: B's type", args: (A, B) => ({ p_id: A.ids.reviewedDoc, p: { doc_type_id: B.ids.bankType } }),
      control: (A) => ({ p_id: A.ids.reviewedDoc, p: { doc_type_id: A.ids.bankType } }) },
    { label: "mixed: B's period", args: (A, B) => ({ p_id: A.ids.reviewedDoc, p: { period_id: B.ids.period } }),
      control: (A) => ({ p_id: A.ids.reviewedDoc, p: { period_id: A.ids.period } }) },
    { label: "mixed: B's registration", args: (A, B) => ({ p_id: A.ids.reviewedDoc, p: { doc_type_id: A.ids.gstType, registration_id: B.ids.registration } }),
      control: (A) => ({ p_id: A.ids.reviewedDoc, p: { doc_type_id: A.ids.gstType, registration_id: A.ids.registration } }) },
    { label: "mixed: B's staff receives", args: (A, B) => ({ p_id: A.ids.reviewedDoc, p: { received_by: B.users.staff.id } }),
      control: (A) => ({ p_id: A.ids.reviewedDoc, p: { received_by: A.users.staff.id } }) },
  ], control: (A) => ({ p_id: A.ids.softDoc, p: { remark: `${A.marker} remark 2` } }) },
  { fn: "create_document_for_item", kind: "write", attempts: [
    { label: "B's item", args: (_A, B) => ({ p_item: B.ids.adHocItem, p: { received_as: "hard_copy", channel: "hand_delivery", received_on: D, handed_over_name: "XF" } }) },
  ], control: () => ({ p_item: shared.aFileItem, p: { received_as: "hard_copy", channel: "hand_delivery", received_on: D, handed_over_name: "XF" } }) },
  { fn: "review_document", kind: "write", attempts: [B_("B's document", (B) => ({ p_id: B.ids.softDoc, p_outcome: "reviewed", p_reason: null, p_kind: null }))],
    control: (A) => ({ p_id: A.ids.softDoc, p_outcome: "reviewed", p_reason: null, p_kind: null }) },
  { fn: "undo_review", kind: "write", attempts: [B_("B's document", (B) => ({ p_id: B.ids.reviewedDoc, p_reason: "XF" }))],
    control: (A) => ({ p_id: A.ids.softDoc, p_reason: "XF" }) },
  { fn: "review_documents", kind: "write", attempts: [B_("B's documents", (B) => ({ p_ids: [B.ids.softDoc, B.ids.linkDoc] }))],
    control: (A) => ({ p_ids: [A.ids.softDoc] }) },
  { fn: "archive_document", kind: "write", attempts: [B_("B's document", (B) => ({ p_id: B.ids.softDoc, p_reason: "XF" }))],
    control: (A) => ({ p_id: A.ids.reviewedDoc, p_reason: "XF" }) },
  { fn: "unarchive_document", kind: "write", attempts: [B_("B's document", (B) => ({ p_id: B.ids.softDoc }))],
    control: (A) => ({ p_id: A.ids.reviewedDoc }) },
  { fn: "set_custody", kind: "write", attempts: [B_("B's hard copy", (B) => ({ p_ids: [B.ids.heldDoc], p_step: "ready" }))],
    control: (A) => ({ p_ids: [A.ids.heldDoc], p_step: "ready" }) },
  { fn: "undo_custody", kind: "write", attempts: [B_("B's hard copy", (B) => ({ p_id: B.ids.heldDoc }))],
    control: (A) => ({ p_id: A.ids.heldDoc }) },
  { fn: "create_dispatch", kind: "write", attempts: [
    B_("B's client + paper", (B) => ({ p: { client_id: B.ids.client, document_ids: [B.ids.readyDoc], dispatched_on: "2026-05-10", method: "hand_delivery", recipient_name: "XF" } })),
    { label: "mixed: A's client, B's paper", args: (A, B) => ({ p: { client_id: A.ids.client, document_ids: [B.ids.readyDoc], dispatched_on: "2026-05-10", method: "hand_delivery", recipient_name: "XF" } }) },
  ], control: (A) => ({ p: { client_id: A.ids.client, document_ids: [A.ids.readyDoc], dispatched_on: "2026-05-10", method: "hand_delivery", recipient_name: "XF" } }) },
  { fn: "undo_dispatch_item", kind: "write", attempts: [B_("B's dispatched paper", (B) => ({ p_document_id: B.ids.dispatchedDoc, p_reason: "XF" }))],
    control: (A) => ({ p_document_id: A.ids.dispatchedDoc, p_reason: "XF" }) },

  // ── expected items, reminders, links ───────────────────────────────────────────────────────────────────────────
  { fn: "waive_expected", kind: "write", attempts: [B_("B's item", (B) => ({ p_id: B.ids.laterExpected, p_reason: "XF" }))],
    control: (A) => ({ p_id: A.ids.laterExpected, p_reason: "XF" }) },
  { fn: "undo_waive_expected", kind: "write", attempts: [B_("B's item", (B) => ({ p_id: B.ids.laterExpected }))],
    control: (A) => ({ p_id: A.ids.laterExpected }) },
  { fn: "reopen_expected", kind: "write", attempts: [B_("B's received item", (B) => ({ p_id: B.ids.expected }))],
    control: (A) => ({ p_id: A.ids.expected }) },
  { fn: "record_follow_up", kind: "write", attempts: [
    B_("B's client + items", (B) => ({ p_client: B.ids.client, p_items: [B.ids.laterExpected], p_channel: "phone", p_on: null, p_note: null })),
    { label: "mixed: A's client, B's items", args: (A, B) => ({ p_client: A.ids.client, p_items: [B.ids.laterExpected], p_channel: "phone", p_on: null, p_note: null }) },
  ], control: (A) => ({ p_client: A.ids.client, p_items: [A.ids.laterExpected], p_channel: "phone", p_on: null, p_note: null }) },
  { fn: "begin_email_reminder", kind: "write", attempts: [
    B_("B's client + items", (B) => ({ p_client: B.ids.client, p_items: [B.ids.laterExpected], p_daily_max: 200 })),
    { label: "mixed: A's client, B's items", args: (A, B) => ({ p_client: A.ids.client, p_items: [B.ids.laterExpected], p_daily_max: 200 }) },
  ], control: (A) => ({ p_client: A.ids.client, p_items: [A.ids.laterExpected], p_daily_max: 200 }) },
  // review I-5: B's pending *email* follow-up (seeded), finished by A's Admin; control = A's own, just begun above
  { fn: "finish_email_reminder", kind: "write", attempts: [
    B_("B's pending email", (B) => ({ p_id: B.ids.emailFollowUp, p_status: "failed", p_provider_id: null, p_error_code: "XF" })),
  ], control: async (A) => ({ p_id: await pendingEmailOf(A), p_status: "failed", p_provider_id: null, p_error_code: "XF" }) },
  { fn: "record_link_whatsapp", kind: "write", attempts: [
    B_("B's client", (B) => ({ p: linkBody(B.ids.client, [adHoc(B)]) })),
    { label: "mixed: B's expected item", args: (A, B) => ({ p: linkBody(A.ids.client, [{ kind: "scheduled", expected_doc_id: B.ids.laterExpected }]) }),
      control: (A) => ({ p: linkBody(A.ids.client, [{ kind: "scheduled", expected_doc_id: A.ids.laterExpected }]) }) },
    { label: "mixed: B's type", args: (A, B) => ({ p: linkBody(A.ids.client, [adHoc(B)]) }) },
    { label: "mixed: B's period", args: (A, B) => ({ p: linkBody(A.ids.client, [adHoc(A, { period_id: B.ids.period })]) }),
      control: (A) => ({ p: linkBody(A.ids.client, [adHoc(A, { period_id: A.ids.period })]) }) },
    { label: "mixed: B's registration", args: (A, B) => ({ p: linkBody(A.ids.client, [adHoc(A, { doc_type_id: A.ids.gstType, registration_id: B.ids.registration })]) }),
      control: (A) => ({ p: linkBody(A.ids.client, [adHoc(A, { doc_type_id: A.ids.gstType, registration_id: A.ids.registration })]) }) },
    // review I-9: `replaces` reaches the definer private.insert_upload_request (moves items, revokes the old link)
    { label: "mixed: replaces B's request", args: (A, B) => ({ p: linkBody(A.ids.client, [adHoc(A)], { replaces: B.ids.request }) }),
      control: async (A) => ({ p: linkBody(A.ids.client, [adHoc(A)], { replaces: await liveRequestOf(A, A.ids.client) }) }) },
  ], control: (A) => ({ p: linkBody(A.ids.client, [adHoc(A)]) }) },
  { fn: "begin_link_email", kind: "write", attempts: [
    B_("B's client", (B) => ({ p: linkBody(B.ids.client2, [adHoc(B)]) })),
    { label: "mixed: B's expected item", args: (A, B) => ({ p: linkBody(A.ids.client2, [{ kind: "scheduled", expected_doc_id: B.ids.laterExpected }]) }) },
  ], control: (A) => ({ p: linkBody(A.ids.client2, [adHoc(A)]) }) },
  { fn: "retry_link_email", kind: "write", attempts: [B_("B's request", (B) => ({ p_request: B.ids.request, p_token_hash: hash(), p_daily_max: 200 }))],
    controlExempt: "retry needs a link whose email failed, and Firm A's one email per client per day is used by begin_link_email's control",
    expect: /NOT_FOUND/ },
  { fn: "cancel_request_item", kind: "write", attempts: [B_("B's item", (B) => ({ p_id: B.ids.adHocItem, p_reason: "XF" }))],
    control: () => ({ p_id: shared.aOpenItem, p_reason: "XF" }) },
  // reopen = a *received* item back to open: control on the item create_document_for_item's control filed
  { fn: "reopen_request_item", kind: "write", attempts: [B_("B's received item", (B) => ({ p_id: B.ids.adHocItem }))],
    control: () => ({ p_id: shared.aFileItem }) },

  // ── DSC ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  { fn: "dsc_reveal", kind: "write", attempts: [B_("B's DSC", (B) => ({ p_id: B.ids.dsc }))], control: (A) => ({ p_id: A.ids.dsc }) },
  { fn: "dsc_save", kind: "write", attempts: [
    B_("edit B's DSC", (B) => ({ p: { id: B.ids.dsc, holder_name: "XF" } })),
    { label: "new DSC on B's client", args: (_A, B) => ({ p: { client_id: B.ids.client, holder_name: "XF", expires_on: "2027-03-12", password_ct: "ktest.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.eGY" } }),
      control: (A) => ({ p: { client_id: A.ids.client, holder_name: "XF", expires_on: "2027-03-12", password_ct: "ktest.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.eGY" } }) },
    { label: "mixed: move A's DSC to B's client", args: (A, B) => ({ p: { id: A.ids.dsc, client_id: B.ids.client, holder_name: "XF" } }),
      control: (A) => ({ p: { id: A.ids.dsc, client_id: A.ids.client2, holder_name: "XF" } }) },
  ], control: (A) => ({ p: { id: A.ids.dsc, holder_name: `${A.marker} Holder 2` } }) },
  { fn: "dsc_custody_log", kind: "write", attempts: [B_("B's DSC", (B) => ({ p: { dsc_id: B.ids.dsc, direction: "in", person_name: "XF", on_date: "2026-05-03" } }))],
    control: (A) => ({ p: { dsc_id: A.ids.dsc, direction: "in", person_name: "XF", on_date: "2026-05-03" } }) },
  { fn: "dsc_archive", kind: "write", attempts: [B_("B's DSC", (B) => ({ p_id: B.ids.dsc, p_reason: "XF" }))],
    control: (A) => ({ p_id: A.ids.dsc, p_reason: "XF" }) },
  { fn: "dsc_unarchive", kind: "write", attempts: [B_("B's DSC", (B) => ({ p_id: B.ids.dsc }))], control: (A) => ({ p_id: A.ids.dsc }) },

  // ── catalogue decisions ─────────────────────────────────────────────────────────────────────────────────────────
  { fn: "approve_proposed_type", kind: "write", attempts: [
    B_("B's proposal", (B) => ({ p: { type_id: B.ids.proposedType } })),
    { label: "mixed: move into B's group", args: (A, B) => ({ p: { type_id: A.ids.proposedType3, edits: { doc_group_id: B.ids.otherGroup } } }),
      control: (A) => ({ p: { type_id: A.ids.proposedType3, edits: { doc_group_id: A.ids.otherGroup } } }) },
  ], control: (A) => ({ p: { type_id: A.ids.proposedType2 } }) },
  { fn: "reject_proposed_type", kind: "write", attempts: [B_("B's proposal", (B) => ({ p_type: B.ids.proposedType, p_comment: "XF" }))],
    control: (A) => ({ p_type: A.ids.proposedType4, p_comment: "XF" }) },
  { fn: "merge_proposed_type", kind: "write", attempts: [
    B_("B's types", (B) => ({ p_type: B.ids.proposedType, p_target: B.ids.bankType, p_comment: null })),
    { label: "mixed: A's proposal into B's type", args: (A, B) => ({ p_type: A.ids.proposedType, p_target: B.ids.bankType, p_comment: null }) },
  ], control: (A) => ({ p_type: A.ids.proposedType, p_target: A.ids.bankType, p_comment: null }) },
  { fn: "disable_client_group", kind: "write", attempts: [
    B_("B's client + group", (B) => ({ p_client_id: B.ids.client2, p_doc_group_id: B.ids.group })),
    { label: "mixed: A's client, B's group", args: (A, B) => ({ p_client_id: A.ids.client2, p_doc_group_id: B.ids.group }) },
  ], control: (A) => ({ p_client_id: A.ids.client2, p_doc_group_id: A.ids.group }) },
  // last: revoking A's link would stop later link cases
  { fn: "revoke_upload_request", kind: "write", attempts: [B_("B's request", (B) => ({ p_id: B.ids.request }))],
    control: (A) => ({ p_id: A.ids.request }) },
];

// Lookups for controls that need a row created earlier in the run (service role; setup only).
async function pendingEmailOf(A: Firm): Promise<string> {
  const { data } = await adminClient().from("follow_up").select("id").eq("office_id", A.office).eq("channel", "email")
    .eq("status", "pending").order("sent_at", { ascending: false }).limit(1).maybeSingle();
  return (data as { id: string } | null)?.id ?? "00000000-0000-0000-0000-000000000000";
}
async function liveRequestOf(A: Firm, client: string): Promise<string> {
  const { data } = await adminClient().from("upload_request").select("id").eq("office_id", A.office).eq("client_id", client)
    .is("revoked_at", null).is("replaced_by", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
  return (data as { id: string } | null)?.id ?? "00000000-0000-0000-0000-000000000000";
}
