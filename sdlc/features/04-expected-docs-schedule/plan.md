# Plan: Expected documents & schedule
Spec: ./spec.md · Status: approved (Raja 2026-09-29 20:29 IST) · Date: 2026-09-29
Holds (from approval): **schema lock** + **architecture lock** (spec's 5 approved changes; applied to architecture.md in this feature's PR, as in 02/03).
Base: `feat/04-expected-docs-schedule` from main `b296625`. **The build (step 1 onwards) starts only after the `test-isolation` chore merges** (Batch C decision, 2026-09-29); then rebase.

## Design choices made while planning (from reading the code)
- **Plan changes are caught by DB triggers, not by server actions.** 02's pause/resume/remove/edit paths update `client_doc_type` / `client_group` directly through PostgREST (`src/lib/plan/actions.ts`), and registrations change inside `update_client`. Only AFTER triggers on `client_doc_type`, `client_group`, `client_registration` and `client` (archive) see every path, including direct API calls. The triggers are SECURITY DEFINER, check the tenant first, and use `search_path = ''`, like 03's.
- **Effective plan state = group state AND row state.** Pausing a group leaves its rows `active` (02), so generation and "On hold" check both.
- **Only functions write `expected_doc`.** This uses a transaction flag (`app.expected_write`) in the same pattern as 03's `begin_doc_write`, and adds no INSERT/UPDATE policies for app roles.
- **Linking** is an AFTER trigger on `document` (insert, plus update of client/type/period/registration/archived_at). It sets `document.expected_doc_id` and the item's status/received_on. 03's functions themselves are unchanged.
- **Keep 04 out of `src/lib/documents/queries.ts`** (03b's main file). Expected queries live in the new `src/lib/expected/`, so 04's only overlap with 03b is the client page and the Add document form.
- **Nightly job check without editing the workflows.** A `RUN_SLOW` RLS test asserts that the real office has an `expected.generated` row from the last 26 h. Nightly and release runs already set `RUN_SLOW`, so neither `regression.yml` nor `ci.yml` changes. The test-isolation chore edits those files; this avoids overlapping with it.

## Files that change
| Path | New/Mod | Why |
|---|---|---|
| supabase/migrations/<ts>_expected_docs.sql | new | pg_cron; `expected_status`; `expected_doc` (+ indexes, RLS, forbid_delete); `document.expected_doc_id`; `schedule_dates`, `earliest_open_period`, `generate_expected`, linking + plan/registration/client triggers; `waive_expected` / `undo_waive_expected` / `reopen_expected`; `run_expected_generation` (test offices); `collection_metric`; FY auto-create in the job; cron schedule; `enable_group_core` / `add_client_doc_type` start default; `search_clients` + overdue counts and `p_has_overdue`; `reset_test_office` + expected_doc; back-fill |
| src/lib/expected/schedule.ts | new | TS mirror of `schedule_dates` + derived state (Due / Due today / Overdue N days / On hold / Received / Not needed) |
| src/lib/expected/{queries,actions}.ts | new | client expected list, open items for cards, metric; waive / undo / reopen server actions |
| src/app/(app)/clients/[id]/page.tsx | mod | tabs Documents (default) · Expected (count) · Settings |
| src/app/(app)/clients/[id]/expected-view.tsx | new | Expected tab (filters, rows, Waive modal, Reopen, Undo, Upload) |
| src/app/(app)/clients/[id]/documents-view.tsx | mod | open rows on top of each group card, "All caught up" |
| src/app/(app)/clients/[id]/plan-view.tsx | mod | "No active GSTIN/TAN — nothing expected" note (AC-5) |
| src/app/(app)/documents/new/page.tsx, document-form.tsx | mod | pre-fill `type`, `period`, `registration` params (UUIDs, validated) |
| src/app/(app)/clients/{clients-view,clients-browser}.tsx, src/lib/clients/{queries,actions}.ts, src/lib/validation/client-search.ts | mod | overdue text + "Has overdue" chip (not in URL) |
| src/app/(app)/settings/layout.tsx, settings/collection/page.tsx (+ loading/error) | mod/new | Collection item (Admin/Manager) + metric page |
| tests/rls/expected-docs.test.ts, expected-plan.test.ts, expected-metric.test.ts | new | written first (step 1) |
| tests/rls/expected-perf.test.ts | new | RUN_SLOW volume + nightly job assertion |
| tests/unit/expected-schedule.test.ts, expected-view.test.tsx | new | date maths, state text, view logic |
| tests/e2e/expected.spec.ts, collection.spec.ts; clients.spec.ts, client-documents.spec.ts, screenshots.spec.ts | new/mod | new e2e; existing specs **extended only** (new cases), never edited to pass |
| tests/support/expected.ts, test-data.ts | new/mod | fixtures: scheduled plan rows, fixed-date generation, purge |
| sdlc/product/architecture.md | mod | 5 approved changes + decision log rows (in the PR, with the lock) |

**Overlap with 03b** (for the batch confirmation): `clients/[id]/page.tsx` (tabs) is certain. `documents/new/document-form.tsx` is possible, if 03b links to it. `src/lib/documents/queries.ts` is **avoided** by design. Migration: 04 only (03b's indexes come after 04 merges).

## Migrations (schema lock: 04)
1. `<ts>_expected_docs.sql`: everything above in one additive migration, plus advisor fix-ups if needed (as in 03).
   - Dry-run on dev inside a rolled-back block (impersonating admin/staff/limited).
   - Apply, then run the advisors.
   - Back-fill: `generate_expected` for all offices as of the apply date. This links 03's documents.
   - Cron: `cron.schedule('expected-docs-daily', '45 18 * * *', …)` (00:15 IST).
   - Staging/prod get the same migration at R1. Extension creation there is part of the R1 checklist.

## Steps (estimates = build sessions with Claude; your time in brackets)
- [x] 0. **Wait for test-isolation to merge** → rebase on main → CI green on the branch — proof: CI run (docs-only commits so far) [—]
- [x] 1. **RLS/DB tests first (red)**, all using `run_expected_generation(p_as_of)` in test offices (proof: `test:db` fails for the right reasons) (1.5). Cases:
  - date maths (month ends, 29 Feb, quarter/FY ends, offset 0) and earliest still-open period
  - generation counts per frequency; idempotent re-run
  - exclusions: paused/removed row or group, as-needed/firm/proposed types, archived client
  - per-registration fan-out; none without a registration
  - back-link of earlier documents
  - plan-change effects: immediate generation, pending-only date recompute, on hold, no generation while paused, auto-waive codes
  - linking/unlinking on save, classify, edit, archive and unarchive; received_on recompute
  - waive/undo/reopen role matrix; reason required
  - visibility matrix; direct writes rejected; DELETE rejected
  - activity rows without free text or PII
  - metric maths on a fixture set
  - FY auto-create from 1 Feb; cron job registered
  - start default for new rows (AC-3)
- [x] 2. **Migration** written, dry-run, applied to dev, advisors clean, back-fill checked on the real office (counts by group look sane) — proof: step-1 tests green in CI (1.5) [review SQL: 45–60 min]
- [ ] 3. `schedule.ts` + derived state — proof: unit tests red → green; the TS dates equal the SQL dates for a table of cases (0.5)
- [ ] 4. `src/lib/expected` queries + actions (waive/undo/reopen with friendly errors) — proof: RLS tests via actions' RPCs + unit (0.5)
- [ ] 5. **Client › Expected tab** + Waive modal + Reopen/Undo + Upload → Add document pre-fill (type/period/registration) → linked on save — proof: e2e (staff waives; limited can't; manager undoes; upload links and the item flips to Received) (1.5)
- [ ] 6. **Documents cards** open rows + "All caught up" + Documents default tab + plan-row registration note — proof: e2e (1)
- [ ] 7. **Clients list** overdue text + "Has overdue" chip (not in URL) — proof: e2e + unit (0.5)
- [ ] 8. **Settings › Collection** (Admin/Manager; Staff/Limited get no item, and Not Found on the URL) — proof: e2e + RLS (0.5)
- [ ] 9. **Job check** (the volume part is deferred, Raja 2026-09-29): a `RUN_SLOW` test asserts today's `expected.generated` row on the real dev office (nightly). Proof: a RUN_SLOW dispatch. (0.5)
  - **Deferred to the volume test after all R1 features:** about 180k items, the job < 60 s, screen queries < 1 s, a save adding < 50 ms.
- [ ] 10. States + a11y (axe on Expected tab, Collection) + ≤ 390 px + screenshots vs mockups 03/10 — proof: e2e evidence (0.5)
- [ ] 11. architecture.md (5 changes + decision log) · `verifier` → `sdlc-reviewer` → fix Important → PR with AC → test → result table — proof: CI green, evidence with all suites [PR review: 1–2 h]
- (Not a build step) **Plan fidelity (success metric 2)** is checked on staging/pilot with 5 clients, and goes on the R1 checklist.

**Total ≈ 9 build sessions** (volume part of step 9 deferred) (03 took ~9.5 for a similar surface, ~2 working days at that pace). Your review ≈ 3–4 h. **First cut if it slips:** step 6's open rows in the Documents cards (spec risk). Second cut: the per-group table on Collection (keep the headline figure).

## Risks
| Risk | Mitigation |
|---|---|
| Triggers on 02's plan tables change 02 behaviour | triggers only write `expected_doc`, never the plan rows; all 02 RLS/e2e tests must stay green unchanged; step-1 tests cover each plan path |
| Linking trigger slows or breaks 03's save | set-based lookup on the unique key (index); volume test measures the save; 03's tests unchanged and green |
| Generation writes as definer (bypasses RLS) | tenant-first check; only called with an office id from the row being changed or from the cron loop; tests prove a user can't trigger generation for another office's client |
| pg_cron job not running (dev paused, extension missing on staging/prod) | nightly assertion (step 9); Collection shows "Last generated"; R1 checklist: extension + job exist on staging/prod |
| Back-fill floods the real dev office | dev has synthetic data only; back-fill uses Q1's "earliest still-open" rule for the stored start periods only; counts reviewed at step 2 |
| FY boundary (April) untested in real time | fixed-date tests across 31 Mar/1 Apr and FY auto-create on 1 Feb |
| Concurrent generation (job + plan edit on the same row) | unique key + ON CONFLICT DO NOTHING; linking is idempotent |
| Merge conflicts with 03b (client page tabs) | 04 merges first (batch rule); tabs change is small |
Rollback: dev only. Revert the PR, add a compensating migration (unschedule the job, drop the trigger functions/table/column, restore 02's start default). No real data.

## Proof of done
AC-1…18 → test file → result table in the PR. CI green (Unit + RLS + E2E evidence). RUN_SLOW volume run green. Screenshots vs mockups 03/10. Back-fill counts noted. architecture.md updated with the 5 approved changes. All 02/03 tests unchanged and green.

## Deviations from plan
- **Bulk-path generation fix (Raja 2026-10-01 07:56, option A; SQL gate 08:05), migration `20261001023641_expected_bulk_defer`.**
  - Found by **nightly 36792152274**: 02's import-timing test (RUN_SLOW) hit the 8 s statement limit (`57014`). 04's per-row plan/registration triggers ran generation for every inserted row.
  - Measured on dev (rolled back), one 200-client chunk with GSTIN + GST: 2.85 s without 04's triggers, **9.36 s** with them.
  - Fix: a transaction "defer" mode (`app.expected_defer`). In bulk mode the triggers still waive and restore per row, but only note the client. The outermost bulk call (`enable_group_core`, plus **02's `import_clients` and `create_client`**, outside this plan's file list) then generates once, set-based, through the new `generate_expected_for`. `generate_expected` keeps its signature as a wrapper.
  - Result: **3.09 s** per chunk (same 1,000 plan rows / 600 items; the daily job afterwards finds nothing new). 1,000-client import **22.2 s** (target < 60 s).
  - Guard tests added (expected-docs › "bulk paths generate once per client"). Stored statements md5-verified; advisors show nothing new.
  - **Lesson:** PR CI doesn't run RUN_SLOW, so changes to 02/03 write paths must run the slow tests before merge. Proposed as a CLAUDE.md rule at 04's merge (Raja agreed in principle 2026-10-01).
- **`expected-plan.test.ts:256` fixture date (Raja 2026-10-01 00:3x IST):** a document's received-on changed **2026-10-10 → 2026-10-01**. 03's `RECEIVED_ON_FUTURE` rejects future dates against the real IST date, so this one test would have stayed red until 10 Oct; the 30 Sep plan (option a, "clears at midnight") missed that date. The assertion is unchanged: a received item stays received when its row is removed. It's 04's own unmerged step-1 test. No other test or fixture in the repo uses a received date after today.
- **Volume measurements deferred (Raja 2026-09-29 23:06).** The spec's NFR timings (180k items: job < 60 s, screens < 1 s, save + < 50 ms) run in the volume test once all R1 features are built (roadmap "Before pilot"). The nightly job-ran assertion stays in 04. `tests/rls/expected-perf.test.ts` keeps only that assertion; the volume cases go to the volume-test item.

  Risk: the daily job is the riskiest query at scale, so it is **measured first** in that test.

- **D1 — test clock persists per test office (step 1, 2026-09-30; approved by Raja 2026-09-30 17:34).** `run_expected_generation(p_as_of)` also sets `office.test_today` (honoured only when `is_test`; cleared by `reset_test_office`). Plan changes arrive in separate requests, and AC-2/AC-3/AC-12 tests need them to see the same "today" as the generation run. Real offices always use today in India. One nullable column on `office`; covered by the schema lock.
- **D2 — step 0 merged main into the branch instead of rebasing** (2026-09-30): same result for CI, and no force-push of a published branch.
- **D3 — contract details fixed by the step-1 tests** (for SQL review at step 2): error codes `ROLE_REQUIRED`, `NOT_TEST_OFFICE`, `REASON_REQUIRED`, `NOT_PENDING`, `NOT_RECEIVED`; activity actions `expected.generated` (entity office, data {created, linked}, actor null), `expected.waived` / `expected.waive_undone` / `expected.reopened` (actor = user, data {code …}), `expected.auto_waived` (one per item, actor null); system reasons "Removed from plan" · "Registration inactive" · "Before start period"; a document filed for a **waived** item is linked but the item stays waived until Undo (then received); `completed_by` = first document linked while pending, else the earliest remaining by received on; service-role-only `expected_job_info()` to read the pg_cron job.

- **D4 — linking without a registration (Raja 2026-09-30, option b; spec amended).** A document with no GSTIN/TAN for a per-registration type links to the item of the client's only active registration of that kind; with ≥ 2 active it doesn't link. The document's own `registration_id` stays null. Test: `expected-docs.test.ts` › linking.

- **D5 — `search_clients` overdue counts move to step 7 (approved by Raja 2026-09-30)** (own small migration, same schema lock). Step 2 carries everything the step-1 tests need; the list query is only needed by the Clients screen, and keeping it apart keeps 03b's `search_clients` untouched until then.
- **D6 — resume via `resumed_on` (approved by Raja 2026-09-30)** (new nullable column on `client_doc_type` and `client_group`, set by a BEFORE trigger when a paused/removed row or group becomes active; not granted to users). Generation skips periods whose overdue date had passed on that day, which is AC-12's "resume continues from the earliest still-open period" without moving the stored start period (moving it would auto-waive items still owed from before the pause).
- **Flag for review — one 02 test encodes the old start default:** `tests/rls/plan.test.ts:70` expects the new row to start at the *current* month. AC-3 (approved) changes the default to the earliest still-open period. They agree on days 6–31 of a month (Sales: overdue day 5), but on the 1st–5th the new rule gives the previous month, so that test would fail on those days. Updating that one assertion to AC-3 is a spec-driven change, not weakening a test; it needs Raja's OK (CLAUDE.md rule). **Raja OK'd it 2026-09-30:** the assertion now computes the AC-3 start (the earliest office month whose overdue-from date, the 5th of the next month, is after today in IST).

- **R1 — re-enabling restores not-yet-overdue "Removed from plan" items (Raja 2026-09-30, from the step-2 SQL review).**
  - When a row or group leaves `removed`, its system-waived `removed_from_plan` items whose overdue-from date is after today go back to pending. Linked documents then decide received.
  - Items already overdue stay waived, the same line as resume (AC-12).
  - Each restored item writes one `expected.waive_undone` row (actor null, code only).
  - Follow-up migration applied to dev as `20260930124132_expected_docs_restore.sql` (Raja approved 18:11: reuse `expected.waive_undone`; line = overdue-from after today). Test: `expected-plan.test.ts` › "(R1)".
  - R2 (refuse undo-waive off-plan) was not taken.

## Session log
### 2026-09-29
- Done: intent approved (abfa7a8), spec approved (93f94de), plan approved.
- In progress: — (plan approved 2026-09-29 20:29 IST; locks recorded in the roadmap at batch launch).
- Blocked / failing: build blocked on the `test-isolation` chore (not started). Nightly: 30 Sep 01:30 IST run is the first with #9–#11; check next session.
- Next step: plan approval → Batch C confirmation (Step 3, needs 03b's plan) → roadmap PR (locks) → test-isolation → build step 0.
- Decisions made (cross-cutting → flag for architecture.md): the 5 approved spec changes (pg_cron system writer; FY auto-create from 1 Feb; default start = earliest still-open period; items exist from ask date; metric 1 on Settings › Collection); plan-effect logic in DB triggers; `app.expected_write` flag.

### 2026-09-30
- Done: step 0 — main (908b8ad, with #13–#16) merged into the branch; draft PR #17; CI 36697493473 green. Step 1 — tests written (a929b19): `tests/rls/expected-docs.test.ts` (generation, date maths incl. 31st/29 Feb/FY roll-over, exclusions, fan-out, back-link, linking on save/classify/edit/archive, visibility, write protection, job), `expected-plan.test.ts` (AC-2/3/5/9–12/18), `expected-metric.test.ts` (AC-16), `expected-perf.test.ts` (RUN_SLOW job-ran check), fixtures `tests/support/expected.ts`. Local: lint 0, typecheck 0, unit 172/172.
- Red for the right reasons (confirmed 2026-09-30 15:45 IST, local `test:db` against dev with `.env.local` staged from Raja's Mac): expected-docs, expected-plan and expected-metric all stop in `beforeAll` on one error, `Could not find the function public.run_expected_generation(p_as_of)`, so 63 tests don't run. expected-perf is skipped (no RUN_SLOW). In CI (36699140557) lint, typecheck, unit and build are green; existing files are unchanged since the green step-0 run (36697493473).
- Blocked / failing: —
- Next step: step 2 — the migration (dry-run on dev, SQL review by Raja 45–60 min, apply, advisors, back-fill counts).
- Decisions made (cross-cutting → flag for architecture.md): D1 (per-test-office clock, extends the `app.doc_clock` rule). Raja chose option b for GSTIN-less documents (D4, test added). **CI chore approved** (docs-only PRs/pushes skip the heavy jobs via a changes job; nightly unconditional; the last commit before merge always has a run) — do it **after 04 step 2**, as `chore/ci-docs-only` from main.
- Step 2 (in progress): migration drafted (`supabase/migrations/20260930120000_expected_docs.sql`; renamed to the applied version at apply). Dry-run on dev in one transaction, rolled back by a deliberate error: all DDL, functions, triggers, cron schedule and back-fill ran. Back-fill on Kushal Associates = 0 items (1 client, 12 scheduled rows starting Sep 2026 / Q2 / FY 2026-27; first ask 1 Oct), 7 `expected.generated` rows (one per non-test office), job registered `45 18 * * *`. Rollback verified (no table, extension, column or activity rows left). SQL review: approved by Raja 2026-09-30 17:34 IST (as drafted; R1/R2 from the review offered as an optional follow-up).

### 2026-09-30 (evening)
- Done: SQL gate passed (Raja 17:34 IST: migration as drafted, D1/D5/D6, plan.test.ts:70, timing). Applied to dev as `20260930120658_expected_docs` (the stored statements are byte-identical to the file; the file was renamed to match). Advisors: the only new WARN is `run_expected_generation`, a SECURITY DEFINER function executable by `authenticated`. That is intended (D1: Admin of an is_test office only). Unused-index INFO on the empty `expected_doc`. Back-fill: 0 items, 7 `expected.generated` rows, job `expected-docs-daily` `45 18 * * *` active. `tests/rls/plan.test.ts:70` updated to AC-3.
- Local verification: lint 0, typecheck 0, unit 172/172. `test:db`: 13 files and 202 tests pass, 4 skipped (RUN_SLOW). That includes plan.test.ts, expected-docs and expected-metric.
- Blocked / failing: `expected-plan.test.ts` 6/24 fail. Cause: the tests file documents with received on **2026-10-01**, and 03's document trigger refuses a future received-on against the **real** IST date (`RECEIVED_ON_FUTURE`). Today is 30 Sep; from 1 Oct IST that date is in the past. 3 tests fail directly; 3 fail as a knock-on (they expect items those documents would have completed). Not a 04 SQL defect. Tests unchanged.
- Next step: Raja chooses. (a) Re-run after 00:00 IST 1 Oct, with no code change, and check the 00:15 job run at the same time. (b) D7: 03's received-on check uses `private.office_today` (the test clock in is_test offices only), via a small follow-up migration under 04's schema lock.
- Decisions made (cross-cutting → flag for architecture.md): pg_cron job live on dev; migration version 20260930120658.
- R1 (18:10): the test was written and is red for the right reason (the item stays waived after re-enabling Banking). The migration was drafted and dry-run on dev (rolled back; verified). **Waiting: Raja's SQL review of R1.** Option (a) chosen for the date issue: re-run after 00:00 IST, with no code change.
- R1 applied (18:12) as `20260930124132_expected_docs_restore`. The stored statements match the file (md5), and the advisors show nothing new. `expected-plan` is 19/25: the R1 test is green, and the 6 failures left are the dated-1-Oct ones (option a). Next: after 00:15 IST on 1 Oct, check `cron.job_run_details` and Kushal's `expected.generated` row; run the full `test:db`; push without [skip ci]; CI green → tick step 2.

### 2026-10-01 (00:15–00:45 IST)
- **First cron run:** `expected-docs-daily` succeeded at 00:15:00 IST in 0.30 s. It wrote 8 `expected.generated` rows (one per non-test office, actor null).
- **Kushal Associates: 0 items created, which is correct.** The handoff's "first real items expected" was wrong.
  - Every monthly row starting Sep 2026 (asked from 1 Oct) is per-GSTIN/TAN, and the client has no active registration (AC-5: nothing expected).
  - The rows without a registration aren't due yet (Form 16A Q2 from 1 Dec; the yearly items from Apr–May 2027).
  - Proven with a rolled-back dry-run on dev: adding a GSTIN made the registration trigger create exactly the 3 GSTIN items due 1 Oct (Sales Sep and Credit/debit notes Sep, overdue from 5 Oct; Purchase Q2, overdue from 10 Oct).
- `expected-plan.test.ts` after midnight: 5 of the 6 date failures cleared. The 6th had a received date of 2026-10-10, so the fixture date was fixed (see Deviations; Raja approved). The file is now 25/25.
- Full local `test:db` (before the fix): 226 pass, 1 fail (that test), 4 skipped (RUN_SLOW). The fix was then verified on the whole file.
- **Step 2 done: CI 36763084116 green** (1b01dac, 00:55 IST: lint, typecheck, unit, build, RLS + e2e).
- Next step: step 3 (`schedule.ts` + derived state, unit tests red → green).
- Decisions made (cross-cutting → flag for architecture.md): — (03b's search functions `20260930131025_document_search` are on dev too: additive and invoker, untouched by 04).

### 2026-10-01 (07:44–08:20 IST)
- Nightly 36792152274 on main (4db150c = #20 roadmap docs) **failed**: RLS step, 2 tests. Reproduced locally on a main worktree with RUN_SLOW.
  - `plan.test.ts:70` (start period, expected 2026-10, got 2026-09): main's test predates 04's AC-3 change, and dev already runs 04's rule. It clears when 04 merges (this branch carries the updated test). On 30 Sep both rules agreed; they diverge from 1 Oct.
  - `import.test.ts` 1,000-client timing: **a real 04 regression** → fixed (see Deviations).
- After the fix: full local `test:db` **with RUN_SLOW: 233/233** (16 files); import timing 22.2 s.
- In progress: CI on this push.
- Next step: CI green → step 3 (`schedule.ts`). Main's nightly keeps failing `plan.test.ts:70` until 04 merges (expected); the import failure should be gone from the next nightly.
- Decisions made (cross-cutting → flag for architecture.md): `app.expected_defer` joins the transaction-flag list; the RUN_SLOW-before-merge rule for features touching 02/03 write paths (CLAUDE.md, at merge).

