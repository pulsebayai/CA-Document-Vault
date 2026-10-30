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
- [ ] 4. **Lib layer** (validation, state, review, dispatch, search parse, permissions, activity sentences, today shape). — proof: unit suite green; `document-state` / `today-shape` / `dispatch-dialog` unedited
- [ ] 5. **Type field:** `matchTypes` + `type-combobox` (ARIA, keyboard, cap, close matches, propose) + aliases loaded. — proof: `type-match` + `type-combobox` unit; benchmark 500 types < 16 ms
- [ ] 6. **Document form:** type field in; received as + Returnable + handed over by; confirmation line; Assign / Edit pages. — proof: unit form tests; e2e `document-type-field.spec` locally
- [ ] 7. **Inbox + file buttons + Edit entry points** (Inbox, `/documents`, Today, client rows, Needs-correction message). — proof: e2e `intake-fixes.spec` (Inbox part) locally
- [ ] 8. **Needs correction kind** (dialog, panel text, matching action). — proof: unit `review-actions`; e2e Wrong details → Edit → To review
- [ ] 9. **Lists:** `/documents` 20/page + Returnable filter; Client › Documents pages per card. — proof: e2e parts locally
- [ ] 10. **My clients** (toggle, default on for Staff, URL flag). — proof: `clients-mine` RLS + `clients-list` timing; e2e part
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
