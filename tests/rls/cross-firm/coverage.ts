// Feature 18 (spec X2, AC-2, AC-11): every table, view and function the database has, with the cross-firm case that
// proves Firm A's staff can't reach Firm B through it — or an exemption with a written reason. guard.test.ts compares
// this map with public.test_schema_inventory() and fails on any difference, like 08's permission matrix.
//
// Adding a table, view or function? Add its line here, and its case in sweep.test.ts / functions.ts, in the same PR.
// Case names point at sweep.test.ts: "tables:<shape>", "functions:<name>" (functions.ts), "links:<case>", "service-role".

export type Coverage =
  | { cases: string[] } // tested directly by these cases
  | { via: string[] } // a private definer reached only through these objects' cases (AC-11): "table:<t>" or "fn:<name>"
  | { exempt: string }; // why no cross-firm case applies (a reason of at least 20 characters)

const T = (...shapes: string[]): Coverage => ({ cases: shapes.map((s) => `tables:${s}`) });
const ALL = T("read", "write-B", "insert-B", "references");

/** Key = table or view name in public. */
export const TABLES: Record<string, Coverage> = {
  activity: ALL, client: ALL, client_contact: ALL, client_doc_type: ALL, client_dsc_setting: ALL, client_group: ALL,
  client_registration: ALL, dispatch: ALL, dispatch_item: ALL, doc_group: ALL, doc_type: ALL, document: ALL,
  document_custody: ALL, document_review: ALL, document_version: ALL, dsc: ALL, dsc_custody: ALL, expected_doc: ALL,
  financial_year: ALL, follow_up: ALL, follow_up_item: ALL, notification: ALL, period: ALL, staff_user: ALL,
  upload_request: ALL, upload_request_item: ALL, office: T("read", "write-B"),
  doc_counter: T("read", "write-B", "no-policy"), link_attempt: T("read", "write-B", "no-policy"),
  login_attempt: T("no-policy"), test_lane: T("no-policy"),
  doc_type_usage: T("view"),
  // 19: no policies (read and written only by the platform functions); "platform" = the super admin's doors in sweep.test.ts
  platform_access: T("read", "write-B", "no-policy", "platform"), platform_audit: T("read", "write-B", "no-policy", "platform"),
  platform_admin: T("platform"), // no office_id: staff read nothing (self-only policy), write nothing (no grant)
};

const F = (name: string): Coverage => ({ cases: [`functions:${name}`] });
const SVC = { cases: ["service-role"] } as Coverage;
const via = (...v: string[]): Coverage => ({ via: v });

