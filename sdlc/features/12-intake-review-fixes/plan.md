# Plan: Intake and review fixes from the Kushal review
Spec: ./spec.md (approved 2026-10-30) · Status: **approved (Sidambara, 2026-10-30 09:59 IST; R1 + R2 as proposed)** · Date: 2026-10-30
Branch: `feat/12-intake-review-fixes` · Locks: **schema + architecture → 12** (from step 0) · RUN_SLOW before merge: **yes**

## Two refinements found while planning (approved 2026-10-30 09:59: R1 and R2 as proposed; spec AC-14 and AC-23 amended)
**R1. Q3 "any save resets Needs correction" would also clear it on a remark.** Staff use the remark to log follow-ups ("Called client for the signed copy"). Under Q3 as written, that note sends the document back to To review while the correction is still missing. The existing test "remark, channel or received-by edits don't reset" (`review-dispatch.test.ts:263`) protects exactly this. **Proposed rule:**
- the reset depends on the correction kind;
- **Wrong details:** a change to client, type, period, registration, received as, Returnable, received on or handed over by resets to To review;
- **Wrong file:** a new version resets it (as today);
- a **remark, channel or received-by change never resets** a Needs-correction document;
- Needs correction marked before 12 (no kind): today's rules.

This keeps that test unedited. Alternative: Q3 as approved (the test changes, and remark notes clear corrections).

**R2. "Handed over by is required" is enforced by the app, not the database.** A database rule would refuse every existing caller that creates a hard copy without it: about 15 test helpers, and 09's volume seed. **Proposed rule:**
- the server action refuses to save a new hard copy, or a change to hard copy, without it (spec AC-14 for every staff screen);
- the database enforces the shape: both fields or neither, length, never on a soft copy, can't be cleared once set.

It is an informational field, not an access rule, so app-level enforcement is acceptable here.

**Legacy input rule (keeps most tests unedited, spec AC-10):** when a caller sends `received_as` **without** `returnable`, the meaning is the old one: `original` → hard copy + returnable; `hard_copy` / `soft_copy` → not returnable. A call that sends `returnable` uses it as given.

## Files that change
**Migrations (new):**
- `supabase/migrations/2026103xxxxxxx_intake_fixes_a.sql`: enums `handed_over_kind`, `correction_kind`; `document.returnable`, `handed_over_kind`, `handed_over_name`, `correction_kind`; `document_review.correction_kind`; checks; the data step (original → hard copy + returnable, counts raised as a notice); `document_before_write` (legacy rule, handed-over shape, returnable lock, R1 reset rule); `create_document` / `update_document` (new keys); grants.
- `…_intake_fixes_b.sql`:
  - `review_document(p_id, p_outcome, p_reason, p_kind default null)`;
  - `undo_review` (Staff+);
  - `create_dispatch` (returnable);
  - `search_documents` / `search_document_facets` (`returnable` filter; legacy `as=original`; return state);
  - `today_items` (returnable);
  - `search_clients` (`p_mine`).

  Each is copied from its latest definition and changes only marked lines.

**Server / lib:**
- `src/lib/validation/document.ts` (RECEIVED_AS = 2 options + legacy, HANDED_OVER_KINDS, rules);
- `src/lib/documents/state.ts` (`isReturnable` = returnable or legacy `original`);
- `src/lib/documents/actions.ts`, `queries.ts`, `selects.ts` (new columns, aliases in `typesForClient`, Inbox fields);
- `src/lib/types/match.ts` (**new**, `matchTypes`);
- `src/lib/review/*` (kind), `src/lib/dispatch/*` (returnable);
- `src/lib/search/queries.ts`, `src/lib/validation/document-search.ts` (Returnable filter, `PAGE_SIZE_UI = 20`);
- `src/lib/today/shape.ts`;
- `src/lib/clients/queries.ts`, `src/lib/validation/client-search.ts` (`mine`);
- `src/lib/auth/permissions.ts` (split row), `src/lib/activity-feed/catalogue.ts`.

