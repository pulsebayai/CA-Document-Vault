# Plan: Cross-firm security sweep
Spec: ./spec.md · Status: **draft — awaiting approval** · Date: 2026-11-04

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
- [ ] 0. Locks PR on main (roadmap: locks → 18, row 18 in progress); rebase the branch. — proof: roadmap on main
- [ ] 1. Inventory migration + `guard.test.ts` with an **empty** `coverage.ts`. The guard is red, listing every object (expected). The AC-3 grant test is green. Apply to dev, md5. — proof: `npx vitest run --project db tests/rls/cross-firm/guard.test.ts` shows the full missing list; the grant cases pass
- [ ] 2. `seed.ts` + `helpers.ts`. Seed both firms on dev as signed-in staff; time it. Time a sample of 20 cases to project AC-15. — proof: the seed run log (row count per table per firm; every firm table ≥ 1); projected PR time
- [ ] 3. **Tables** (AC-4, AC-5): read / write-B / insert-into-B / cross-reference per FK, table-driven. Fill `coverage.ts` for tables and the view. **Any red cross-reference case = a leak → step 3a.** — proof: `tables.test.ts` run log
  - [ ] 3a. *(only if leaks)* Fix migration(s), tenant-first parent checks in the table's before-write trigger, failing-first: the red run is recorded before the fix. RUN_SLOW dispatch if a 02/03 write path changes (CLAUDE.md).
- [ ] 4. **Functions** (AC-6–AC-8): 63 cases with snapshot before and after; `dsc_reveal` and `run_expected_generation` as Admin and Limited; aggregate reads checked for B's markers. Fill the map. Leaks → as 3a. — proof: `functions.test.ts` run log
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
(none yet)
