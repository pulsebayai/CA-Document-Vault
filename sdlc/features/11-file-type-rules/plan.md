# Plan: Preferred file formats per document type
Spec: ./spec.md (approved 2026-10-26, S1–S7 as recommended) · Status: **approved (Raja 2026-10-26 11:49 IST: P1–P3 as recommended)** · Date: 2026-10-26
Locks: **schema + architecture → 11** (taken 2026-10-26 when 10 merged; roadmap PR). Branch `feat/11-file-type-rules`, cut from main @ 9869116 (10 merged in PR #3).
Read from: `feat/10-client-upload-links` @ c80bb92 (the code 11 builds on). Main @ 9869116 has no code change since c80bb92 (only docs), so everything below still holds.

## What the code showed (changes the spec's "how", not its behaviour)
- **One place for the format check: 03's `private.document_before_write`.** A document is inserted with no version (`current_version_id` null), then the version trigger updates `current_version_id` under `app.doc_version`. So the same BEFORE trigger sees every filing event the spec lists:
  - create → version update → **check**;
  - new version → `current_version_id` changes → **check**;
  - classify / re-classify → `v_dims` (client, type, period, registration) changes → **check**;
  - 05's merge → `v_merge` → **keep old values**;
  - anything else (review, archive, remark, dispatch) → **keep old values**.

  It is SECURITY DEFINER, so it also runs on 10's link path (where RLS doesn't apply) and on `create_document_for_item`. `create_document` and `add_document_version` are not touched. The trigger always overwrites the two columns, so no caller (staff function, PostgREST, link path) can set them (spec AC-15).
- **The format comes from the current version's `storage_path` extension.** It is canonical (03's verification reads it; 10's B1 fix makes the file name end with it too). `jpeg` is normalised to `jpg`.
- **P1 (approved) — the exception needs no new guard trigger.** `client_doc_type` updates are already Staff+ only by RLS (`client_doc_type_update` policy: admin/manager/staff), so Limited is refused today. 11 only adds `any_format` to the column grant. Spec AC-6 behaviour is unchanged; the "guard trigger" line becomes "RLS + column grant", proven by the new matrix probe.
- **P2 (approved) — no badge on Today.** Today's document rows (`today_items`, replaced by 10 twice; part of **K3**) don't carry the channel or any badge today (10's "From client link" isn't shown there either). Adding the flag would mean replacing `today_items` a third time. Today rows open the document, where the badge shows. `today_items` is **not** changed by 11.
- **P3 (approved) — no Inbox badge.** Inbox documents have no client/type, so they are never flagged; once classified they leave the Inbox. Spec AC-16's "Inbox (after classifying)" means Client › Documents.
- **Names in the code:** catalogue saves go through `saveDocType` (`src/lib/catalogue/actions.ts`), plan rows through `src/lib/plan/actions.ts` (pattern: `setPlanTypeReminders`). The spec's `upsertDocType` / `updateClientDocType` are these. New action: `setPlanTypeAnyFormat(id, on)`.
- **Seed reaches every office:** the Kushal office comes from migration `20260925112328_seed_office`, its catalogue from `20260927070427_seed_catalogue`; test offices call `private.seed_catalogue` from `reset_test_office`. 11's migration updates existing offices by name and replaces `seed_catalogue` (same body + one call), so staging/prod (migration replay) and test offices all match.

## Files that change
**Migrations (new; schema lock 11):**
- `supabase/migrations/<ts>_format_preferences.sql` (A):
  - columns `doc_type.preferred_formats text[]`, `client_doc_type.any_format boolean not null default false`, `document.format_preferred text[]`, `document.format_ok boolean`; checks (values ⊂ choices, distinct, non-empty; null unless approved; both-or-neither on document);
  - grants: `preferred_formats` added to `doc_type`'s insert/update grants; `any_format` to `client_doc_type`'s update grant; **no** grant on the document columns;
  - helpers `private.format_choices()`, `private.format_of_path(text)` (extension, `jpeg`→`jpg`), `private.format_label(text[])`;
  - `private.document_before_write` replaced: the 05/07 body unchanged plus one block at the end (spec AC-14 rule, notes above);
  - `private.seed_preferred_formats(p_office uuid)` (the six types, AC-4 / S1; skips renamed/removed types and types that already have a list; one `doc_type.formats_changed` activity row each, actor null) and `private.seed_catalogue` replaced (same body + `perform private.seed_preferred_formats(p_office_id)`); run once for every existing office.