**Screens / components:**
- `src/components/type-combobox.tsx` (**new**);
- `documents/new/document-form.tsx` (type field, received as, Returnable, handed over by, confirmation line);
- `inbox/inbox-view.tsx`;
- `documents/[id]/page.tsx`, `review-panel.tsx`, `document-controls.tsx`;
- `components/action-dialog.tsx` (correction kind);
- `clients/[id]/documents-view.tsx` (pages per card), `document-row.tsx` (Edit, Returnable badge), `dispatch-dialog.tsx`;
- `documents/(search)/search-view.tsx`, `documents/file-buttons.tsx` (reused);
- `today/today-view.tsx`;
- `clients/clients-browser.tsx`, `clients/clients-view.tsx`;
- `settings/users/page.tsx` (two rows).

**Docs:** `sdlc/product/architecture.md` (6 items, lock holder), `sdlc/product/references/ui-reference.md` (deviation rows), feature docs.

**Tests (new):**
- unit: `tests/unit/type-match.test.ts`, `type-combobox.test.tsx`, `handed-over-rules.test.ts`;
- RLS: `tests/rls/returnable.test.ts`, `handed-over.test.ts`, `correction-kind.test.ts`, `clients-mine.test.ts`;
- e2e: `tests/e2e/document-type-field.spec.ts`, `intake-fixes.spec.ts` (Inbox View/Download, hard copy + handed over, Wrong details → Edit → To review, 20/page, client pages, My clients).

**Existing tests that change: requirement changes, each for approval** (the full list; nothing else is edited):

| File:line | Today asserts | Becomes | Why |
|---|---|---|---|
| unit `document-rules.test.ts:120` | labels Soft copy, Hard copy, Original | Soft copy, Hard copy | AC-8 |
| unit `today-view.test.tsx:91` | badge "Original" | "Returnable" | AC-11 |
| unit `permissions.test.ts` | one row "Undo a review or a dispatch" | two rows | AC-24 |
| RLS `role-matrix.test.ts:81` | probe `undo_review_dispatch` | probes `undo_review` (Staff yes) + `undo_dispatch` | AC-24 |
| RLS `review-dispatch.test.ts:127` | Staff and Limited can't undo a review | Limited can't; Staff can | AC-24 (Q4) |
| RLS `review-dispatch.test.ts:353` | finds originals by `received_as = 'original'` | by `returnable = true` | AC-9 |
| RLS `review-dispatch.test.ts:396` | row still `received_as: original` | `hard_copy` + `returnable: true` | AC-9/10 |
| RLS `documents.test.ts:306` | stored `received_as` = original | hard copy + returnable | AC-10 |
| RLS `document-search.test.ts:345, 352` | facet values `original: 1` | `hard_copy` counts | AC-13 |
| RLS `today-documents.test.ts:99` | row `received_as: original` | `hard_copy` + `returnable: true` | AC-11 |
| e2e `client-documents.spec.ts:58` | row text "Original" | "Returnable" | AC-11 |
| e2e `today-documents.spec.ts:42` | row text "Original" | "Returnable" | AC-11 |

If R1 is rejected, `review-dispatch.test.ts:274–279` joins this list. No other existing test changes. Calls that create originals, `as=original` URLs and TS state inputs keep working through the legacy rules.

## Migrations
Two files (A then B), applied to dev through the CLI / SQL editor with md5 = file recorded in the PR. Then Regression `only` = the RLS files (CLAUDE.md rule), and the schema fingerprint re-run. The down-migration text goes in the PR notes.