/** Key = "<schema>.<name>" (the guard fails if a name is ever overloaded, so the key stays unique). */
export const FUNCTIONS: Record<string, Coverage> = {
  // public, callable by staff: one case each in functions.ts (AC-6–AC-8)
  ...Object.fromEntries([
    "activity_feed", "add_client_doc_type", "add_document_version", "add_financial_year", "approve_proposed_type",
    "archive_document", "begin_email_reminder", "begin_link_email", "cancel_request_item", "catalogue_metric",
    "chasing_metric", "collection_metric", "create_client", "create_dispatch", "create_document",
    "create_document_for_item", "create_proposed_type", "custody_metric", "disable_client_group",
    "document_last_activity", "dsc_archive", "dsc_custody_log", "dsc_due", "dsc_reveal", "dsc_save",
    "dsc_set_remind_days", "dsc_unarchive", "enable_client_group", "finish_email_reminder", "format_metric",
    "import_clients", "link_metric", "log_receipt", "mark_notifications_read", "merge_proposed_type",
    "preview_type_decision", "proposal_queue", "record_follow_up", "record_link_whatsapp", "reject_proposed_type",
    "reopen_expected", "reopen_request_item", "retry_link_email", "review_document", "review_documents",
    "revoke_upload_request", "run_expected_generation", "search_clients", "search_document_facets", "search_documents",
    "seed_test_activity", "seed_test_documents", "set_custody", "suggest_doc_types", "today_items",
    "unarchive_document", "undo_custody", "undo_dispatch_item", "undo_review", "undo_waive_expected", "update_client",
    "update_document", "waive_expected",
  ].map((n) => [`public.${n}`, F(n)])),

  // 19 — platform functions: refused for every staff member (functions.ts) and, for super admins, scoped to their own
  // window and firm kind ("platform:*" cases in sweep.test.ts)
  "public.my_access_state": F("my_access_state"),
  ...Object.fromEntries(["whoami", "firms", "create_firm", "record_first_admin", "invite_target", "suspend_firm",
    "reactivate_firm", "open_access", "close_access", "audit_list", "begin_reinvite", "signed_in"].map((n) => [`public.platform_${n}`,
    { cases: [`functions:platform_${n}`, "platform:callers"] } as Coverage])),
  ...Object.fromEntries(["clients", "client", "documents", "document", "expected", "activity"].map((n) => [`public.platform_${n}`,
    { cases: [`functions:platform_${n}`, "platform:callers", "platform:window"] } as Coverage])),

  // public, service role only: refused for anon and staff (AC-10); 10's link functions also tried with Firm B's items (AC-9)
  "public.link_open": { cases: ["service-role", "links:open"] },
  "public.link_ticket": { cases: ["service-role", "links:ticket"] },
  "public.link_register": { cases: ["service-role", "links:register"] },
  ...Object.fromEntries([
    "acquire_test_lane", "release_test_lane", "bootstrap_office", "custody_backfill", "expected_job_info", "format_label",
    "format_of_path", "orphan_objects", "purge_link_attempts", "reset_test_office", "test_seed_dsc",
    "test_seed_preferred_formats", "test_set_link_caps", "test_tenancy_probe", "test_schema_inventory", "test_platform_probe",
  ].map((n) => [`public.${n}`, SVC])),

  // private SECURITY DEFINER (AC-11): reached through the cases of the objects named
  "private.activity_client": via("table:activity", "fn:activity_feed"),
  "private.auto_waive": via("table:client_doc_type", "table:client_group", "table:client_registration"),
  "private.can_see_client": via("table:client", "table:document", "table:dsc", "fn:dsc_reveal", "fn:search_documents"),
  "private.check_assignee": via("table:client_doc_type", "table:client_group", "table:document"),
  "private.client_after_expected": via("table:client"),
  "private.client_before_write": via("table:client"),
  "private.client_doc_type_after_expected": via("table:client_doc_type"),
  "private.client_doc_type_before_write": via("table:client_doc_type"),
  "private.client_doc_type_period_guard": via("table:client_doc_type"),
  "private.client_group_after_expected": via("table:client_group"),
  "private.client_group_before_write": via("table:client_group"),
  "private.client_registration_after_expected": via("table:client_registration"),
  "private.close_stale_emails": via("fn:begin_email_reminder", "fn:begin_link_email", "fn:retry_link_email"),
  "private.contact_before_write": via("table:client_contact"),
  "private.current_office_id": via("table:client", "table:document", "fn:search_documents", "fn:today_items"),
  "private.current_staff_id": via("table:activity", "fn:create_document", "fn:review_document"),
  "private.doc_activity_ids": via("fn:activity_feed", "fn:document_last_activity"),
  "private.doc_type_after_mapped": via("table:doc_type", "fn:merge_proposed_type"),
  "private.doc_type_before_write": via("table:doc_type"),
  "private.document_after_link": via("table:document", "fn:create_document"),
  "private.document_after_request_item": via("table:document", "fn:create_document_for_item"),
  "private.document_before_write": via("table:document", "fn:create_document", "fn:update_document"),
  "private.document_soft_copy_check": via("table:document", "fn:create_document"),
  "private.document_version_after_insert": via("table:document_version", "fn:add_document_version"),
  "private.document_version_before_insert": via("table:document_version", "fn:add_document_version"),
  "private.expected_defer_end": via("fn:create_client", "fn:import_clients"),
  "private.finish_follow_up": via("fn:finish_email_reminder", "fn:begin_email_reminder"),
  "private.follow_up_activity": via("fn:record_follow_up", "fn:finish_email_reminder"),
  "private.generate_expected": via("table:client_doc_type", "fn:enable_client_group", "fn:run_expected_generation"),
  "private.generate_expected_for": via("fn:create_client", "fn:import_clients", "fn:enable_client_group"),
  "private.has_role": via("table:client", "fn:dsc_reveal", "fn:archive_document"),
  "private.insert_follow_up": via("fn:record_follow_up", "fn:begin_email_reminder", "fn:record_link_whatsapp"),
  "private.insert_upload_request": via("fn:record_link_whatsapp", "fn:begin_link_email"),
  "private.is_privileged": via("table:client", "table:document", "fn:disable_client_group"),
  "private.link_act_as": via("public.link_register"),
  "private.link_document_to_item": via("fn:create_document_for_item"),
  "private.link_fail": via("public.link_open", "public.link_ticket"),
  "private.link_ip_blocked": via("public.link_open", "public.link_ticket"),
  "private.link_item": via("public.link_ticket", "public.link_register"),
  "private.link_moved": via("fn:merge_proposed_type"),
  "private.link_request": via("public.link_open", "public.link_ticket", "public.link_register"),
  "private.link_unlinked_documents": via("fn:run_expected_generation", "fn:enable_client_group"),
  "private.match_expected": via("table:document", "fn:create_document", "fn:merge_proposed_type"),
  "private.notify": via("fn:reject_proposed_type", "fn:approve_proposed_type", "public.link_register"),
  "private.office_emails_today": via("fn:begin_email_reminder", "fn:begin_link_email"),
  "private.office_single_guard": via("table:office"),
  "private.office_today": via("fn:today_items", "fn:search_documents", "fn:dsc_due"),
  "private.recompute_expected": via("table:document", "fn:undo_waive_expected"),
  "private.recompute_request_item": via("table:document", "fn:create_document_for_item"),
  "private.registration_before_write": via("table:client_registration"),
  "private.restore_removed_items": via("table:client_doc_type", "table:client_group"),
  "private.restore_waived_items": via("table:client_doc_type", "table:client_registration"),
  "private.revoke_request": via("fn:revoke_upload_request"),
  "private.rotate_upload_token": via("fn:retry_link_email"),
  "private.run_office_expected": via("fn:run_expected_generation"),
  "private.set_request_item": via("fn:cancel_request_item", "fn:reopen_request_item"),
  // 19 — the platform checks, reached only through the platform functions' cases
  "private.require_platform_admin": via("fn:platform_whoami", "fn:platform_clients"),
  "private.platform_office": via("fn:platform_clients", "fn:platform_suspend_firm"),
  "private.platform_access_ok": via("fn:platform_clients", "fn:platform_document"),
  "private.platform_require_access": via("fn:platform_clients", "fn:platform_document"),
  "private.platform_log": via("fn:platform_open_access", "fn:platform_clients"),
  "private.platform_viewed": via("fn:platform_clients", "fn:platform_document"),
  "private.platform_email_clash": via("table:platform_admin", "table:staff_user"),
  "private.run_daily_expected": { exempt: "pg_cron only (runs as the owner, no caller): loops over real offices itself and calls run_office_expected per office, which run_expected_generation covers" },
  "private.purge_link_attempts": { exempt: "pg_cron only: deletes link_attempt rows older than 7 days across offices; takes no input and returns nothing" },
  "private.seed_catalogue": { exempt: "called only by service-role bootstrap_office and reset_test_office for the office they are given (17 and 02 tests)" },
  "private.seed_preferred_formats": { exempt: "called only by service-role bootstrap_office and test_seed_preferred_formats for the office they are given (17 and 11 tests)" },
};
