# Spec: Review & dispatch
Intent: ./intent.md · Status: draft · Date: 2026-10-01
Screens:
- `references/mockup/10-client-documents.jpg`: row states "To review" / "Reviewed" / "Ready to dispatch" / "Dispatched", "reviewed <date> by <name>", **Mark dispatched**.
- `references/mockup/01-today.jpg`: **Mark reviewed** / **Mark dispatched** wording. The Today screen itself, its counts and its rows are 06.

## Key definitions
- **Review status** (stored on `document.status`): `received` (shown as **To review**) · `reviewed` · `needs_correction`.
  - Only **classified** documents (client + type) are reviewable. An Inbox document stays "In inbox" whatever its status.
- **Dispatch** (stored separately, not in `status`) = a **packet**: one client, the date it left, method, optional courier and tracking number, recipient. It holds ≥ 1 originals. A document is **dispatched** when it is in a packet and has not been removed from it.
  - Review status and dispatch are kept apart **on purpose**. An original that Needs correction can be dispatched (intent Q1) and must keep counting as *not received* for 04.
- **Shown state** (derived, never stored; first match wins):
  1. **Archived**;
  2. **In inbox** (not classified);
  3. **Dispatched <date> · <method>**;
  4. **Ready to dispatch**: original, status reviewed or needs correction, not dispatched;
  5. **Needs correction · <reason>**;
  6. **Reviewed <date> by <name>**;
  7. **To review**.
- **Held for N days** (originals only, not yet dispatched) = today (IST) − received on. It is shown, with no warning (intent Q5).
- **Counts as received for 04:** a linked document counts towards its expected item only if it is not archived **and not Needs correction**. Everything else in 04 is unchanged.

