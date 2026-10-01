# Plan: Review & dispatch
Spec: ./spec.md · Status: approved (Raja 2026-10-01 17:29 IST) · Date: 2026-10-01
Holds (from approval): **schema lock** (batch D, Raja 2026-10-01). Architecture lock: 06. 07's four architecture items go to architecture.md on main at merge.
Base: `feat/07-review-and-dispatch` from main `5e871f3`. **07 merges before 06**; 06 rebases.

## Design choices made while planning (from reading the code)
- **Two migrations, not one.** `ALTER TYPE … ADD VALUE` can't be used in the same transaction that then uses the new value (Postgres). Migration A adds the two enum values only; migration B does everything else.
- **The status gate lives in 03's `document_before_write`.** It currently forces `new.status := old.status` on every update. B replaces that line: status may change only when `app.doc_review` = the document's ID (set by the review functions, the same pattern as 03's `app.doc_version`), or by the reset rule (new version / dimension change → `received`). Everything else in that trigger is copied unchanged and diff-checked against 03's version in review.
- **04's linking:** `recompute_expected` gets one more condition (`d.status <> 'needs_correction'`) in both document lookups, and the `document_after_link` trigger adds `status` to its column list. `match_expected` is untouched, so a Needs-correction document stays linked.
- **Corrected file's date:** `add_document_version` gets an optional `p_received_on` (default null, so the 03 call shape is unchanged). It's used only when the document is Needs correction.
- **Review history + current state:** `document_review` is append-only (like `activity`). Current state lives on `document` (`reviewed_by/at`, `correction_reason`) for fast lists, written in the same transaction.
- **Search (03b)** functions are replaced in migration B with a `return` filter and the shown-state columns (`reviewed_at`, `dispatched_on`, `dispatch_method`) in result rows. The Limited hint is copied unchanged.
- **`documentState()`** lives in `src/lib/documents/state.ts` (a new file), so 06 can import it after the merge without touching 07's UI files.
- **Keep away from 06's files:** 07 doesn't touch `src/app/page.tsx`, `app-header.tsx`, `expected-view.tsx`, `settings/collection` or anything under `today/`, `mail/` or `reminders/`. The one shared file is `clients/[id]/documents-view.tsx` (07: document rows; 06: Remind on expected rows, a different part of the file).

## Files that change
| Path | New/Mod | Why |
|---|---|---|
| supabase/migrations/<ts>_document_status_review.sql | new | A: `document_status` += `reviewed`, `needs_correction` |
| supabase/migrations/<ts>_review_and_dispatch.sql | new | B: `document` review columns; `document_review`, `dispatch`, `dispatch_item` (+ RLS, no-delete triggers, indexes); `dispatch_method` enum; `review_document`, `undo_review`, `create_dispatch`, `undo_dispatch_item`; `document_before_write` (status gate + resets); `add_document_version` (+ `p_received_on`); `recompute_expected` + the `document_after_link` trigger columns; `search_documents` / `search_document_facets` (+ return filter, state columns); `reset_test_office` (+ new tables) |
| src/lib/documents/state.ts | new | `documentState()`: the spec's order, shared with 06 |
| src/lib/review/{actions,queries}.ts | new | markReviewed / markNeedsCorrection / undoReview; review history |
| src/lib/dispatch/{actions,queries}.ts | new | readyOriginals / createDispatch / undoDispatchItem; packet details |
| src/lib/documents/actions.ts | mod | `addVersionAction` passes the corrected received-on |
| src/lib/documents/queries.ts | mod | `listClientDocuments` / `getDocumentDetail` select the review and dispatch fields |
| src/lib/validation/document.ts | mod | review reason, dispatch input (zod) |
| src/lib/validation/document-search.ts, src/lib/search/queries.ts | mod | `DOC_STATUSES` (3 values), new `DOC_RETURNS`, URL mapping, row state |
| src/app/(app)/clients/[id]/documents-view.tsx | mod | state text, Mark reviewed (+ Needs correction…), Mark dispatched, Held N days |
| src/app/(app)/clients/[id]/review-controls.tsx, dispatch-dialog.tsx | new | the row actions and the packet dialog (client components) |
| src/app/(app)/documents/[id]/page.tsx, document-controls.tsx | mod | Review panel (history, undo), Dispatch panel; version dialog asks the received-on for corrections |
| src/app/(app)/documents/(search)/search-view.tsx | mod | Return filter, state on rows |
| tests/rls/review-dispatch.test.ts | new | step 1 (red first) |
| tests/rls/review-metric.test.ts | new | the metric-honesty cases with 04 (step 1) |
| tests/unit/document-state.test.ts, review-actions.test.ts, dispatch-dialog.test.tsx | new | state order, actions, dialog rules |
| tests/e2e/review-dispatch.spec.ts | new | rows, dialogs, document panels, filters, ≤ 390 px, axe, screenshots |
| tests/support/documents.ts | mod | helpers: review, dispatch, make original (**additions only**) |
| sdlc/product/references/ui-reference.md | mod | deviation: Mark reviewed button on Client › Documents |

**Expected overlap with 06:**
- `clients/[id]/documents-view.tsx` (different parts of the file; merge order 07 → 06);
- `tests/support/documents.ts` (additions on both sides).

No migration overlap: 06 adds only its own tables and functions.

## Migrations (schema lock: 07)
1. **A** `<ts>_document_status_review`: two `ALTER TYPE … ADD VALUE` statements. Applied first, on its own.
2. **B** `<ts>_review_and_dispatch`: everything else.
   - Dry-run on dev in a rolled-back block, impersonating Admin, Staff and Limited. Fixtures: the local un-suffixed set only, never the CI lanes' users.
   - Then the SQL gate, apply, md5 check, advisors.
   - No back-fill: existing documents are `received` = To review.

## Steps (estimates = build sessions with Claude; your time in brackets)
- [x] 0. Draft PR; CI green (docs only). (—) — PR #25
- [x] 1. **RLS/DB tests first (red)**, proof: `test:db` fails for the right reasons (1.5). Cases:
  - review/needs-correction/undo per role (Limited on own vs other client);
  - Inbox/archived refused; direct `update … set status` refused; history rows;
  - resets (new version, dimension change; remark edit doesn't reset);
  - **metric honesty** with 04: correction → pending; review → received; corrected version → received with the new date; another linked document keeps the item received;
  - packets: atomic, ineligible document refuses the whole packet, archived client allowed, one live packet per original, dates rule, undo per item;
  - no app write path; activity has no reason/recipient/courier/tracking text;
  - search: Status values, Return filter, facets = results.
- [x] 2. **Migrations A + B**: written, dry-run, **SQL gate**, applied to dev, advisors clean. Proof: step-1 tests green in CI; 03, 04 and 03b RLS suites green **unedited**. (1.5) [review SQL: 45 min]
- [x] 3. `documentState()` + validation (statuses, returns, reason, dispatch input). Proof: unit tests red → green; SQL-vs-TS state parity test on fixtures. (0.5)
- [x] 4. Server actions (review, dispatch, corrected received-on), with errors logged as code + request ID only. Proof: unit + RLS through the actions. (0.5)
- [x] 5. **Client › Documents**: state text, Mark reviewed + Needs correction modal, Mark dispatched + dispatch dialog, Held N days. Proof: e2e + unit. (1.5)
- [x] 6. **Document page**: Review panel (history, undo for Admin/Manager), Dispatch panel (packet, undo), the corrected-file date in the version dialog. Proof: e2e. (1)
- [x] 7. **`/documents`**: Status values + Return filter (URL round trip, no text in the URL), state on rows. Proof: e2e + unit. **First cut if 07 slips.** (0.5)
- [x] 8. a11y (axe), ≤ 390 px, screenshots, the ui-reference deviation. Proof: e2e evidence. (0.5)
- [x] 9. **RUN_SLOW** (07 changes 03/04 write paths): Regression dispatch on the branch with `base_url` = the preview; record save overhead (< 20 ms). (0.5) [none]
- [ ] 10. Merge main → full suite → `verifier` → `sdlc-reviewer` → fix Important findings → PR with the AC → test → result table. (0.5) [PR review: 1 h]

**Total ≈ 8 build sessions.** Your review ≈ 2.5 h. **First cut:** step 7's Return filter. Second cut: the Dispatch panel's "Also in this packet" list.

## Risks
| Risk | Likelihood | Mitigation | Rollback |
|---|---|---|---|
| The status-gate rewrite of 03's trigger breaks a 03 rule | medium | copy the function verbatim except the status lines; a diff-check in review; all 03 RLS tests unedited | migration C restoring 03's function body (kept in the PR description) |
| 04 linking regressions (received flips) | medium | metric-honesty tests; 04 RLS suite unedited | same: restore `recompute_expected` / the trigger |
| Save slowdown from the extra trigger column | low | RUN_SLOW + measured save overhead | drop `status` from the trigger columns and call recompute from the review functions instead |
| Enum `ADD VALUE` ordering on staging/prod | low | A applied before B (timestamp order); the R1 staging rehearsal replays them in order | — |
| 06 edits `documents-view.tsx` at the same time | medium | 07 merges first; 06 keeps to the expected rows; small conflicts resolved in 06's rebase | — |

## Proof of done
- Every AC → test (table in the PR); the full suite green in CI on the last code commit; RUN_SLOW Regression green on the preview.
- 03, 04 and 03b tests unchanged and green.
- No `[skip ci]` on code commits.

## Deviations from plan
- **D1 (step 2) `update_document` is replaced too** (not in "Files that change"). AC-16 needs the save's own activity row to say a review was reset (`review_reset: true`), and only `update_document` writes that row. The body is unchanged except that field.
- **D2 (step 2) A new trigger `document_after_review_link` (AFTER UPDATE … WHEN status changed) instead of adding `status` to `document_after_link`'s column list.** A new version resets the review inside 03's BEFORE trigger, and that UPDATE statement doesn't name `status`, so `UPDATE OF status` would never fire and the expected item wouldn't recompute. The WHEN clause also means ordinary saves pay nothing extra. 04's trigger and function are unchanged.
- **D3 (step 2) Write path = policies gated by transaction flags** (`app.doc_review`, `app.dispatch_write`), the same pattern as 04's `expected_doc` and 03's proposed types, rather than tables with literally no write policies. An invoker function needs a policy to insert. Direct inserts and updates through the API are still refused (asserted).
- **D4 (step 2) Interpretations:** Needs correction may also be set on a Reviewed document by anyone who can see it (it only makes the metric stricter). `p_received_on` is ignored, not refused, when the document no longer Needs correction (a stale dialog). The dispatch date's "not in the future" uses the India date, not the test clock. The Status filter keeps 03b's raw meaning (`received` also matches Inbox documents, which 03b's tests assert); the UI pairs "To review" with filed documents (step 7).

- **D5 (step 2) Migration C `20261001123450_review_dispatch_update_guard`** (one function). B's append-only trigger read `new.dispatch_id` in a condition shared with `tg_table_name`; plpgsql resolves every field, so an update of `document_review` failed with "record new has no field dispatch_id" instead of `IMMUTABLE`. The rows were already protected; only the error was wrong. Caught by the step-1 test; fixed by nesting the `if`.
- **D6 (steps 5–6) A few extra files:**
  - `clients/[id]/document-row.tsx`: the received-document row moved out of `documents-view.tsx`, so 06's merge has less to resolve in the shared file;
  - `documents/[id]/review-panel.tsx`: the Review and Dispatch panels;
  - `src/lib/review/messages.ts`: the error-code mapping;
  - `clients/[id]/page.tsx`: passes `today`.

  "Needs correction…" is a visible link-button next to Mark reviewed, not a hidden overflow menu (simpler for keyboard and screen readers; recorded in ui-reference.md). The dispatch dialog's list comes from `search_documents` with `return = ready` (one SQL definition of "ready"; at most 50 per client).
- **D7 (step 7)** `DocumentFilters.return` and the new `DocumentHit` fields are optional, so 03b's unit tests and fixtures keep their exact shape (tests unedited). Choosing Status "To review" also sets Show: Classified (D4).
- **D8 (step 10, sdlc-reviewer)** Also changed:
  - `src/lib/documents/selects.ts`: `CLIENT_DOCUMENTS_SELECT` gains the review columns and the live packet. It's shared with 03's perf test, so RUN_SLOW measures it.
  - `tests/unit/search-review.test.tsx` (new);
  - `src/lib/dispatch/summary.ts` (pure `packetSummary`);
  - `src/components/dialog.tsx`: the link-variant trigger now honours `triggerLabel`. This is additive: unchanged when no label is passed.

  Reviewer findings:
  - **Fixed:** the Important finding (packet "N of M removed" / "Cancelled" on earlier packets, AC-10); concurrent-packet race mapped to stale; "Already reviewed by <name>"; the session-ended message; live regions that survive the refresh; unique "Needs correction: <document>" names; server-formatted history times (hydration); the client name in the dispatch heading; "1 day".
  - **Accepted:** double recompute when a reset and a relink happen in one save (idempotent; +0.55 ms measured); choosing "To review" adds a visible Show: Classified chip that the user can remove.
  - **Open for Raja:** see the PR description (lock rows in `update_document` / `add_document_version`; type/client changes of a dispatched original; a corrected file for a dispatched original; a Needs-correction original shows Ready to dispatch).
- **D9 (Raja 2026-10-01 21:15: "fix those 2")** Migration D `20261001154640_review_dispatch_locks`:
  - `update_document` and `add_document_version` read the document `for update` (race fix);
  - `update_document` refuses a client or received-as change while the original is in a live packet (`DISPATCHED`: undo the dispatch first; plain message in `src/lib/documents/actions.ts`).

  Test: "a dispatched original keeps its client…" (red first, then green). The 03, 04 and 07 suites using these functions are green, unedited. Questions 3–4 remain open.

## Session log

### 2026-10-01 (session 2, ~17:40–)
- Done: step 0 (draft PR #25); step 1 (tests/rls/review-dispatch.test.ts, review-metric.test.ts, support helpers; 29 red for the right reason: functions/tables missing); migration A applied to dev (20261001122110, Raja OK in chat); migration B written + dry-run on dev (rolled back): review 33 ms, dispatch 15 ms, all paths as specified.
- In progress: step 2, waiting for the **SQL gate** on B (`supabase/migrations/20261001130000_review_and_dispatch.sql`; renamed to the applied version after apply).
- Blocked / failing: none.
- Next step: Raja approves B → apply → md5 check → advisors → step-1 tests green locally → 03/04/03b suites green unedited → push (CI full run).
- Decisions made (cross-cutting → flag for architecture.md): D2 (status-change trigger for 04 linking), D3 (flag-gated write policies for history/packets). **For 05:** "map to existing" re-points `document.doc_type_id`, which resets reviews under AC-4. 05's spec should decide whether a catalogue merge resets reviews (probably not: bypass with a flag).
- Update (same session, ~18:00–19:10): Raja approved B → applied as `20261001123125` (md5 = file), advisors: nothing new. Migration C fix (D5). Full `test:db` locally: **338 passed, 4 skipped (RUN_SLOW)** — 03, 04, 03b suites unedited. Steps 3–8 built: unit 338 → 359 passing; e2e `review-dispatch.spec.ts` 5/5 locally; CI run 36865967873 (d3229f1, steps 5–6) **fully green**. Save overhead measured on dev (rolled back): review 5.9 ms, a period change that resets a review +0.55 ms vs one that doesn't (< 20 ms). Step 9 RUN_SLOW Regression dispatched on the branch preview (run 36870727146).
- Update (~19:45–21:30): CI 36876335647 (9b7552b) green; **RUN_SLOW Regression 36881109553 on the branch preview green** (RLS with RUN_SLOW 17 min, e2e 15 min). sdlc-reviewer run: SQL sound, function bodies verified; fixes in D8. Raja approved fixing questions 1–2 → migration D (D9), applied, md5 = file, advisors unchanged. Next: CI + RUN_SLOW again on D → mark #25 ready → Raja answers Q3–4 → merge.

