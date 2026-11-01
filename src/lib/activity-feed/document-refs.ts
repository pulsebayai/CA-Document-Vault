// Feature 15 (spec risk 2). A document's activity = rows about the document itself (entity_type 'document') plus rows
// whose data names it: `data.document_id` or `data.document_ids`. These are the actions that write such references;
// tests/unit/document-refs.test.ts keeps the list exact against the migrations. Adding one means checking that
// private.doc_activity_ids (and so activity_feed's document filter and document_last_activity) finds it.
export const DOCUMENT_REF_ACTIONS: readonly string[] = Object.freeze([
  "dispatch.created",
  "dispatch.item_removed",
  "upload_request_item.filed",
]);