## User stories & acceptance criteria
**Review**
- AC-1 On a classified, non-archived document in To review or Needs correction, anyone who can see it can **Mark reviewed** (1 click). The status becomes `reviewed`, and the row shows "Reviewed <date> by <name>".
- AC-2 **Needs correction…** opens the shared Modal with a required reason (1–500 characters). Status becomes `needs_correction`. The row shows "Needs correction · <reason>". If this document completed an expected item, the item goes back to pending, and so Due/Overdue by its dates, **unless** another linked document still counts.
- AC-3 Marking a Needs-correction document reviewed (the client clarified, or the reviewer was wrong) is a normal review (AC-1). Its expected item becomes received again.
- AC-4 **What resets a review back to To review:**
  - **adding a new version** (03's "Replace file"). For a Needs-correction document, the upload dialog also asks for the corrected file's **received on** (default today, IST), which replaces the document's received on, so metric 1 uses the date the correct file arrived;
  - **changing client, type, period or registration** after review.

  Remark, channel or received-by edits don't reset it.
- AC-5 **Undo review** (Admin/Manager only, reason required): reviewed or needs correction → To review. Staff and Limited don't see the action, and the database refuses it.
- AC-6 Inbox (unclassified) and archived documents can't be reviewed. The UI hides the actions, and the database refuses them (`NOT_CLASSIFIED`, `ARCHIVED`).
- AC-7 Every review event is kept in an append-only **review history**: outcome, reason (for corrections and undos), who and when. It's shown on the document page, newest first. Nothing is overwritten or deleted.

**Dispatch**
- AC-8 On a Ready-to-dispatch original, **Mark dispatched** opens the dispatch dialog. It lists **all of that client's ready originals**, with this one ticked; others can be ticked too. The dialog asks for:
  - date dispatched (default today; not in the future; not before any ticked document's received on);
  - method (Courier · Hand delivery · Client collected · Other);
  - courier name and tracking number (optional; shown for Courier);
  - recipient name (required, ≤ 120 characters).

  Saving creates one packet, and each ticked original shows "Dispatched <date> · <method>".
- AC-9 Only originals that are classified, not archived, reviewed or needs correction, and not already dispatched can be put in a packet, all of the same client. Otherwise the save is refused with the reason, and the dialog re-lists the valid ones. **The client may be archived:** originals still go back.
- AC-10 **Undo dispatch** (Admin/Manager, reason required) removes one document from its packet. It goes back to Ready to dispatch. The packet keeps its history, shown as "1 of 3 removed"; a packet with all its items removed shows "Cancelled". Nothing is deleted.
- AC-11 Originals not yet dispatched show **"Held N days"** on their rows. Hard copies that aren't originals, and soft copies, never show dispatch state or actions.

**Where it shows**
- AC-12 **Client › Documents** (mockup 10): each received-document row shows its shown state, plus the next action for the user:
  - **Mark reviewed** (with a "Needs correction…" menu item) on To review and Needs correction;
  - **Mark dispatched** on Ready to dispatch;
  - dispatch text on Dispatched.

  Undo actions live on the document page only.
- AC-13 **Document page** (`/documents/[id]`): a Review panel (state, review history, actions incl. undo for Admin/Manager) and, for originals, a Dispatch panel (packet details: date, method, courier, tracking, recipient, who; Undo dispatch for Admin/Manager).
- AC-14 **`/documents` (03b):** the Status filter offers To review · Reviewed · Needs correction, with facet counts. A new **Return** filter offers Ready to dispatch · Dispatched (originals only). Result rows show the shown state. The new filter values are IDs/enums in the URL, as in 03b; no text goes in the URL.

**Access & audit**
- AC-15 Review and dispatch go through SECURITY INVOKER functions only; RLS applies.
  - Anyone who can **see** the document may review it or dispatch it, including Limited for their clients (intent decision).
  - The new tables have **no app write policies**, and direct `update document set status` is refused (03's "only the vault's functions write documents" rule, extended).
- AC-16 Activity, one row per action, IDs and codes only:
  - `document.reviewed`, `document.needs_correction`, `document.review_undone`;
  - `document.review_reset` (from AC-4, folded into the triggering save's row as a field, not a second row);
  - `dispatch.created` (client, document IDs, method);
  - `dispatch.item_removed`.

  Reasons, recipient names, courier names and tracking numbers live on their rows, **never** in `activity`.

## Functional requirements
- **Review functions** (invoker): `review_document(p_id, p_outcome 'reviewed'|'needs_correction', p_reason)`, `undo_review(p_id, p_reason)`. Each:
  - locks the document;
  - checks classified + not archived;
  - writes `document_review` + `document.status` (via a new transaction flag `app.doc_review`, which 03's `document_before_write` honours **only** for `status` and the review columns);
  - calls 04's recompute for the linked item;
  - writes activity.
- **Resets:** `add_document_version` and the dimension change in `update_document` set status back to `received` inside 03's trigger when the document was reviewed or needed correction. For a Needs-correction document, `add_document_version` accepts `received_on` and updates it.
- **04 change:** `recompute_expected` ignores linked documents whose status is `needs_correction`. The `document_after_link` trigger also fires on `status` changes. Matching (`match_expected`) itself is unchanged, so a Needs-correction document stays linked; it just doesn't count.
- **Dispatch functions** (invoker): `create_dispatch(p jsonb)` → one packet + items, atomic, all-or-nothing; `undo_dispatch_item(p_document_id, p_reason)`.
- **Search (03b):** both search functions gain a `return` filter (`ready` | `dispatched`). The Limited hint and everything else are unchanged. The TS validation (`DOC_STATUSES`, new `DOC_RETURNS`) and the filter ↔ URL mapping follow. **First cut if 07 runs long:** the Return filter; Today (06) lists ready originals anyway.
- **TS mirror:** `documentState(doc)` in `src/lib/documents/state.ts` implements the shown-state order above. 06 reuses it for Today. A unit test pins the order, and an RLS test checks that the SQL predicates for "to review" and "ready to dispatch" select the same rows.

## Non-functional requirements
- **Performance:**
  - review and dispatch actions < 300 ms server time;
  - the status/recompute work adds < 20 ms to a document save;
  - 03's documents-perf, 02's import and 04's expected checks stay green under **RUN_SLOW before merge**, because 07 changes 03/04 write paths (CLAUDE.md rule).
- **Security/privacy:**
  - RLS default-deny on `document_review`, `dispatch`, `dispatch_item`: select = can see the document's (or packet's) client;
  - `office_id` on every row; tenant-first in definer triggers; `search_path = ''`;
  - the recipient name is personal data: shown on screen only, never in URLs, logs or activity.
- **Accessibility:**
  - state as text, not colour alone;
  - dialogs use the shared Modal with labelled fields;
  - the "Needs correction…" menu is keyboard-reachable;
  - Client › Documents and the dispatch dialog work at ≤ 390 px (asserted).

## Data model changes (schema lock: 07)
- **Enum:** `document_status` += `reviewed`, `needs_correction` (03 left a comment for this). Existing rows stay `received` = To review (dev data only).
- **New columns on `document`:** `reviewed_by`, `reviewed_at`, `correction_reason` (the current state, for fast list rendering). The full trail is in `document_review`.
- **New table `document_review`** (append-only):
  - `id`, `office_id`, `document_id`, `outcome` (`reviewed` | `needs_correction` | `undone` | `reset`), `reason` (1–500, required for needs_correction/undone), `by`, `at`;
  - no update/delete (trigger), like `activity`.
- **New table `dispatch`:** `id`, `office_id`, `client_id`, `dispatched_on` date, `method` enum `dispatch_method` (courier, hand_delivery, client_collected, other), `courier_name` (≤ 100), `tracking_no` (≤ 60), `recipient_name` (1–120), `created_by`, `created_at`.
- **New table `dispatch_item`:**
  - `id`, `office_id`, `dispatch_id`, `document_id`, `removed_at`, `removed_by`, `removed_reason`;
  - **unique (document_id) where removed_at is null**: one live packet per original.
- **Changed:**
  - 03's `document_before_write` (the status gate + resets);
  - `add_document_version` (the optional `received_on` for corrections);
  - 04's `recompute_expected` + the `document_after_link` trigger column list;
  - 03b's two search functions (the `return` filter);
  - `reset_test_office` (purges the new tables for test offices).
- **Indexes:** `document (office_id, status)` where archived_at is null; `dispatch_item (document_id) where removed_at is null`; FK indexes (house rule).

## Existing code affected
- **SQL:** see "Changed" above. Each is covered by existing tests: 03 `tests/rls/documents*.test.ts`, 04 `tests/rls/expected*.test.ts`, 03b `tests/rls/document-search.test.ts`. They must all stay green unedited.
- **TS/UI:**
  - `src/app/(app)/clients/[id]/documents-view.tsx` (rows);
  - `src/app/(app)/documents/[id]/` (panels, version upload dialog);
  - `src/app/(app)/documents/(search)/search-view.tsx` + `src/lib/validation/document-search.ts` + `src/lib/search/queries.ts` (filter, state);
  - new `src/lib/documents/state.ts`, `src/lib/review/*`, `src/lib/dispatch/*`.

## Backward compatibility & data migration
- No real data exists (dev only), so existing documents simply start as To review. No back-fill of `document_review`.
- 06 is building in parallel under an additive-only exception and uses `documentState()` and the status values. **07 merges first**, then 06 rebases.

## API / interfaces
Server actions (POST; IDs in, plain errors out, logged with request ID only):
- `markReviewed(id)`, `markNeedsCorrection(id, reason)`, `undoReview(id, reason)`;
- `readyOriginals(clientId)` (for the dialog), `createDispatch(input)`, `undoDispatchItem(documentId, reason)`.

## UX flows & screens
- **Client › Documents row** (mockup 10):
  - left: "Received 2 Aug by Priya · DOC-…" + badges (Hard copy / Original);
  - right: state text, then the action button, then view/download.
  - "Mark reviewed" is a small secondary button with a "Needs correction…" overflow item. The mockup shows state text only on the client page; adding the button there is an agreed deviation for ui-reference.md (the intent's 1-click metric).
- **Dispatch dialog:**
  - a client heading, then the list of ready originals (type · period · DOC-ID · held N days) with checkboxes;
  - date, method (radio), courier fields (Courier only), recipient;
  - Save "Mark N dispatched".
  - Empty state: "No originals are ready to dispatch for this client."
- **Document page:** Review panel (state, history list, actions) and Dispatch panel (packet details, "Also in this packet: …").
- **Loading/error:** shared states; action errors show inline with Retry. A stale action (someone else already reviewed it) shows "Already reviewed by <name>" and refreshes.

## Test strategy
| AC | Test | Suite |
|---|---|---|
| 1–3, 5–7 | review/needs-correction/undo per role (Admin, Manager, Staff, Limited on own vs other client); Inbox/archived refused; history rows; direct `update … set status` refused | RLS/DB |
| 2–4 (metric honesty) | needs correction → expected item pending; mark reviewed → received again; corrected version → To review, received on = the version's date, item received with that date; dimension change resets review; another linked document keeps the item received | RLS/DB |
| 8–11 | packet created atomically; ineligible document (soft copy, To review, archived, other client, already dispatched) refuses the whole packet; archived client allowed; undo per item; one live packet per original; dates rule; held days | RLS/DB + unit |
| 12–14 | Client › Documents actions, dispatch dialog, document panels, `/documents` Status + Return filters (URL round trip; no text in URL), ≤ 390 px, axe | e2e + unit |
| 15–16 | no app write path to the new tables; activity rows carry no reason/recipient/courier/tracking text (the `ACTIVITY_PII` guard plus an explicit check) | RLS/DB |
| state | `documentState()` order; SQL "to review"/"ready" predicates = the TS ones on a fixture set | unit + RLS |
| NFR | RUN_SLOW: 03 documents-perf, 02 import, 04 expected volume checks unchanged; save overhead < 20 ms measured | RLS/DB (slow) |

All new tests join the regression suite. Smoke-safe for prod: none (all need sign-in and write data).

## Proposed architecture changes (07 doesn't hold the architecture lock, which is 06's; written to architecture.md on main at merge)
1. **Review history pattern:** state on the row for fast lists plus an append-only history table for reasons. This extends "free text lives on the entity, never in activity" to entities whose free text changes over time.
2. **Status gate:** `document.status` changes only through review functions (the `app.doc_review` flag). 03's trigger resets it on new versions and dimension changes.
3. **Counts as received** = linked, not archived, not Needs correction (amends 04's linking rule).
4. **Dispatch** = a packet entity per client. Originals return in packets; removing an item never deletes it.

## Risks & areas of concern
- **Changing 03/04 write paths** (the status gate, recompute) could slow saves or break linking. Mitigation: all existing RLS tests unedited, plus RUN_SLOW before merge, plus the save-overhead measurement.
- **Review resets annoying staff** (a typo fix in period resets the review). Accepted: changing *what* the document is (client/type/period/registration) is exactly what review checked. Remark/channel edits don't reset.
- **Received-on rewrite on correction** changes a date staff entered. Mitigation: only for Needs-correction documents, editable in the dialog, and recorded in the version's activity row.
- **06 parallel build:** 06 reads states via `documentState()`. If 07 changes the state order late, 06 rebases. Mitigation: the state order is fixed at this spec gate.

## Out of scope
Today counts and rows (06) · bulk mark reviewed (08) · acknowledgement emails · courier integrations and labels · reviewer assignment and queues · per-type checklists · the "Scanned" badge · a "held too long" warning.

## Decisions needed at this gate (my recommendation first)
1. **Review and dispatch are separate dimensions** (status = review only; dispatch = packet), not one status list. Recommend **yes**. One list would lose "needs correction" when a wrong original is dispatched, and 04 would count it as received.
2. **What resets a review** (AC-4): a new version, or a client/type/period/registration change. Recommend **yes, both**.
3. **A corrected version replaces received on** (Needs-correction documents only, default today, editable). Recommend **yes**: it makes metric 1 honest. The alternative keeps the old date and overstates on-time completeness.
4. **"Mark reviewed" button on Client › Documents rows**, a deviation from mockup 10, which shows text only. Recommend **yes** (intent metric 4).
5. **Recipient name required** on every dispatch, including Courier (the addressee). Recommend **yes**: it's the one fact staff need when a client says "we never got it".
6. **Return filter on `/documents`** (AC-14). Recommend **include**, as first cut if needed.
