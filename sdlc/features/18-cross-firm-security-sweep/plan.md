# Plan: Cross-firm security sweep
Spec: ./spec.md · Status: **approved** (Sidambara, 2026-11-04) · Date: 2026-11-04

## Locks
- At plan approval, on main (small roadmap PR): **schema lock → 18, architecture lock → 18** (spec X1), row 18 status `in progress`.
- Released at 18's merge.

## Files that change
| Path | New/modified | Why |
|---|---|---|
| `supabase/migrations/202611040xxxxx_test_schema_inventory.sql` | new | `public.test_schema_inventory()` (X1, AC-3): definer, `search_path = ''`, service role only; returns tables (RLS flag, has `office_id`, policies by command, FKs to firm-owned parents), views (`security_invoker`), functions (schema, definer, argument names and types, executable by anon / authenticated / service_role), Realtime publication tables |
| `tests/rls/cross-firm/seed.ts` | new | two firms, 3 roles each, a row in every firm table, B's markers (AC-1) |
| `tests/rls/cross-firm/helpers.ts` | new | `asFirmA(role)`, `snapshot()`, `expectUnchanged()`, `expectRefusedOrEmpty()`, `markersOf()` (X4, X5) |
| `tests/rls/cross-firm/coverage.ts` | new | the map: object → case(s) or exemption + reason (X2) |
| `tests/rls/cross-firm/guard.test.ts` | new | AC-2, AC-3 |
| `tests/rls/cross-firm/tables.test.ts` | new | AC-4, AC-5 (table-driven from `coverage.ts` + the inventory's FK list) |
| `tests/rls/cross-firm/functions.test.ts` | new | AC-6–AC-8 (one case per function, B's IDs in every ID argument) |
| `tests/rls/cross-firm/links.test.ts` | new | AC-9, AC-10 |
| `tests/rls/cross-firm/storage.test.ts` | new | AC-12 (a) direct Storage as A; (b) `currentFiles`, `getFileLink`, `startUpload`/`addVersionAction` document check, bulk listing, with `@/lib/supabase/server` mocked to A's signed-in client |
| `tests/e2e/cross-firm.spec.ts` | new | AC-13 |
| `sdlc/product/architecture.md` | modified (architecture lock) | one cross-cutting rule (spec › Proposed architecture changes) + decision-log row |
| `sdlc/releases/R1/evidence/cross-firm-sweep.md` | new | AC-14 report for the Kushal demo |
| `CLAUDE.md` | modified | one line under Rules: new table/view/function → cross-firm case in `coverage.ts` |
| leak fixes (if any) | new migration(s) | X8; listed in Deviations as found |

The `db` vitest project already globs `tests/rls/**/*.test.ts`, so there is no config change. CI needs no workflow change: the RLS job runs the whole folder.

## Migrations
One: `…_test_schema_inventory.sql`, plus one per leak fix (X8). Each is applied to dev before review, with the live function md5 checked against the file and recorded in the PR. Then a Regression `only` = `rls/cross-firm` dispatch (CLAUDE.md).

## Steps
- [x] 0. Locks PR on main (roadmap: locks → 18, row 18 in progress); rebase the branch. — proof: roadmap on main
- [x] 1. Inventory migration + `guard.test.ts` with an **empty** `coverage.ts`. The guard is red, listing every object (expected). The AC-3 grant test is green. Apply to dev, md5. — proof: `npx vitest run --project db tests/rls/cross-firm/guard.test.ts` shows the full missing list; the grant cases pass
- [x] 2. `seed.ts` + `helpers.ts`. Seed both firms on dev as signed-in staff; time it. Time a sample of 20 cases to project AC-15. — proof: the seed run log (row count per table per firm; every firm table ≥ 1); projected PR time
- [x] 3. **Tables** (AC-4, AC-5): read / write-B / insert-into-B / cross-reference per FK, table-driven. Fill `coverage.ts` for tables and the view. **Any red cross-reference case = a leak → step 3a.** — proof: `tables.test.ts` run log
  - [x] 3a. *(only if leaks)* Fix migration(s), tenant-first parent checks in the table's before-write trigger, failing-first: the red run is recorded before the fix. RUN_SLOW dispatch if a 02/03 write path changes (CLAUDE.md).
- [x] 4. **Functions** (AC-6–AC-8): 63 cases with snapshot before and after; `dsc_reveal` and `run_expected_generation` as Admin and Limited; aggregate reads checked for B's markers. Fill the map. Leaks → as 3a. — proof: `functions.test.ts` run log
- [ ] 5. **Service-role functions + private definers** (AC-9–AC-11): `links.test.ts`; map the 60 private definers to the cases that reach them; exemptions with reasons. Guard green. — proof: `guard.test.ts` + `links.test.ts` green
- [ ] 6. **Storage + screens** (AC-12, AC-13): `storage.test.ts`; `cross-firm.spec.ts` run locally (`playwright.local.config.ts`). — proof: both run logs
- [ ] 7. Full local run of `tests/rls/cross-firm` on dev + timing (AC-15). The existing suite is untouched (AC-16): the full RLS run on dev in the session. — proof: timings in the session log
- [ ] 8. Docs: the architecture rule + decision row, the CLAUDE.md line, the evidence report (AC-14; final run IDs after CI). — proof: diff
- [ ] 9. `verifier` → `sdlc-reviewer` (focus: cases that pass for the wrong reason, e.g. a refusal caused by a bad argument instead of the tenant check) → fix Important findings failing-first → PR with the AC → test → result table → dev Regression `only` = `rls/cross-firm e2e/cross-firm`. — proof: CI green on the last code commit

## Proving a refusal is the *tenant* refusal (review focus)
A case can pass for the wrong reason: a malformed argument, a missing required field, or a role check that fires first. To rule that out, every function and cross-reference case also runs a **control** with the same call and Firm A's own IDs, and the control must succeed (or return A's rows). A case without a passing control fails. This roughly doubles the calls; it's included in the AC-15 projection at step 2.

## Estimate
[Uncertain] 3–5 working days with no leaks: steps 1–2 ≈ 1 day, 3–5 ≈ 2–3 days, 6–9 ≈ 1 day. +1–2 days per family of cross-reference leaks (spec risk 1).

## Risks
- Controls double the time. If AC-15 is missed on local stacks, give `cross-firm` its own parallel RLS job in CI. No case is dropped.
- The seed on dev from GitHub's runner is slow (≈ 1 s per call, about 150 calls ≈ 2.5 min in the nightly). Acceptable.
- Server actions read cookies through `@/lib/supabase/server`. Mocking it with a signed-in client tests the action's own queries, not Next's cookie handling, which 01's auth tests already cover.

## Deviations
- **D1 (step 1):** the inventory's first run found six of 02's private trigger functions still executable by PUBLIC/anon (`client_before_write`, `client_doc_type_before_write`, `client_group_before_write`, `contact_before_write`, `doc_type_before_write`, `registration_before_write`). Not reachable (trigger functions can't be called directly; `private` isn't exposed by PostgREST), but revoked in the inventory migration so the guard's "nothing for anon" rule needs no exception.
- **D2 (step 1–3):** the inventory also returns each table's insert/update column grants, so cases are built from writable columns only; and every case returns only the key column (a `returning *` on `dsc` / `upload_request` hits the column grant and would make any insert look refused).
- **D3 (step 2):** one test file (`sweep.test.ts`) instead of four: the seed takes ≈ 2 min on dev from a session and the `db` project runs files one at a time, so the sections share one seed. Run time on dev: ≈ 5 min for the table cases incl. seed.
- **L-1 (leak, fixed, step 3a):** `period_insert` checked only the new row's office, so Firm A's Admin could insert a period of Firm A attached to **Firm B's financial year**. Nothing of B was readable or changed. Red run on 5dad702 (`period.financial_year_id: LEAK`); fix `20261104110000_period_fy_office.sql` (`alter policy`: the year must be the caller's own) applied on dev 2026-11-04 with the owner's approval; re-run green (`control ok`: A's own year accepted, B's refused). 02's tests that add years (`clients-catalogue`, `role-matrix`) green: 139/139. No 02/03 write path changed (period insert is Admin-only and rare), so no RUN_SLOW.
- **Table results (X4.4):** 21 refusals by a named tenant check (`CLIENT_OFFICE`, `PERIOD_OFFICE`, `GROUP_OFFICE`, `PLAN_MISMATCH`, `ASSIGNEE`, `INCHARGE`), 35 closed for every caller (writes only through the vault's functions), 6 attempts accepted without storing the value, 0 inconclusive.
- **Function results (step 4, 2026-11-04):** all 63 staff-callable functions, 98 attempts, **0 leaks**. Writes: 61 refused by a named check (`NOT_FOUND`, `*_OFFICE`, `ITEMS_INVALID … this client's`, `PATH`), 6 refused where the same call on Firm A's own object succeeded, 2 accepted but did nothing (`review_documents` / `set_custody` skip IDs they can't see). Reads: 20 attempts return nothing of Firm B's (IDs or marker text). Firm-wide figures: Firm C (an empty firm) gets all zeros from the 6 metrics. 4 own-office functions (no ID argument) leave Firm B unchanged (snapshot). Firm A's activity and notifications name nothing of Firm B's. Full sweep on dev from a session: 129 tests, ≈ 6 min incl. seed.
- **D4 (step 4):** a third, empty Firm C proves firm-wide aggregates (metrics, queue, Today) never count another firm: any non-zero would be someone else's. Each function's control runs **after** its attempts, so a control that changes Firm A (a merge, an archive) can't be why a mixed attempt failed.
