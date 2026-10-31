# Spec: Hard-copy custody — "Document in office" and Log receipt
Intent: ./intent.md (approved 2026-10-31) · Status: **approved (Sidambara, 2026-10-31; S1–S5 as recommended)** · Date: 2026-10-31
Screens: mockup 10 (Client › Documents) + 13 (document page) + 02 (Inbox, now "Untagged documents") + 01 (Today) · `/documents` (03b) · new: Log receipt
Source decisions: intent Q1–Q6 (Sidambara 2026-10-31); Kushal review Q3, Q8 (+16:50), Sankar #6, #14.

## Decisions taken into this spec (confirm at this gate)
| # | Question | Answer in this spec |
|---|---|---|
| S1 | Q4 says "Mark in office requires Reviewed". Does **Needs correction** count? | **Yes: any review decision (Reviewed or Needs correction).** 07 lets a wrong original go back to the client while it is Needs correction; requiring "Reviewed" would make that impossible (it could never reach Ready). To review: no. |
| S2 | Must `create_dispatch` refuse a returnable copy that nobody marked Ready? | **The screens offer only Ready documents** (dispatch dialog, Today, filters). **The database still accepts** a reviewed returnable copy, and records the missing steps ("in office", "ready") with the dispatch, marked *implied*. This is the same legacy-input pattern as 12's `original` alias: 07's dispatch calls and ≈ 10 test files keep working unedited. Strict alternative: refuse (`NOT_READY`), and change every test that dispatches (≈ 10 files, each listed for approval). |
| S3 | Does undoing a custody step need a reason? | **No.** It is a correction of a click, logged with who and when. (Undo review needs a reason because it changes a decision about the file.) |
| S4 | Today | Adds two counts with rows: **"To place in office"** (reviewed hard copies not yet in office) and **"In office > 30 days"** (Q6). Without the first, a skipped click is invisible and Ready to dispatch goes stale (risk in the review plan). |
| S5 | Editing a document that is in custody | Changing **received as to soft copy** is refused while it is in office or ready ("Undo Document in office first"). Unticking **Returnable** is refused while it is Ready ("Undo Ready to dispatch first"). Client / type / period changes are allowed (the paper didn't move; the review resets as in 12). |

## User stories & acceptance criteria

### A. The custody steps
- **AC-1** Every **filed, non-archived hard copy** with a review decision (Reviewed or Needs correction, S1) can be **marked "Document in office"** by a click. Soft copies never can (link uploads included). To review and Untagged documents can't (`NOT_REVIEWED`, `NOT_CLASSIFIED`).
- **AC-2** A **returnable** document in office can be **marked "Ready to dispatch"**. A non-returnable one can't (`NOT_RETURNABLE`): for it, Document in office is the last step (the firm keeps it). Ready requires In office first (`NOT_IN_OFFICE`).
- **AC-3** Each step stores **who and when** on the document (`in_office_by/at`, `ready_by/at`) and adds a row to an append-only custody history. Each writes one activity row (IDs only): `document.in_office`, `document.ready`.
- **AC-4** **Undo** (S3: no reason): Ready → back to In office; In office → not placed. Logged (`document.custody_undone`, with the step undone) and kept in the history. Undo Ready is refused while the document is in a live dispatch packet (`DISPATCHED`, as 12's undo review). **Staff, Manager, Admin and Limited** (Q5, for clients they can see) may move and undo. Undo dispatch stays Admin/Manager (12).
- **AC-5** **A review reset keeps custody** (Q4): a new version or a details change sends the document back to To review, and its custody step stays. While it is To review again, it is not offered for dispatch (it shows To review); after the new review it shows its custody step again.
- **AC-6** Dispatch (07) needs **Ready**: the dispatch dialog lists only Ready documents of the client; Today's "Ready to dispatch" and the `/documents` filter count only Ready. API callers: S2. Undo dispatch returns the document to **Ready to dispatch**.
- **AC-7** Edits while in custody: S5 (refusals with plain messages; codes `CUSTODY_SOFT_COPY`, `CUSTODY_READY`). Archive keeps the custody step; an archived document shows Archived and can't be moved.
- **AC-8** **Shown state** (one TS function, `state.ts`, tested equal to SQL): Archived · Untagged · Dispatched · **Ready to dispatch** (returnable, custody Ready, Reviewed or Needs correction, not in a live packet) · Needs correction · **Document in office** (custody set, Reviewed) · Reviewed · To review. Ready no longer comes from returnable + reviewed alone.
- **AC-9** Where the steps are offered:
  - **document page:** a **Custody** panel for hard copies: the current step with who/when, the next action ("Mark in office" / "Ready to dispatch"), and Undo;
  - **row action** on Client › Documents and `/documents`: the next step after review ("Mark in office", "Ready to dispatch", then "Dispatch" as today);
  - **bulk** on `/documents` and Client › Documents (08's bulk bar): "Mark in office" and "Ready to dispatch", ≤ 200 documents, each done or skipped with a reason ("not reviewed", "soft copy", "not returnable", "already in office"…), summary as 08's bulk Mark reviewed.

### B. Held too long, Today and filters
- **AC-10** **In office > 30 days** (Q6, Sankar #14): a returnable document, not archived and not in a live packet, marked in office more than **30 days** ago (office date, India), counted from `in_office_at`. One office-wide number, not configurable in R1. It shows the badge "**In office N days**" (bad tone) on rows and the document page. 07's "Held N days" (from received on) stays as it is.
- **AC-11** **Today** (S4) adds, beside "To review" and "Ready to dispatch":
  - "**To place in office**": filed hard copies with a review decision and no custody step;
  - "**In office > 30 days**" (AC-10).

  Both count Mine (06's effective assignee) and Everyone, and open rows per client card like Ready to dispatch. "Ready to dispatch" counts stored Ready only.
- **AC-12** `/documents`: the "Return" filter becomes "**Custody**": To place · In office · Ready to dispatch · Dispatched, plus a checkbox "**In office over 30 days**". The facet counts each value. Old links (`return=ready`, `return=dispatched`) keep working.

### C. Log receipt (reception)
- **AC-13** A **Log receipt** screen (`/documents/receipt`), for every staff role that can add documents (no new role or permission, Q3). Reached from the Untagged documents page, the "Add document" area and Today. Fields:
  - **Client** (required; the same client search as Add document; Limited sees their clients);
  - **What came in** (Q2): the type-ahead Document type field from 12, optional; with a type, **Period** (optional) appears as in Add document;
  - **How many** (1–20, default 1);
  - **Handed over by** (required, 12's field, 1–120);
  - **Returnable** (12's checkbox, applies to all);
  - **Received on** (default today), **Channel** (default Hand delivery), **Remark** (optional).
- **AC-14** Saving creates **N hard-copy documents with no file** (Q1), each with its own DOC-ID, through 03's `create_document` in **one transaction** (all or nothing). With a type they are **filed** (and go to To review); without, they are **Untagged** with the client set. Each writes 03's own activity row; no new filing path.
- **AC-15** The confirmation lists each new document's **DOC-ID with the client code** ("C0042 · DOC-FY26-27-00123", Sankar #6) to write on the paper, with "Attach scan" (document page, Add version) per row and "Log another receipt". No second ID is created.
- **AC-16** Log receipt is usable at 390 px and passes axe; one paper takes ≤ 30 s for a Staff user (timed on staging, success metric 3).

### D. Migration (Q3)
- **AC-17** Existing documents keep what they show today:
  - live packet (Dispatched) → custody Ready;
  - returnable hard copy with a review decision, not dispatched (today shown Ready to dispatch) → custody Ready;
  - any other hard copy with a review decision → In office;
  - To review, Untagged, soft copies → unchanged (no step).

  `in_office_at` / `ready_at` = the document's `reviewed_at` (best known date), `*_by` = null (shown "set when custody started"). Archived documents get the same rule. No history or activity rows. Counts per step before/after are recorded in the PR (dev now; staging/prod at the replay). The shown state of every document is the same before and after (test).

### E. Metric and roles
- **AC-18** `custody_metric(from, to)` (Admin/Manager) on Settings › Collection: % of hard copies reviewed in the range that reached In office within 2 working days (success metric 1); median days Ready → Dispatched (metric 2); returnable documents now in office > 30 days. Migrated rows (no `*_by`) are excluded from the timing figures.
- **AC-19** Permissions matrix (08): two rows, each probed per role: "**Move a hard copy** (in office, ready)" and "**Undo a custody step**": all four roles (Limited: for clients they can see). 21 → 23 rows.

### F. Unchanged behaviour (regression)
- **AC-20** Everything in the intent's "must not change" holds: 07's review flow and history; 12's reset rules; dispatch packets (one live packet per document, recipient required, undo Admin/Manager); metric 1; soft copies and link uploads. The full suite stays green; the only test changes are those listed below, each approved before it is made.

## Functional requirements
- **One move function** `set_custody(p_ids uuid[], p_step text)` (`in_office` | `ready`), SECURITY INVOKER, ≤ 200 IDs, each in its own sub-transaction with a skip reason (08's `review_documents` pattern); the document page calls it with one ID. `undo_custody(p_id uuid)`.
- Custody columns change only inside these functions and `create_dispatch` (transaction flag `app.doc_custody`), like 07's `app.doc_review`.
- `log_receipt(p jsonb)` (invoker): validates, then calls 03's unchanged `create_document` N times; returns the IDs and DOC-IDs.
- `create_dispatch`: eligibility = filed, returnable, not archived, review decision taken, not in a live packet; sets missing steps as implied (S2).
- `search_documents` / `search_document_facets` (same signature): `return_state` from custody (`to_place | in_office | ready | dispatched`), `held` filter, row fields `custody`, `in_office_at`.
- `today_items`: `p_show` gains `to_place` and `held`; counts `to_place`, `held`; `ready` from stored custody.

## Non-functional requirements
- **Accessibility:** WCAG 2.1 AA; axe on Log receipt, the document page Custody panel, Today, `/documents` with the bulk bar.
- **Performance:** `today_items` and `search_documents` stay within today's timings on dev (no new per-row function call; office-first). Re-timed at volume with K3. Bulk 200 moves < 5 s (08's bulk review budget).
- **Privacy:** no new personal data. Handed over by stays on the entity (12). Activity: IDs and the step only.
- **Security:** no new definer function; role checks in SQL; every new matrix cell probed.

## Data model changes (schema lock)
- `create type custody_step as enum ('in_office', 'ready')`; `document.custody custody_step null`, `in_office_at timestamptz`, `in_office_by uuid → staff_user`, `ready_at`, `ready_by`.
- Checks: custody only on `received_as = 'hard_copy'`; `ready` only when `returnable`; `ready_at` set ⇔ custody = ready; `in_office_at` set ⇔ custody not null.
- `document_custody` (append-only history): office, document, `step` (`in_office | ready | undo_in_office | undo_ready`), `implied boolean`, actor, at. RLS like `document_review` (select iff the document is visible; writes only through the functions' flag).
- `document_before_write`: the S5 refusals; custody columns writable only under `app.doc_custody` (or the migration step).
- Migration data step (AC-17) with 12's pattern for archived rows (disable `document_before_write` for that statement, `set constraints all immediate` before re-enabling).

## Existing code affected
- **SQL:** new migration(s) replacing `create_dispatch`, `undo_dispatch` (back to Ready), `document_before_write`, `search_documents`, `search_document_facets`, `today_items`; new `set_custody`, `undo_custody`, `log_receipt`, `custody_metric`; `reset_test_office` if a new table needs it (cascade only).
- **TS:** `lib/documents/state.ts` (states, next action, in-office days), `lib/dispatch/*`, new `lib/custody/*` (actions, messages), `lib/search/*` + `validation/document-search.ts` (Custody filter), `lib/today/*`, `lib/bulk/actions.ts`, `lib/auth/permissions.ts`, `lib/activity-feed/catalogue.ts`.
- **Screens:** document page (Custody panel), `clients/[id]/document-row.tsx` + `documents-view.tsx` + `dispatch-dialog.tsx`, `documents/(search)/search-view.tsx`, `today/today-view.tsx`, `inbox/inbox-view.tsx` (Log receipt link), new `documents/receipt/`, Settings › Collection.

## Backward compatibility & data migration
- One transaction; dev first (md5 = file recorded), then staging/prod replay (schema fingerprint re-run).
- API callers of `create_dispatch` keep working (S2). Old `/documents?return=ready|dispatched` links work.
- Activity rows before the migration keep their wording.
- Rollback = a down-migration in the PR notes (drop the custody columns and table; restore the replaced functions from 12's migrations).

## UX flows & screens
- **Document page:** Custody card below Review: "Not in office yet · Mark in office" → "Document in office since 2 Nov by Priya · Ready to dispatch · Undo" → "Ready to dispatch since … · Undo" → Dispatch panel (07). Non-returnable: ends at "Document in office — the firm keeps it".
- **Rows:** state badge per AC-8; the next-step button; "In office N days" badge.
- **Log receipt:** single column form → Save → confirmation list (DOC-ID + client code, "Attach scan", "Log another receipt"). Loading and error states from `states.tsx`.
- New `ui-reference.md` deviation rows: Custody panel, Log receipt screen, Today's two counts, the Custody filter (the mockup has "Processing"; Q8 replaces it with Document in office).

## Test strategy
| AC | Unit | RLS (db) | e2e |
|---|---|---|---|
| 1–8 | `document-state.test.ts` (new states, order, next action) | `custody.test.ts` (each step and refusal, undo, reset keeps custody, S2 implied steps, S5, dispatch → Ready, undo dispatch → Ready, TS = SQL state) | `custody.spec.ts` (page: mark in office → ready → dispatch → undo; axe) |
| 9 | bulk result shaping | `custody.test.ts` (bulk skip reasons, 200 < 5 s) | `custody.spec.ts` (bulk on `/documents`) |
| 10–12 | `today-shape`, search filter parsing | `custody-today.test.ts` (counts, Mine/Everyone, 30-day boundary with the test clock), search filter + facet | `today-documents.spec` addition |
| 13–16 | form validation | `log-receipt.test.ts` (N documents, atomic, filed vs untagged, Limited client scope, handed over by required) | `log-receipt.spec.ts` (390 px, axe, confirmation) |
| 17 | — | `custody-migration.test.ts` (seeded states before → after on a test office) | — |
| 18 | — | `custody-metric.test.ts` | — |
| 19 | `permissions.test.ts` | `role-matrix.test.ts` (two rows, every cell) | — |

**Existing tests that change (requirement change: Ready is stored, not derived; each listed in plan.md for approval):** tests that expect a merely reviewed returnable copy to *show or count* as Ready to dispatch: [Likely] `document-state`, `search-review`, `today-shape`, `today-view`, `dispatch-dialog` (unit); `review-dispatch`, `today-documents`, `returnable` (RLS); `review-dispatch.spec`, `today-documents.spec` (e2e). They add "mark in office / ready" to their setup. Tests that only *dispatch* stay unedited (S2).

**RUN_SLOW:** changes 03's filing trigger and 07's rules. Owner's standing deferral (2026-10-31): the full RUN_SLOW Regression runs after 13–16, before staging.

## Proposed architecture changes (architecture + schema locks)
1. **Custody is a stored dimension** beside review and dispatch: `document.custody` (in office · ready) + append-only `document_custody`; changed only by its functions (`app.doc_custody`). Ready to dispatch becomes stored (supersedes 07's derived Ready).
2. Shown-state order gains "Document in office"; Ready requires stored custody.
3. `create_dispatch` implied-steps rule (S2), as a documented legacy-input exception.
4. Log receipt = one invoker function looping 03's `create_document` (one filing path).
5. Today gains `to_place` / `held`; Settings › Collection gains `custody_metric`.

## Risks & areas of concern
- **Extra click per hard copy** (Q8): mitigated by bulk actions and Today's "To place in office".
- **K3:** `today_items` grows again. Mitigation: office-first, no per-row helper; re-timed with K3.
- **Test churn:** ≈ 10 files assert derived Ready. Mitigation: S2 keeps dispatch calls unedited; each change listed and approved.
- **14 runs in parallel** (batch I): no shared tables; possible overlap in `permissions.ts`, `today_items` (DSC reminders) and the activity catalogue. Checked at the parallel planning checkpoint.

## Out of scope
Physical location (cabinet/shelf) · labels/barcodes · client notifications on Ready (16) · trash bin · DSC (14) · per-client "held" days.
