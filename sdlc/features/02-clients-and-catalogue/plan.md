# Plan: Clients and document catalogue
Spec: ./spec.md · Seed: ./seed-catalogue.md · Status: approved (2026-09-26, Raja; D1 + D2 approved) · Date: 2026-09-26
Holds: **schema lock** (roadmap) + **architecture lock** for spec's 5 approved changes (applied to architecture.md at merge).

## Files that change
| Path | New/Mod | Why |
|---|---|---|
| supabase/migrations/<ts>_clients_catalogue.sql | new | enums, 10 tables, counter, helpers, RLS, triggers, indexes, SQL functions (below) |
| supabase/migrations/<ts>_seed_catalogue.sql | new | `private.seed_catalogue(office_id)` + run for the existing office; FY 2025-26/2026-27 periods |
| src/lib/validation/{identifiers,client,catalogue,csv}.ts | new | shared zod schemas: PAN / GSTIN / TAN / mobile / PAN-letter↔type; form + CSV use the same rules |
| src/lib/validation/gst-states.ts | new | 37 GST state codes (static map) |
| src/lib/clients/{queries,actions}.ts | new | list/search, create/update/archive/unarchive, import |
| src/lib/catalogue/{queries,actions}.ts | new | groups/types/FY upserts, add next FY |
| src/lib/plan/actions.ts | new | enable/disable group, update group/type, add type |
| src/lib/csv/parse.ts | new | Papa Parse wrapper + row validation → preview model (browser), same validator re-run on server |
| src/app/(app)/clients/page.tsx | mod | empty state → list, search, filters, pagination |
| src/app/(app)/clients/clients-view.tsx | new | presentational list + empty state (props in, no data fetching) |
| src/app/(app)/clients/new/page.tsx, client-form.tsx | new | Add client (also used for Edit) |
| src/app/(app)/clients/[id]/page.tsx, settings/*.tsx | new | client header, card, tabs, collection plan (mockup 11) |
| src/app/(app)/clients/import/*.tsx | new | upload → preview → result |
| src/app/(app)/settings/layout.tsx, settings/catalogue/*.tsx | new | Settings sub-nav (Users: admin; Catalogue: everyone, read-only below Manager) |
| src/components/app-header.tsx | mod | "Settings" visible to all staff (catalogue is readable by all, AC-6) |
| src/components/ui.tsx | mod | Switch, Tabs, Table, Dialog primitives if not present |
| src/lib/activity.ts | mod | typed action names for 02; PII-key guard (throws in tests if data has pan/email/mobile/gstin keys or values) |
| tests/rls/clients-catalogue.test.ts, tests/rls/plan.test.ts, tests/rls/import.test.ts | new | DB/RLS tests (written first) |
| tests/unit/{identifiers,csv,client-schema,clients-view}.test.ts(x) | new | validators, CSV rules, list view |
| tests/e2e/{catalogue,clients,import,client-plan}.spec.ts | new | e2e per spec test strategy + axe on new screens |
| tests/support/{db,test-data}.ts | mod | catalogue/client fixtures, synthetic PAN generator, `purgeTestClients()` |
| tests/fixtures/clients-*.csv | new | synthetic CSVs (valid, errors, duplicates, 1,000 rows generated at run time) |
| .github/workflows/regression.yml | mod | `RUN_SLOW=1` so the 1,000-row import test runs nightly only |
| package.json, package-lock.json | mod | `papaparse` (+ types) |

## Migrations (schema lock: 02)
1. `<ts>_clients_catalogue.sql` — enums `client_type, frequency, period_kind, plan_state, registration_kind, doc_source`; `office.client_code_counter`, `office.is_test`; tables per spec; `pg_trgm` indexes (client.name, previous_reference); FK indexes; RLS default-deny + policies; `private.can_see_client()`; column grants for incharge/archive/pause columns + guard trigger; `forbid_delete` trigger on all new tables.
   SQL functions (security invoker unless noted — RLS still applies):
   - `private.next_client_code(office_id)` (security definer, row lock on office) → `C0001…`
   - `public.enable_client_group(client, group)` / `disable_client_group(...)` — copy/restore in one transaction (AC-19/21)
   - `public.import_clients(rows jsonb)` — ≤200 rows per call, one transaction, re-validates PAN/GSTIN rules in SQL checks (AC-16)
   - `private.add_financial_year(office)` — FY + 12 months + 4 quarters + 1 year (AC-5)
   - `private.purge_test_office_data(office_id)` — **service role only, refuses unless `office.is_test`**; sets a transaction flag the `forbid_delete` trigger honours. Needed because clients can't be deleted, but CI would otherwise add ~1,000+ clients to dev every night.
2. `<ts>_seed_catalogue.sql` — `private.seed_catalogue(office_id)` from seed-catalogue.md (46 client documents + 9 firm records, 10 groups, none enabled for new clients); applied to the existing office.
Applied to **dev only** (project ysddbwskljzhbjjohool) via `apply_migration` after RLS tests are written; staging/prod get them at release.

## Steps (estimates = build sessions with Claude; your review time in brackets)
- [x] 0. Wait for evidence-fix PR merge → rebase on main → full suite green — proof: CI run with Unit + RLS + E2E rows [5 min]
- [x] 1. **Retarget the one skeleton test** (decision D1 below) — `clients-page.test.tsx` renders the new `ClientsView` with 0 clients; same assertions (heading, "0 clients") + empty-state text — proof: fails on current code (component missing), passes after step 7 [approve D1]
- [x] 2. RLS/DB tests first (red): tenant isolation on all 10 tables; staff/limited catalogue writes denied (AC-6); incharge/archive Admin/Manager only (AC-10/11); DELETE rejected; limited sees only assigned (AC-12); PAN partial-unique; firm-source check (AC-1); code sequence no gaps/reuse; activity has no PII values (AC-23) — proof: `npm run test:db` fails for the right reasons (1 session)
- [x] 3. Migration 1 written, reviewed, applied to dev; Supabase security + performance advisors clean — proof: step-2 tests green except seed/plan/import ones (1 session) [review SQL: 30 min]
- [x] 4. Migration 2 (seed + FY/periods) + `add_financial_year` — proof: DB tests AC-1, AC-5 (2 × 17 periods, duplicate FY rejected) (0.5)
- [x] 5. Shared validators + GST states — proof: unit tests for every AC-9 rule incl. warn-only letters (G/L/J, society/co-op) (0.5)
- [ ] 6. Catalogue screen + actions + Settings sub-nav + nav change — proof: e2e admin edits a type; staff sees read-only; AC-4 DB test (master edit leaves client copies unchanged) (1)
- [ ] 7. Clients list: search (name/code/PAN/GSTIN/prev ref), filters, archived toggle, 50/page; **no query text in URL** (state in form + POST/server action) — proof: e2e AC-7 asserts `page.url()` never contains search text; step-1 test green; 1,000-client list < 1 s server time (DB timing test) (1)
- [ ] 8. Add / edit / archive / unarchive client (+ registrations, groups at create, code) — proof: e2e add client; DB AC-10/11 green; activity rows (1)
- [ ] 9. Client › Settings: header, card, tabs, groups & types, enable/disable/pause/remove/restore, "+ Add type" — proof: DB AC-19/20/21 (no duplicates on re-enable, firm records never copied); e2e enable group (1.5)
- [ ] 10. CSV import: template, browser preview, server re-validation, chunked `import_clients`, result + error-row download — proof: unit CSV tests (header, limits, in-file + DB duplicates, name warnings); e2e happy path + error file round-trip; AC-17 1,000 rows < 60 s nightly (`RUN_SLOW=1`) (1.5)
- [ ] 11. Accessibility (axe on 5 new screens) + empty/loading/error states + screenshots vs mockups 03/05/11 — proof: 0 serious/critical; screenshots in PR (0.5)
- [ ] 12. AC-22 timed manual check with a staff member (≤ 2 min) — proof: time recorded in PR [you: 10 min]
- [ ] 13. `verifier` full suite → `sdlc-reviewer` → fix Important → PR with AC → test → result table — proof: CI green, evidence shows all three suites [PR review: 1–2 h]
**Total ≈ 10 build sessions ≈ 4–5 working days elapsed; your review ≈ 4–5 h.** Calibration: 01 (13 steps) went intent → shipped in ~1 day, but 02 has ~4× the surface (10 tables, 5 screens, import). [Likely] No scope deferral needed; if step 10 slips past 1.5 sessions, error-row download is the first cut.

## Risks
| Risk | Mitigation |
|---|---|
| RLS recursion / perf: `can_see_client` reads client_group which is itself client-scoped | helper is `security definer` + `stable`, reads base tables directly; indexed on (client_id, assigned_staff_id); explain-analyze on 1,000 clients |
| Limited role leaks via SQL functions | functions are security invoker (RLS applies); definer only for code counter + purge; DB tests call each function as limited |
| Import partial failure | 200-row chunks each atomic; result shows which chunk failed; re-upload is idempotent via PAN duplicate rule |
| Migration mistake on shared dev DB | additive only; tests written first; advisors checked; rollback = compensating migration (no real data) |
| Test data growth in dev (no-delete rule) | `purge_test_office_data` limited to `is_test` offices, service role only; DB test proves it refuses a non-test office |
| PII in logs / activity / URL | activity PII guard; e2e URL assertion; server errors for import rows returned only to the uploader, never logged with values |
| Concurrency: nightly + PR runs share dev | existing CI concurrency group; 1,000-row test nightly only |
Rollback: dev only → revert PR + compensating migration.

## Proof of done
AC-1…23 → test file → result table in the PR; CI green with Unit + RLS + E2E evidence rows; screenshots vs mockups 03/05/11; AC-22 time recorded; architecture.md updated at merge with the 5 approved changes + `doc_type.source`.

## Decisions for the plan gate
- **D1 (test rule):** `tests/unit/clients-page.test.tsx` renders the page component synchronously; once the page fetches data it can't render in a unit test. Proposal: point the test at the new presentational `ClientsView` with the **same assertions plus** the empty-state text — not weaker, and the behaviour it guards (0 clients → heading + "0 clients") is unchanged. Needs your explicit OK because the rule is "never edit a test".
- **D2 (test data):** add `office.is_test` + service-role-only purge for test offices (above). Alternative: never purge, and accept dev growth (~1,000 rows/night from AC-17).

## Deviations from plan
- Step 5 done before steps 2–4 (2026-09-26): pure code, fully verifiable in the local VM; DB steps need CI. No dependency on the schema.
- GST state list = 01–38 + 97 (spec said "37 codes"; Ladakh 38 and legacy 25/28 included so older GSTINs validate). GSTIN 14th char not forced to "Z" (TDS/NRI registrations use other letters); GSTIN check-character is **not** verified (not in spec) — candidate for later if typos show up in the pilot.
- PAN letter rules: AOP/BOI accept A or B (BOI PANs use B); G/L/J always warn-only.
- Step 0: base proof = Regression #3 on main 581c64d (Unit 15, RLS 10, E2E 14, one table); 02 rebased onto it 2026-09-26.
- Step 1: minimal `ClientsView` added now (not in step 7) so the retargeted test goes red → green in one step; page renders it with 0 clients until step 7. Empty-state hint text changed from "Clients are added in the next release" to "Add a client or import a CSV to get started." (no test asserted the old text).

- Step 2 (2026-09-27) — tests fix these interface choices for step 3 (S1–S3 approved by Raja 2026-09-27):
  - Counts corrected: seed = **47** client documents (plan said 46) + 9 firm records; new tables = **9** (plan said 10).
  - Service-role test helper is `public.reset_test_office(office_id)` (not `private.purge_test_office_data`): PostgREST can't call functions in `private`, so it lives in `public` with EXECUTE revoked from anon/authenticated. It purges client data, restores catalogue + FYs to the seed and resets the code counter; refuses unless `office.is_test`. Existing "e2e office %" rows are flagged `is_test` in migration 1.
  - `public.add_financial_year()` (not `private.`) so the Admin screen can call it; security invoker, RLS = Admin only.
  - New `public.add_client_doc_type(client, doc_type)` for "+ Add type" (copies master defaults; refuses firm records / inactive types).
  - SQL functions (enable/disable group, import, add FY) write their `activity` rows in the same transaction.
  - **S1** DB-level `ACTIVITY_PII` guard trigger on `activity` (rejects PII keys or PAN/GSTIN/email/mobile-shaped values anywhere in `data`) — additive trigger on a 01 table; stronger than the TS-only guard in the plan.
  - **S2** Assigning staff (group or type) is Admin/Manager only, like incharge — assignment decides what Limited users can see. Spec AC-20 is ambiguous here.
  - **S3** Re-enabling a group restores each type's pre-disable state (removed stays removed, paused stays paused); needs a `state_before_disable` column.
  - `client.code` has no INSERT/UPDATE grant — never client-supplied; counter increments inside the insert transaction, so a failed insert leaves no gap.

- Steps 3–4 (2026-09-27): both migrations written together, dry-run on dev inside a rolled-back block, reviewed and approved by Raja, applied to dev as `20260927070322_clients_catalogue` + `20260927070427_seed_catalogue`. `reset_test_office` lives in migration 2 (it needs the seed). Security advisor: no new findings; performance: only "unused index" INFO (empty tables). Interpretations accepted at review: archived clients can't enable groups; FY always starts in April (`office.fy_start_month` ignored). **Proof still pending: CI run of the step-2 DB tests against the new schema.**

- CI run 36302068412 (b3c052e): DB suite 53 passed · 1 failed · 1 skipped (AC-17 nightly). Failure = `clients-catalogue › tenant isolation › cannot write into another office`: rejected by `INCHARGE`, not the tenant boundary — the SECURITY DEFINER client trigger locked/incremented the *other* office's code counter before RLS denied the row. Code fix (test unchanged): migration `20260927071425_client_trigger_tenant_first` checks office first (`OFFICE_DENIED`); verified on dev by impersonation (counter untouched). E2E did not run in that job (stops at first failing step), hence "Evidence incomplete".

## Session log
### 2026-09-26
- Done: intent approved; spec + seed catalogue approved (rev 2: catalogue = documents from the client; firm records separate, `doc_type.source`); 5 architecture changes approved; no groups pre-ticked; challans stay client documents. Plan drafted.
- In progress: plan gate.
- Blocked / failing: nothing pushed — Mac git has no GitHub credentials (Raja running `gh auth login`); evidence-fix PR not open yet.
- Next step: plan approval → step 0 after evidence-fix merge.
- Decisions made (cross-cutting → flag for architecture.md): spec's 5 changes + `doc_type.source client|firm`; `office.is_test` + purge function (if D2 approved).

### 2026-09-26 (evening)
- Done: plan approved (D1, D2). Evidence fix merged (PR #3); CI #21 and Regression #3 on main 581c64d show Unit 15 / RLS 10 / E2E 14. 02 rebased onto main. Steps 0–1 done (ClientsView + retargeted test; unit 15/15, lint 0, typecheck 0 — run locally in the device VM, which works for unit/lint/typecheck).
- In progress: —
- Blocked / failing: none. Rebased branch not yet force-pushed (Raja: `git push --force-with-lease origin feat/02-clients-and-catalogue`).
- Next step: step 2 — RLS/DB tests first (red), then step 3 migration.
- Watch in step 7: `tests/e2e/auth.spec.ts:44` expects "No clients yet" in its fixture office → client e2e tests must use a separate fixture office.
- Decisions made (cross-cutting → flag for architecture.md at merge): spec's 5 changes + `doc_type.source`; `office.is_test` + purge function. Debt: GitHub Actions on Node 20 (bump action versions); `ubuntu-latest` → Ubuntu 26 on 19 Oct 2026 (pin `ubuntu-24.04` before then).

### 2026-09-26 (late)
- Done: step 5 — `src/lib/validation/{identifiers,gst-states,client}.ts` + 2 unit test files (red → green); unit 65/65, lint 0, typecheck 0.
- Next step: step 2 (RLS/DB tests, red) → step 3 (migration 1 to dev) → step 4 (seed). Steps 0, 1, 5 done.
- Raja to push: `git push origin feat/02-clients-and-catalogue` (fast-forward, no force needed).

### 2026-09-27
- Done: step 2 (DB/RLS tests, 3 files + helpers; S1–S3 approved); steps 3–4 (migrations applied to dev, advisors clean). Unit 67/67, lint 0, typecheck 0.
- In progress: proof of steps 2–4 = CI run of `npm run test:db` on this branch.
- Blocked / failing: DB tests can only run in CI (sandbox can't reach Supabase) — Raja to push.
- Next step: fix anything the CI DB run shows (code, never the tests unless a test is provably wrong — flag it), then step 6 (catalogue screen).
- Decisions made (cross-cutting → flag for architecture.md at merge): DB-level ACTIVITY_PII guard on `activity` (S1); assignment = Admin/Manager (S2); service-role-only helpers live in `public` with EXECUTE revoked (PostgREST can't reach `private`); `app.plan_bulk` / `app.purge_office` transaction flags honoured by triggers.
