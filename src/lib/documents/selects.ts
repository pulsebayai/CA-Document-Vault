// PostgREST select lists for the document lists — shared by the app (queries.ts) and the nightly volume test
// (tests/rls/documents-perf.test.ts), so the test times exactly what the app runs (spec 03 NFR performance).

export const INBOX_SELECT = `id, doc_code, received_as, channel, remark, created_at,
  creator:created_by (full_name), current:current_version_id (file_name), client:client_id (name), doc_type:doc_type_id (name)`;

export const CLIENT_DOCUMENTS_SELECT = `id, doc_code, received_on, received_as, version_count,
  receiver:received_by (full_name),
  doc_type:doc_type_id (name, status, doc_group:doc_group_id (id, name, sort)),
  period:period_id (label, start_date, financial_year:financial_year_id (code)),
  current:current_version_id (id, mime_type),
  status, reviewed_at, correction_reason, reviewer:reviewed_by (full_name),
  packets:dispatch_item (removed_at, dispatch:dispatch_id (dispatched_on, method))`; // 07: review state + live packet