- `<ts>_format_reads.sql` (B):
  - `search_documents(jsonb)` / `search_document_facets(jsonb)` replaced (same signatures): `filters.format = 'not_preferred'` → `format_ok = false`; facet `format` (one value, hidden at 0);
  - `link_open` replaced: `preferred` per item (null when no list or the client's plan row has `any_format`); nothing else added;
  - `link_register` replaced: reads `warned` from its existing `p_ticket` jsonb into `data.warned` of `document.link_upload`; no other change (check order, refusals, caps untouched);
  - `format_metric(p_from, p_to)` (invoker, Admin/Manager; AC-24).

**Server/lib:**
- new `src/lib/validation/formats.ts`: choices, `normaliseFormat`, `formatLabel`, `preferenceApplies`, `isPreferred` (mirrors the SQL helpers);
- `src/lib/catalogue/actions.ts` (`saveDocType` + `preferredFormats`, activity `doc_type.formats_changed`), `src/lib/validation/catalogue.ts`, `src/lib/catalogue/queries.ts` (select the column);
- `src/lib/plan/actions.ts` (new `setPlanTypeAnyFormat`, activity `client_doc_type.format_exception_set/_cleared`), `src/lib/plan/queries.ts`;
- `src/lib/documents/queries.ts`, `selects.ts` (select `format_ok`, `format_preferred`; types/plan rows for the form warning);
- `src/lib/search/queries.ts`, `src/lib/validation/document-search.ts` (`format` URL filter);
- `src/lib/upload-links/public.ts` (pass `warned`), `src/app/u/actions.ts`;
- `src/lib/auth/permissions.ts` (row "Set a client's format exception"); `src/lib/activity-feed/catalogue.ts` (3 sentences).

**Screens:**
- `src/app/(app)/settings/catalogue/catalogue-view.tsx` (type dialog section + list label);
- `src/app/(app)/clients/[id]/plan-view.tsx` (label + switch; read-only for Limited);
- `src/app/(app)/documents/new/document-form.tsx` (Add document, edit/classify, Upload for an item: inline warning + exception link);
- `src/app/(app)/documents/[id]/document-controls.tsx` (Add version warning), `documents/[id]/page.tsx` (badge + detail);
- `src/app/(app)/clients/[id]/document-row.tsx`, `src/app/(app)/documents/(search)/search-view.tsx` (badge; Format chip + facet);
- `src/app/u/upload-view.tsx` (hint, warning dialog, `warned`);
- `src/app/(app)/settings/collection/page.tsx` ("Preferred formats" section);
- new `src/components/format-badge.tsx` (one badge, text + detail).

**Docs:** `sdlc/product/architecture.md` (lock holder: spec's 3 items + P1/P3 notes), `sdlc/product/references/ui-reference.md` (deviation row: format chips, warnings, badge).

**Tests (new):**
- `tests/rls/format-preferences.test.ts` (columns, checks, grants, seed incl. renamed type, exception per role, activity);
- `tests/rls/format-check.test.ts` (every filing path: staff create, version, classify, re-classify, Upload-for-item, link; not on merge/review/archive/preference change; hard copy; direct update refused per role; TS↔SQL label/format equality vectors);
- `tests/rls/format-reads.test.ts` (search filter + facet + visibility matrix; `link_open` payload; `warned`; `format_metric`);
- `tests/unit/formats.test.ts`, `tests/unit/format-warning.test.tsx` (form warning logic);
- `tests/e2e/format-preferences.spec.ts` (catalogue → client exception → staff warning → badge → `/documents` filter → Collection);
- `tests/e2e/upload-link-formats.spec.ts` (`/u` hint, dialog both buttons, mixed selection, every allowed format accepted; 390 px + axe).
- **Changed (additive, flagged as 10 did):** `tests/unit/permissions.test.ts` (matrix snapshot gains the approved row) and `tests/rls/role-matrix.test.ts` (its probe).

## Migrations
A then B, both additive or `create or replace` with the same signatures. Each dry-run on dev in a rolled-back block (admin / staff / limited), reviewed by Raja, applied, md5 of applied text = file, advisors clean. Staging/prod at R1 by replay.

## Steps (estimates = build sessions with Claude; Raja's time in brackets)
- [x] 0. **Start (after 10 merges):** roadmap commit on main (11 in progress, locks → 11); branch `feat/11-file-type-rules`; commit intent/spec/plan from the project into `sdlc/features/11-file-type-rules/`; draft PR so CI runs. Proof: CI green on the branch with docs only. [merge roadmap PR]
- [x] 1. **DB tests first (red):** `format-preferences`, `format-check`, `format-reads` written against the spec's ACs; run locally, fail for the right reasons. Proof: test output (0.5)
- [x] 2. **Migration A** (columns, checks, grants, helpers, trigger block, seed). Proof: `format-preferences` + `format-check` green locally; **03 documents/storage, 04 expected, 05 type-governance, 07 review-dispatch, 10 upload-links suites green unedited** (they cover the trigger). (1) [review SQL: 30–45 min]
- [x] 3. **Shared rule** `formats.ts` + unit tests; TS↔SQL vectors pass in `format-check`. Proof: unit + DB (0.25)
- [x] 4. **Catalogue + Client › Settings:** type dialog and list label; `setPlanTypeAnyFormat`; switch; permission row + probe; activity sentences. Proof: e2e part 1; `role-matrix` + `permissions` (additive); activity coverage test; 02's catalogue and plan e2e unedited. (0.5)
- [x] 5. **Staff warning + badge:** document form (add, edit/classify, Upload for item), Add version, badge on Client › Documents, `/documents`, document page. Proof: unit form test; e2e part 2; 03 add-document / client-documents / 10 requested e2e unedited. (0.75)
- [x] 6. **Migration B + `/u` + search:** `link_open` / `link_register`, search filter + facet, `/u` hint + dialog + `warned`, Format chip. Proof: `format-reads` green; `upload-link-formats.spec` (390 px + axe); 03b search + 10 upload-link suites unedited. (0.75) [review SQL: 20 min]
- [ ] 7. **Collection section:** `format_metric` + page section. Proof: `format-reads` metric cases; e2e part 3; 04's `collection.spec` and 10's link-metric e2e unedited. (0.25)
- [ ] 8. **Close:** architecture.md + ui-reference rows; verifier (lint, typecheck, unit, full DB suite, build); new/changed e2e locally on a production build; **full CI on the PR**; **RUN_SLOW Regression on the branch preview** (03 filing trigger changed); sdlc-reviewer; PR ready. Timing: one save with the check vs 03's baseline (≤ 5 ms added). (0.5) [PR review 1–2 h; ask before each CI run]

## Risks
| Risk | Mitigation |
|---|---|
| The filing trigger is shared by every write path (03, 05 merge, 07 reset, 10 link path) | One appended block that only reads two rows by key and sets two columns; the 05/07 body copied byte-for-byte (diff checked in review); all suites that cover the trigger run unedited in step 2; RUN_SLOW before merge |
| Replacing `link_open` / `link_register` reopens 10's public path | Only the item JSON gains `preferred` and the activity row gains `warned`; check order and refusals copied unchanged; 10's 56 public/review DB tests unedited; sdlc-reviewer security pass on the diff |
| Replacing 03b's search functions (K5 borderline) | Same signature; one extra predicate + one facet; timed on dev before/after; partial index `document (office_id) where format_ok = false` only if slower |
| Replacing `seed_catalogue` (used by `reset_test_office` in 4 migrations) | Same body + one call; `reset_test_office` tests unedited; seed test with a renamed type |
| 10 changes again before merging (review fixes) | 11 branches only after 10 merges; step 0 re-reads the merged `link_*` and `document_before_write` bodies before writing A/B |
| Schedule | [Likely] 4 build sessions ≈ 4–5 working days with reviews; slips if 10's merge slips |

**Rollback:** both migrations have a written reverse (drop the four columns, the helpers and `format_metric`; restore the previous bodies of `document_before_write`, `seed_catalogue`, both search functions, `link_open`, `link_register` from their files). Without a rollback, clearing every type's preferred formats turns the feature off (no hints, warnings or flags).

## Estimate
[Likely] **4 build sessions (≈ 3.5 days) + Raja's reviews ≈ 4–5 working days** from 10's merge. **10 merged 2026-10-26** (not ≈ 13–14 Nov as assumed at planning), so 11 lands [Likely] ≈ 31 Oct–3 Nov; staging/prod creation and the release gate follow.

## Proof of done
Every spec AC → test file → result in the PR's AC table (P2/P3 marked as approved deviations). Full CI green on the last code commit; RUN_SLOW Regression green on the branch preview; no existing test edited except the two additive permission files above; save timing recorded.

## Decisions (Raja 2026-10-26 11:49 IST: all three approved as recommended)
- **P1.** Exception enforced by the **existing RLS + column grant** (Limited already can't update plan rows), not a new trigger.
- **P2.** **No badge on Today**; `today_items` unchanged by 11. *(Not chosen: add it, +½ day and a K3 re-time.)*
- **P3.** No Inbox badge (Inbox documents can't be flagged).

## Deviations from plan
- **Step 1: link_register's argument is `p_file`, not `p_ticket`** (the plan named it wrongly). `warned` travels in `p_file`; a non-boolean value is stored as false.
- **Step 1: the loans seed name is the real one**, "Loans & deposits outstanding at 31 Mar (lender list, amounts)" (the spec shortened it).
- **Step 1: one extra service-role helper, `public.test_seed_preferred_formats(p_office_id)`** (is_test offices only, `NOT_TEST_OFFICE` otherwise; returns the number of types it set), so the seed's skip rules (renamed type, list already set) can be tested without re-running the migration. Same pattern as 10's `test_set_link_caps`.
- **Step 1: `format_label` / `format_of_path` are `public` with EXECUTE for service_role only** (architecture rule for service-role helpers), so the TS↔SQL equality test can call them.
- **Step 1: the metric's shape is fixed in the tests** (`applied.link/staff {total, preferred}`, `warned {total, switched, anyway}`, `flagged_review_hours_median`, `exceptions [{type_id, type, n}]`; window = the document's filing day, IST).
- **Step 1: shared test helpers in a new `tests/support/formats.ts`** (any-format synthetic upload, version, check readers); existing helpers unchanged.
- **Step 2: migration A2 `20261026084429_format_preferences_check` (approved by Raja 2026-10-26).** A's type check called `private.formats_valid`; a check constraint runs with the writer's privileges and the service role has no usage on schema `private`, so after A every service-role write to `doc_type` failed ("permission denied for schema private"), even a rename. Staff paths were unaffected (signed-in users have usage), and no app code or existing test writes types as the service role. A2 rewrites the same rules with built-ins only (`array_positions` per choice for "distinct") and drops `private.formats_valid`. Caught by the new tests (`setPreferred` / rename via the service role).
- **Step 2: migration files renamed to the versions dev recorded** (A `20261026082819`, A2 `20261026084429`), as earlier features did. Live function bodies = file (md5, all nine functions of A).
- **Step 2: `doc_type.formats_changed` activity sentence added now** (not in step 4): the activity coverage unit test requires a sentence for every action written in the migrations.
- **Step 2: my own step-1 tests read `id` from `link_register`; it returns `document_id`.** Fixed in `format-check` / `format-reads` (unmerged, new files).
- **Step 5: the form's "Allow any format" goes through a wrapper `allowAnyFormat(planRowId)` in `src/lib/documents/actions.ts`** (calls `setPlanTypeAnyFormat`). The form's hydration unit test mocks `documents/actions`; importing `plan/actions` (server-only) into the client form broke it. Same rule, one more export.
- **Step 5: the new TS fields are optional** (`TypeOption.preferredFormats/anyFormat/planRowId`, `ClientDocument.notPreferred`, `DocumentDetail.notPreferred/appliedFormats`), so existing tests that build these objects compile unedited.
- **Step 5: Add version shows the preference as a hint before choosing and a note after saving** (no blocking dialog), because a new version is saved as soon as the file is chosen.
- **Step 5/6: the `/documents` badge was built in step 6** with the search reads (it needs B's `format_ok` / `format_preferred` columns in the rows).
- **Step 6: migration B renamed to the version dev recorded**, `20261026113420_format_reads`.
- **Step 6: migration C `20261026114801_format_test_offices` (approved by Raja 2026-10-26)** so 10's existing tests run unedited:
  - B wrote `warned: false` on every link upload, but `upload-links-public` checks the activity row exactly. C writes `warned` **only when true** (absent = not warned; a non-boolean counts as not warned).
  - A had seeded preferences into automated-test offices (its `seed_catalogue` replacement plus the one-time update). 10's e2e PDF bank upload would then hit the new warning. C restores 02's `seed_catalogue` (prosrc md5 = the original's) and clears preferences in `is_test` offices. 11's tests switch them on with `test_seed_preferred_formats` (`tests/support/formats.ts` `seedPreferences`). Real offices keep A's one-time seed; staging/prod get it by replaying A.

## Session log
### 2026-10-26 (steps 4–6)
- Done: step 4 (catalogue fieldset + row label, Client › Settings switch, permission row `format_exception` + probe, 3 activity sentences), step 5 (staff warning in the document form with a two-step "Allow any format", Add version hint, Not preferred format badge on Client › Documents and the document page), step 6 (migration B applied, `20261026113420`: search filter/facet, `link_open` `preferred`, `link_register` `warned`, `format_metric`; `/documents` Format filter, chip and badge; `/u` hint, warning with "Choose another file" focused and "Upload anyway"). Migration C applied (`20261026114801`; see Deviations). md5 of live functions = files; advisors: no new findings.
  - 11's DB tests: format-preferences, format-check, format-reads all green (format-reads 13/13).
  - Existing DB suites, unedited: upload-links (all eight files incl. public), document-search, documents, clients-catalogue, catalogue-usage, type-governance, role-matrix, activity-feed — 15 files, 333 passed, 1 skipped.
  - e2e on a local production build: new `format-preferences.spec` (4) and `upload-link-formats.spec` (2, 390 px + axe), plus unedited upload-link, catalogue, add-document, search, client-plan — 28/28.
  - Unit 527/527 · lint 0 · typecheck 0 · build 0.
- In progress: —
- Blocked / failing: —
- Next step: step 7 (Settings › Collection section from `format_metric`), then step 8 (close).
- Not pushed yet: ask Raja before pushing to PR #6 (CI run).

### 2026-10-26 (steps 2–3)
- Done: migration A applied to dev (Raja approved 13:56), version 20261026082819, md5 of all nine function bodies = file; security advisors: no new findings (all pre-existing). Migration A2 (check fix) approved and applied, version 20261026084429. `src/lib/validation/formats.ts` + `tests/unit/formats.test.ts` (28); feed sentence for `doc_type.formats_changed`.
  - 11's tests: format-preferences 16/16, format-check 19/19 (incl. TS ↔ SQL labels and path formats).
  - Existing suites covering the filing trigger, unedited: documents 49/49, document-storage, expected-docs, type-governance, review-dispatch, proposed-types, clients-catalogue, upload-links public / review / review-10b / requested — 222 passed, 49 skipped (pre-existing RUN_SLOW skips). Two timeouts in the combined run (documents setup, 10b merge case) both started in the minute A2's `alter table` held the type table's lock; both files green alone (49/49, 4/4).
  - Unit 522/522 · lint 0 · typecheck 0.
- In progress: —
- Blocked / failing: `format-reads` (needs migration B, step 6).
- Next step: step 4 (catalogue + Client › Settings + permission row).
- Not pushed: PR #6's CI would fail on `format-reads` until B; push with step 6 (Raja asked to be asked before each push/CI run).

### 2026-10-26 (step 1)
- Done: step 0 (PR #5 roadmap merged 4ce13e5; PR #6 draft, docs-only CI green on fc696c8; main merged into the branch). Step 1: `tests/rls/format-preferences.test.ts` (16), `format-check.test.ts` (17), `format-reads.test.ts` (13), `tests/support/formats.ts`.
  - Red for the right reasons (local run against dev, 2026-10-26 13:5x): format-preferences 16/16 fail on the missing `preferred_formats` / `any_format` columns and `test_seed_preferred_formats`; format-check and format-reads fail in their fixture (`any_format` missing), so their cases run once migration A exists. A first run showed 7 false passes (a case-insensitive error match hit the column name in "column not found"); fixed to match only a check-constraint refusal.
- In progress: —
- Blocked / failing: the three new files (expected until migrations A/B).
- Next step: step 2 — migration A written, dry-run on dev in a rolled-back block, **Raja reviews the SQL**, then applied.
- Not pushed: the test-only commit would make PR #6's CI run the full suite and fail; push with step 2.

### 2026-10-26 (step 0)
- Done: 10 confirmed merged (PR #3, main 9869116; no code change since c80bb92, so the plan's reading of `document_before_write`, `link_open` and `link_register` still holds). Roadmap branch `chore/roadmap-start-11` (11 in progress, schema + architecture locks → 11) and this branch with intent/spec/plan copied from the project, both prepared locally.
- In progress: step 0 — waiting for Raja's OK to push both branches and open the PRs (docs-only; CI runs only "What changed").
- Blocked / failing: none.
- Next step: push → roadmap PR (Raja merges) + draft PR for 11 → step 1 (DB tests first). Step 1 needs `.env.local` from Raja's Mac (desktop link) to run the DB tests against dev.
- Note: the full RUN_SLOW Regression on main after 10's merge (roadmap R1 checklist) is still to run; don't overlap it with 11's first DB-test runs on the dev database.

### 2026-10-26 (planning)
- Done: intent approved (rev 3); spec approved (S1–S7 as recommended); plan approved (P1–P3 as recommended), drafted from `feat/10-client-upload-links` @ c80bb92 (read-only clone in the cloud workspace; its scratch branch removed, nothing pushed).
- Blocked: build waited for 10's merge (schema + architecture locks).
- Decisions made (cross-cutting → architecture.md at build): advisory preferred formats; format check in `document_before_write`; format rule mirrored TS/SQL; P1 (RLS + grant for the exception).