## Steps
- [x] 0. **Setup.** (roadmap PR #12 open, docs-only; branch pushed) Branch from main; commit intent/spec/plan; roadmap PR on main (rows 12–15, locks → 12, pilot date); take the locks. — proof: roadmap PR merged (docs-only CI)
- [x] 1. **Failing tests first (RLS + unit)** for AC-8–16, 21–24, 27: `returnable`, `handed-over`, `correction-kind`, `clients-mine`, and the changed rows above. — proof: they fail for the expected reason on dev
- [x] 2. **Migration A** (schema, data step, trigger, create/update). — proof: step-1 RLS files for A pass on dev; the documents / review-dispatch / type-governance / link files pass unedited
- [x] 3. **Migration B** (review kind, undo, dispatch, search, today, clients). — proof: all step-1 RLS files pass; role-matrix, document-search, today-documents and upload-link RLS files green
- [x] 4. **Lib layer** (validation, state, review, dispatch, search parse, permissions, activity sentences, today shape). — proof: unit suite green; `document-state` / `today-shape` / `dispatch-dialog` unedited
- [x] 5. **Type field:** `matchTypes` + `type-combobox` (ARIA, keyboard, cap, close matches, propose) + aliases loaded. — proof: `type-match` + `type-combobox` unit; benchmark 500 types < 16 ms
- [x] 6. **Document form:** type field in; received as + Returnable + handed over by; confirmation line; Assign / Edit pages. — proof: unit form tests; e2e `document-type-field.spec` locally
- [x] 7. **Inbox + file buttons + Edit entry points** (Inbox, `/documents`, Today, client rows, Needs-correction message). — proof: e2e `intake-fixes.spec` (Inbox part) locally
- [x] 8. **Needs correction kind** (dialog, panel text, matching action). — proof: unit `review-actions`; e2e Wrong details → Edit → To review
- [x] 9. **Lists:** `/documents` 20/page + Returnable filter; Client › Documents pages per card. — proof: e2e parts locally
- [x] 10. **My clients** (toggle, default on for Staff, URL flag). — proof: `clients-mine` RLS + `clients-list` timing; e2e part
- [ ] 11. **Docs:** architecture.md (6 items + superseding decision row), ui-reference deviations; Settings › Users rows. — proof: review
- [ ] 12. **Full verification:** lint, typecheck, unit, RLS (dev), new/changed e2e locally; push → PR CI; **RUN_SLOW** Regression on the branch preview (asked before dispatch); `sdlc-reviewer`; fix Important findings failing-first → PR with the AC table. — proof: CI green + RUN_SLOW green + AC table

## Risks
- **Replacing about 10 functions at once** (03/07/10 paths). Mitigation: copy the latest body, diff old vs new per function in the PR, RUN_SLOW, schema fingerprint vs dev after apply.
- **Data step on dev** touches the test lanes' fixture offices. Mitigation: it runs inside migration A, which is idempotent (`where received_as = 'original'`); nightly fixtures that create originals go through the legacy rule.
- **The nightly is red now** (run 40975613618, RLS, cause unknown). Mitigation: the user checks the log in another session. 12 does not merge while the nightly is red for an unexplained reason.
- **K3:** `search_clients` change. Mitigation: `p_mine` only adds a narrowing `exists`; `clients-list` timing test; re-time at volume with K3.
- **Supabase MCP writes have been cancelled before** (handoff). Fallback: Raja / Sidambara apply migrations in the dashboard SQL editor; md5 check either way.
- **Rollback:** the down-migration restores `original` from `returnable` and drops the new columns. The UI reverts with the PR revert.

## Proof of done
- Spec AC-1…29, each mapped to a test in the PR table.
- The full suite green in PR CI; RUN_SLOW green on the preview.
- Only the tests in the table above changed.
- On dev: returnable count = original count before; the schema fingerprint diff shows only 12's objects.

## Estimate
[Uncertain] 5–7 working days incl. review (about 4–5 build sessions). Feature 13 starts after merge (it builds on Returnable); 14 can be planned in parallel.

## Changes after Sankar's comments (decided 30 Oct 15:04, D1–D4; to approve with the test list below)
- **Migration C** (`2026103011xxxx_intake_fixes_c.sql`):
  - drops `document.handed_over_kind`, its type and the pair check;
  - replaces `document_before_write`, `create_document` and `update_document` again (only the handed-over lines change).
  - Applied on dev like A and B (md5 = file).
- **New 12 tests that change** (written this week, now with a changed requirement):
  - `handed-over.test.ts`, `handed-over-rules.test.ts`: the kind goes, the name stays;
  - `type-match.test.ts`: heading "Other types" → "Not in existing category plan".
- **"Inbox" → "Untagged documents" (D2): existing tests that assert the visible word "Inbox"** (route `/inbox` unchanged):
  - e2e: `inbox.spec.ts` (18 mentions), `search.spec.ts` (4), `document-screenshots.spec.ts` (4), `add-document.spec.ts` (1);
  - unit: `document-form-client-race.test.tsx` (7), `header-search.test.tsx` (2), `search-view.test.tsx` (2), `search-review.test.tsx` (1), `permissions.test.ts` (1, the row label "Add documents and file the Inbox").

  Only the visible label in each assertion changes; no check is removed.
- [Uncertain] +½–1 day for C and the rename.

## Deviations from plan
- **Migration A data step (step 2):** the first apply on dev failed (`55006 pending trigger events`) and rolled back cleanly. 03's deferred soft-copy check queued events, and 03's trigger refuses changes to archived documents. Fix in the file: `document_before_write` is disabled for the one data statement, then `set constraints all immediate`, then re-enabled. Applied on dev 2026-10-30: 136 originals → 136 returnable hard copies, 0 left.
- **Migration B** needed the user's confirmation in the Supabase tool (it drops and recreates `review_document` / `search_clients`); applied on dev 2026-10-30 11:1x after confirmation. **md5 = file for all 10 replaced functions.**
- **New test corrected (never green before):** `returnable.test.ts` "a direct write of 'original' is refused" → "is never stored as 'original'". The trigger maps legacy input on every path, so a direct write lands as hard copy + returnable (AC-10 holds). Not a weakening of an existing test.
- **Two more existing assertions found (pending approval):**
  - `document-search.test.ts:249` asserts a search row's `received_as: "original"`. It's the same kind as the 12 approved rows.
  - `review-actions.test.ts:45` asserts "Undo is Admin/Manager only" with a Staff user. AC-24 changes this, as in the approved `review-dispatch.test.ts:127`.

  Both are left unedited until approved.
- **Migration C** (D1: one "Handed over by" field) applied on dev 2026-10-30 ≈ 15:15 after the user confirmed in the Supabase tool; md5 = file for `document_before_write`, `create_document`, `update_document`; `handed_over_kind` column and type gone.
- **More existing tests changed for D2 (approved by the user 2026-10-30, after 15:09):** label-only, beyond the list above: `document-form-hydration.test.tsx` ("Save to inbox" ×2), `document-state.test.ts` ("In inbox"), `selection-bar.test.tsx` ("(in inbox)" ×2, "— in inbox"), `today-view.test.tsx` ("4 In inbox"). Step 4's proof "document-state unedited" therefore holds for the returnable logic only. Also approved: one "Handed over by" fill line in the three e2e tests that save a new hard copy through the form (`add-document.spec` ×2, `inbox.spec` ×1), added in step 6.
- **Type field changes how existing tests pick a type (approved by the user 2026-10-30):** a `<select>` became a combobox. Only the pick/read step changed (type the name, pick the option; the field shows the name): e2e `add-document` ×4, `inbox`, `expected`, `format-preferences`, `document-screenshots`, `upload-link-today`, `upload-link-requested`; unit `document-form-client-race` ×3. New helpers `pickType` / `typeFieldValue` in `tests/e2e/helpers.ts`. The listbox is named "Matching types" so `getByLabel("Document type")` still finds only the field.
- **Step 7 test edits (approved by the user 2026-10-30/31):** `vi.mock("@/lib/documents/actions")` setup line in `search-view`, `search-review`, `today-view` unit tests (the rows now render 03's FileButtons); `search-view.test.tsx:84` and e2e `search.spec.ts:140` name the document link (rows also have Edit, AC-19); e2e `review-dispatch.spec.ts:129` — Staff sees no "Undo dispatch" and does see "Undo review" (AC-24, the e2e twin of the approved RLS row).
- **Step 8 test edits (approved by the user 2026-10-31):** e2e `review-dispatch.spec.ts` — the Needs-correction flow ticks "Wrong details" before saving (one added line) and the row text on lines 85 and 190 includes the kind ("Needs correction · wrong details · …"). The "Give a reason" check is unchanged: the reason is still checked first.
- **Race found and fixed in code (step 8):** `review-dispatch` AC-4 failed once on the local build: the "Corrected file received on" date typed before the page was interactive was reset to today by hydration, so the corrected file kept the wrong date. `NewVersion` now disables its date and file inputs in server HTML and during hydration (as 03's form does). Then green twice in full runs; the test is unchanged.
- **Kind is required in the dialog, optional on the server:** `markNeedsCorrection` still accepts a call without a kind (07's callers, bulk paths); the dialog refuses to save without one.
- **Steps 9–10 test edits (approved by the user 2026-10-31):** unit `search-actions.test.ts` ×2 (`page_size: 20` in the search_documents arguments), `search-view.test.tsx:143` ("Page 2 of 3" → "21–40 of 120"); e2e `clients.spec.ts` AC-7 opens `/clients?mine=0` and line 74 accepts `/clients` or `/clients?mine=0` (Staff start on My clients); e2e `expected.spec.ts` AC-15 switches My clients off and checks the URL is unchanged by the Has overdue click (was: no query string).
- **Returnable filter is a checkbox ("Returnable only")**, not a select: a combobox named "Returnable" also matched the existing "Return" select in `review-dispatch` AC-14 (Playwright names match by substring). Like "Include archived"; URL flag `returnable=1`.
- **My clients URL flag** is written with `history.replaceState` (Next keeps the router in step); the list comes from the server action as before. `?mine=1` / `?mine=0` only when different from the role's default.
- **AC-28 timing (dev, 1,000 clients, median of 5 warm calls):** plain 293 ms · My clients 360 ms · My clients + search 293 ms — all within 02's 1 s budget; the toggle adds ≈ 70 ms (≈ 20 %), so "no slower" holds against the budget, not to the millisecond. New check in `clients-mine.test.ts`; re-time at volume with K3.
- **Screenshot e2e near the limit from the session:** `screenshots` and `expected-screenshots` timed out once at 30 s and passed on rerun at 29–30 s (session-to-Mumbai latency, like add-document AC-1); PR CI runs on a local stack.
- **`matchTypes` speed:** the 500-type check failed on its first full run (localeCompare with options builds a collator per call). Fixed in the code: one shared `Intl.Collator` + normalised text cached per type object; ≈ 1.6 ms per search (budget 16 ms). The test is unchanged.
- **File buttons on lists** use one RLS lookup per page (`currentFiles`, batches of 100, best effort like Today's Upload links) instead of changing `search_documents` / `today_items`: no migration. Header suggestions don't load files.
- **Untagged subtitle link** is underlined: axe `link-in-text-block` failed locally on the first run.
- **Legacy URL `as=original`** is accepted by `parseDocumentSearchParams` (AC-13), so `document-search.test.ts` (unit) stays unedited.

## Session log
### 2026-10-30
- Done: intent (approved 09:49), spec (approved 09:53), pilot date signed off by Sidambara; plan drafted.
- In progress: plan gate.
- Blocked / failing: nightly 40975613618 red (RLS); the user checks the log in another session.
- Next step: plan approval → step 0.
- Decisions made (cross-cutting → flag for architecture.md): the 6 architecture items in spec; R1/R2 if approved.

### 2026-10-30 (build session 1)
- Done: steps 0–3. Roadmap PR #12 open. Failing tests first (step 1). Migrations A + B applied on dev (B after the user confirmed in the Supabase tool), md5 = file for all 10 functions. New RLS files 35/35 green. Affected existing RLS files green except the TS/SQL state cross-check (step 4) and document-search:249 (approval).
- In progress: step 4, lib layer. Done so far:
  - `state.ts` (`isReturnable`, correction kind text);
  - Today shape + badge;
  - permissions split, `canUndoReview`;
  - review actions (kind, Staff undo) and messages;
  - validation (2 options + legacy, `HANDED_OVER_KINDS`, `validateHandedOver`, returnable);
  - search URL legacy `as`.

  Unit tests: everything green except type-match (module = step 5) and review-actions:45 (approval).
- Blocked / failing: nightly 40975613618 (RLS, cause under investigation by the user). Until 12 merges, nightlies also fail the approved 'Original' assertions, now that A + B are on dev (user accepted).
- Next step: approval of the 2 extra test rows. Then the remaining step 4 (query selects: returnable / handed over / correction kind; dispatch ready list; document page + inbox labels), then step 5 (type field).
- Decisions made (cross-cutting → flag for architecture.md): migration data steps that touch archived documents disable `document_before_write` for that statement + `set constraints all immediate` (pattern to note).

### 2026-10-30 (build session 1, continued)
- Done: migration C on dev (md5 = file); D1 tests + `validateHandedOver` (one field); step 4 (selects/mappers carry returnable, handed over by, correction kind; `paperBadge`; document page Dispatch card follows returnable; Untagged page title/subtitle with Today › To review (N); visible "Inbox" → "Untagged" everywhere, route kept); step 5 (`matchTypes`, `TypeCombobox`, aliases + group order loaded). Unit suite 55 files green; RLS handed-over / correction-kind / returnable 31/31 on dev.
- In progress: step 6 (the combobox replaces the type `<select>` in the document form).
- Blocked / failing: step 6 changes how existing tests pick a type (a `<select>` becomes a combobox) — not on the approved list; asked.
- Next step: step 6 after the answer.
- Later the same day: step 6 done. Server actions require "Handed over by" for a new hard copy (and on a change to hard copy) and send `returnable` + `handed_over_name`; the form has the type-ahead field, Returnable, Handed over by and the "Moves from … to …" line (AC-20); the document page shows "Not recorded". Unit 565/565; changed e2e run locally against a production build: 45/45 green (add-document AC-1 took 27–28 s of its 30 s limit from the session; dev latency, watch in CI). Next: step 7 (Untagged file buttons + Edit entry points).

### 2026-10-31 (build session 1, continued)
- Done: step 7. View / Download (03's FileButtons, same rules) on Untagged rows, `/documents` rows and Today's To review rows; "No file yet" for a hard copy without a file. Edit on Client › Documents rows (returns to the client), `/documents` rows and the Needs-correction message ("Edit details"). New e2e `intake-fixes.spec.ts` 5/5 locally; inbox, search, client-documents, today-documents, today, bulk, review-dispatch, upload-link-review green locally. Unit 565/565.
- Next step: step 8 (Needs correction kind: dialog, panel text, matching action).
- Later: step 8 done. Needs correction asks "What is wrong?" (Wrong file / Wrong details, none preselected) + reason; the review panel offers the matching action first (Wrong file → "Upload corrected file" → Current file; Wrong details or no kind → "Edit details"). New unit `correction-kind-dialog.test.tsx` (3); e2e `intake-fixes.spec.ts` now 7 (+ Wrong file order; Wrong details → Edit → received-on change → To review with a reset row). Unit 568/568; review-dispatch (×2), client-documents, today-documents, upload-link-review, format-preferences green locally.
- Next step: step 9 (/documents 20 per page + Returnable filter; Client › Documents pages per card).
- Later: steps 9–10 done. `/documents` 20 per page with "N–M of T" (page_size 20; SQL default/cap stay 50) and "Returnable only"; Client › Documents cards newest received first, 20 per page with Previous / Next and "N–M of T", Select all = the pages shown; My clients toggle (Staff on, Admin/Manager off, Limited none; URL flag). `intake-fixes.spec.ts` now 12; clients, expected, screenshots, expected-screenshots, type-governance, import, bulk, client-documents, search, search-screenshots, client-edit, client-plan, today, today-documents, upload-link-requested, review-dispatch, users, activity green locally. Unit 568/568; RLS clients-mine 5/5.
- Next step: step 11 (docs).
