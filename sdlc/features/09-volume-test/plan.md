# Plan: R1 volume test
Status: approved (Raja 2026-10-07 08:05) · Date: 2026-10-07 · Branch: `chore/09-volume-test` (from main 8a10ec6; nightly 37548131373 green)
Kind: **chore, R1 gate** (roadmap › Before pilot). No intent/spec: every target below is already approved in a feature spec; this plan **only measures and records** them.
**No app-code or fix changes (Raja 2026-10-07):** a missed target is recorded as a known performance issue (roadmap › Later, with the measured time, the query plan and the likely fix), to be fixed later. A timing near the 8 s statement timeout is flagged as such in the record (it shows as an error, not slowness).
Holds: **schema lock** for the test-only seeding migration only. No architecture lock.

## Targets (all at pilot volume, on dev Nano)
| # | From | What | Target |
|---|---|---|---|
| V1 | 03b AC-12 | Header suggestions (`search_documents` top 5 + `search_clients`) | < 300 ms server |
| V2 | 03b AC-12 | `/documents` first page + facets | < 1 s |
| V3 | 03b AC-12 | Limited user's search | < 1 s |
| V4 | 04 NFR | Daily job (`private.run_office_expected`) at ~180k items | < 60 s |
| V5 | 04 NFR | Clients list with overdue counts · Client › Expected · Client › Documents | < 1 s each |
| V6 | 04 NFR | Collection metric | < 2 s |
| V7 | 04 NFR | A document save, linking trigger included | + < 50 ms vs empty office |
| V8 | 06 AC-6 | Today for a staff member with ~150 clients | ≤ 1 s |
| V9 | 08 AC-15 / nit 3 | First Activity page (Staff and Limited) · `/activity?client=` · document Activity card | < 1 s each |
| V10 | 08 AC-15 | Bulk Mark reviewed, 200 documents | < 5 s |
Not here: 05's 1,000-document merge (already in RUN_SLOW; re-timed on staging), 02/03 list timings (already nightly), 08's 30-file zip (manual, staging).

## Volume (one test office, `e2e office volume`)
- **1,000 clients** (top of product.md's range), via `import_clients` as a signed-in user (02's rule: the service role can't write clients).
- **~15 scheduled plan rows each × 12 months ≈ 180k expected items**, generated on the test clock (04's `office.test_today`).
- **10k documents** (Raja 2026-09-29), spread over the clients and periods so about 5% of items link. **70% soft copies with real 1-byte storage objects** (so file-name search and zip lists hit `document_version`), 30% hard copies/originals; 100 left in the Inbox.
- **200k activity rows** (08 spec: about a year). The real writes give ~40k; the rest is a synthetic top-up with the real action mix, test offices only.
- Users: Admin, Manager, Staff (incharge of 150 clients → V8), **Limited** (assigned 50 clients → V3, V9).

**The office persists.** It is seeded once (~10–15 min: mostly the 7k storage uploads) and checked by row counts at the start of each run. It is re-seeded only when a count is wrong or `VOLUME_RESEED=1`. Writes the test makes (V7 save, V10 review) are undone, or use their own small client, so the office stays fixed. Dev grows by ≈ 100–150 MB (110 MB today).

## How it's timed
Same as the existing perf tests: real queries the app runs, through PostgREST as the right user, median of 5 warm calls (PR #30's rule). **Server time ≈ round trip − a ping** (median of 5 trivial RPCs from the same runner), because the US runner → Mumbai round trip (~200–250 ms) would by itself nearly fail V1's 300 ms. Both numbers go in the evidence. V4 is timed inside the database (it runs in pg_cron, not over the API).

## Where it runs
**On demand only, not nightly:** `VOLUME=1`, through a new `volume` input on `regression.yml` (its own concurrency group, so only one volume run at a time) or locally from a session. It runs once for this chore, and again at the R1 gate as evidence. *Alternative: add it to the nightly at ~2–3 min extra once seeded. Rejected for now: two lanes overlapping would distort the timings.*

## Files that change
| Path | New/Mod | Why |
|---|---|---|
| supabase/migrations/20261007043837_volume_seed.sql | new | `seed_test_documents(p_count int, p_template jsonb)`: SECURITY INVOKER, loops 03's `create_document`, refused unless the caller's office `is_test`. `seed_test_activity(p_count int)`: same guard; synthetic rows that pass `ACTIVITY_PII`. Approved in principle by Raja 2026-09-29 (03b plan); activity top-up is new |
| tests/support/volume.ts | new | get-or-seed the office, count check, fixture users, storage uploads (10 parallel), ping, median timer |
| tests/rls/volume.test.ts | new | V1–V10, `describe.skipIf(!process.env.VOLUME)` |
| tests/rls/volume-seed.test.ts | new | the seed functions are refused in a non-test office and for Limited (always runs; fast) |
| tests/support/search.ts, tests/rls/document-search-perf.test.ts | — | deferred from 03b; **folded into volume.test.ts** instead of created |
| tests/support/db.ts | mod | `createStaff` optional fixed email (lane-independent volume users) |
| tests/unit/regression-summary.test.ts | mod | the volume table in the evidence summary |
| scripts/volume-generate.sql, scripts/volume-v4.sql | new | seeding part 0/B and V4, run as the database owner (see Deviations) |
| .github/workflows/regression.yml | mod | `volume` input → `VOLUME=1`, concurrency group `volume`, timeout |
| scripts/regression-summary.mjs | mod | a "Volume timings" table (target, server ms, round trip ms, pass/fail) |
| sdlc/releases/R1/evidence/volume-dev.md (+ `volume-dev-local-2026-10-07.json`) | new | timings table, known issues K1–K5, run URL |

## Steps
- [ ] 0. Roadmap PR on main (your OK): row 09 "volume-test (chore, R1 gate)", schema lock → 09. Docs only.
- [x] 1. **Spike (no commit):** in rolled-back transactions on dev, time one `create_document` in a loop, a 200-row import chunk and generation for 1,000 clients, to pick chunk sizes under the 8 s statement timeout (03's DOC-ID counter serialises filings: 20 in parallel already timed out once). Proof: numbers in the session log.
- [x] 2. Migration draft + `volume-seed.test.ts` red → **SQL gate (you)** → apply (MCP; fallback: you run it in the SQL editor, I verify by md5) → green.
- [x] 3. `tests/support/volume.ts` + one local seed of the office. Proof: the count check passes and seeding time is logged.
- [x] 4. `volume.test.ts` V1–V10, run locally (`VOLUME=1 npx vitest run --project db tests/rls/volume.test.ts`). Proof: timings table.
- [x] 5. `regression.yml` input + summary table; one dispatched volume run on main's deployment (your OK for the CI run). Proof: run URL + evidence file.
- [x] 6. **Record, don't fix:** for each missed target, capture `EXPLAIN ANALYZE` (read-only, on dev) and the likely fix; add one known-issue line per target to roadmap › Later and to the evidence file. No migration or app change.
- [ ] 7. sdlc-reviewer → PR (AC table = V1–V10) → CI green → you merge → roadmap: volume ✓, lock released → **staging setup next**.

## Risks
| Risk | Mitigation |
|---|---|
| V1 fails on the 03b design (`count(*) over ()` + `row_number()` on every call): indexes can't fix it | Recorded as a known issue (likely fix: separate count + `LIMIT`, replacing both search functions). Pilot scale (20–30 clients) is far below 10k documents |
| Generation of 180k items exceeds the API's 8 s timeout | Seeding generates per chunk of clients; V4 is timed in the database, where the cron job really runs |
| Seed functions in a migration reach staging/prod | Refused unless the office `is_test`; staging/prod offices are never `e2e office …` (roadmap rule). Revoked from `anon` |
| Synthetic activity is unrealistic | Same action mix and entity types as the real rows; Limited's per-row helper sees real entity IDs |
| Dev timings ≠ prod (Nano compute; prod plan not chosen yet) | Dev is the pessimistic case. If prod gets bigger compute, results only improve; the staging gate re-times 05's merge |
| 10k documents is under a year of data (03b estimate 50–100k/yr) | Evidence says "pilot volume". The 10k figure is your 2026-09-29 decision, not changed here |

## Proof of done
V1–V10 measured in one dispatched run with stored evidence (pass, or a recorded known issue); full suite still green (CI + the next nightly); the seeding migration applied from its file with a history row.

## Effort
About 3 build sessions. Your review: one SQL gate (seeding migration) and the PR.

## Deviations from plan
- **`seed_test_documents(p_docs jsonb)`** takes an array of ≤ 1,000 `create_document` payloads, not `(p_count, p_template)` (03b plan wording): the caller spreads clients/types/periods/files, the function only loops. Same guards (Admin, `is_test`).
- **`seed_test_activity` capped at 20,000 rows per call** (dry run: 50,000 took 7.9 s, too close to the 8 s timeout; 20,000 ≈ 3 s).
- **Seeding order (from the spike):** clients imported at a clock of 2026-04-02 in chunks of **40** (6 groups ≈ 3.4 s); then generation stepped month by month to 2027-04-15 (≈ 14k items, ≈ 4 s per call), because one call for 1,000 clients would take ≈ 49 s through an 8 s API.

- **Seeding in three parts (local runs 2026-10-07):** at this size two office-wide calls exceed the API's 8 s statement timeout even as the service role: the daily job (5.5 s with nothing to create at 400 clients) and `reset_test_office` (> 8 s at 53.6k items). So:
  - **A (API, VOLUME=1 on an empty office):** import the 1,000 clients at the start clock (import-time generation is client-scoped: 108 s total), then stop.
  - **B (SQL as the database owner, like pg_cron):** `scripts/volume-generate.sql`, one month-start step per call (connector or SQL editor). **Part 0** there resets the office when starting over.
  - **C (API, VOLUME=1):** documents, reviews, activity, then V1–V10.
  The first idea, cohorts of 200 through the API, failed because each step's cost grows with the whole office, not just with the new cohort.
- **V4 is timed in SQL** (`scripts/volume-v4.sql`, rolled back), not in `volume.test.ts`: the job runs in pg_cron with no statement timeout, and through the API it is cut off at 8 s.
- **Missed targets don't fail `volume.test.ts`** (logged MISSED and written to the evidence table); errors do. `VOLUME_STRICT=1` fails on misses too. This implements "record, don't fix" (Raja 2026-10-07).
- `createStaff` takes an optional fixed email (the volume office's users are lane-independent).

## Session log
### 2026-10-07
- Done: plan approved (Raja 08:04–08:05): row 09 + schema lock; activity top-up (`seed_test_activity`); on demand + R1 gate, not nightly; missed targets recorded, no fixes.
- Roadmap PR #33 (row 09, schema lock → 09).
- Step 1 spike (dev, rolled back, `e2e office docs-perf`, nothing kept):
  - `create_document` in a loop: **3.8 ms** each (200 in 762 ms) → 10k ≈ 40 s in chunks.
  - Generation: 200 clients × 6 groups (GST, TDS/TCS, Banking, Payroll, Income Tax, Accounting) + GSTIN + TAN, clock 2026-04-02 → 2027-04-15: **33.8k items in 9.8 s** (183 per client, 29 active plan rows) → 1,000 clients ≈ 183k items, matching the 180k target.
  - **Finding K1 (outside V1–V10): CSV import times out with several groups.** `import_clients`, 200 rows, GSTIN + TAN each: **0 groups 0.8 s · 3 groups 8.8 s · 6 groups 16.9 s** in the database, against the 8 s `authenticated` statement timeout. The app imports 200-row chunks and sends the chosen groups on every row (`src/lib/csv/parse.ts`), so a 200-row chunk with 3+ groups fails (the chunk rolls back; the UI says "may not have been imported"). 02's nightly AC-17 imports with **one** group, so it never showed. ~1.4 s per group per 100 clients. **Pilot (20–30 clients): fine** (30 rows × 6 groups ≈ 2.5 s). Rollout to all clients: import in files of **≤ 40 rows** with 6 groups (≈ 3.4 s), or ≤ 80 with 3. Recorded as a known issue, not fixed (Raja 2026-10-07).
  - Migration dry run (rolled back): 1,000 documents 3.0 s; 50,000 activity rows 7.9 s → capped at 20,000; both refuse a non-test office (`NOT_TEST_OFFICE`).
- `tests/rls/volume-seed.test.ts` red locally (4/4: functions not in the schema cache).
- SQL gate → see below.
- **Step 2 done (Raja "apply" 10:07):** applied through the Supabase connector (`apply_migration` worked this time); history row `20261007043837 volume_seed`; file renamed to that version. Live bodies = file (md5 `44b69dd8…` documents, `4490539b…` activity); SECURITY INVOKER; EXECUTE authenticated + service_role, not anon. Security advisors: nothing new (4 pre-existing). `volume-seed.test.ts` green locally (4/4).
- Month-end load (Raja 09:24): in practice at most ~200 clients file monthly, so a real month-end run generates ≈ 5k items (≈ 1.5 s at 0.29 ms/item). The seed keeps 04's worst case (all 1,000 clients monthly ≈ 20k items on the month-end day, ≈ 6 s); V4 records both figures. The 49 s full-year generation is a seeding artefact only, never a production run.
- Step 3 (seeding): part A ✓ (1,000 clients, 108 s) · part B ✓ (connector, sequential; ≈ 183k items, clock 2027-04-15) · part C running.
- **Part B step times = month-start daily runs at a growing office (finding K2):**

  | as of | items before | created | ms |
  |---|---|---|---|
  | 2026-05-01 | ~17k | 17,000 | 7,687 |
  | 2026-06-01 | ~34k | 14,000 | 8,022 |
  | 2026-09-01 | ~75k | 13,000 | 15,381 |
  | 2026-10-01 | ~88k | 13,000 | 11,017 |
  | 2026-11-01 | ~101k | 14,000 | 12,382 |
  | 2026-12-01 | ~115k | 13,000 | 12,343 |
  | 2027-01-01 | ~128k | 13,000 | 16,217 |
  | 2027-02-01 | ~141k | 14,000 | 21,048 |
  | 2027-03-01 | ~155k | 13,000 | 19,162 |
  | 2027-04-01 | ~168k | 17,000 | 25,737 |
  | 2027-04-15 | ~181k | 1,000 | 17,368 |

  (07-01 and 08-01 ran concurrently by mistake: 8,558 / 16,692 ms, not comparable.) **The job's time grows with all stored items, not with the new ones** (17 s to create 1,000 items at 181k). Under the 60 s target now; [Likely] near 60 s after 2–3 years at 1,000 clients. **K2, recorded, not fixed.** Likely fix later: generate only from each plan row's latest generated period (or a "generated through" mark), instead of re-checking every past period every night.
- Step 3 done: part C ✓ (746 s: uploads 288 s, documents 133 s, reviews 28 s, activity 77 s). Counts: 1,000 clients · 183k items · 10k filed + 100 Inbox · 7k versions · 200k activity.
- Step 4 done (local run, session → Mumbai; ping 291 ms). Results and DB-side timings in `sdlc/releases/R1/evidence/volume-dev.md`:
  - **pass:** V1 160 ms · V2 150–250 ms · V4a 26.3 s / V4b 30.0 s (DB) · V5b 568 ms · V5c 554 ms · V7 no measurable cost · V9a 110 ms · V9c 25 ms · V10 1.8 s.
  - **TIMEOUT (screen errors):** V5a Clients list (DB 26.6–32.6 s) · V6 Collection metric (15.6 s) · V8 Today (13.5–19.8 s) · V9d document Activity card (14.1 s).
  - **borderline:** V3 Limited search and V9b Limited Activity (0.6–1.2 s).
  - Skew check (rolled back): 85% of overdue items marked received on time → still 26.6 s / 13.5 s / 15.7 s. Cost grows with total items, not the overdue share.
  - Known issues **K1–K5** written to the evidence file. They go to roadmap › Later at merge (main only).
- `timeIt` records a statement timeout as TIMEOUT and carries on; other errors still fail. Heavy tests get 180 s.
- `volume-seed.test.ts` fixed for re-runs: activity is append-only and survives `reset_test_office`, so it counts only this run's rows (green twice).
- Next step: **step 5, one CI dispatch** of `regression.yml` with `volume=true` (needs Raja's OK; ~10 min with the office already seeded). Then step 7 (review → PR).
- Step 5 done (Raja OK 11:29): CI run 37579143257 on cc11538, `volume=true`: volume job green (V1–V10 + seeding guards), evidence artifact uploaded; the timings table is in the run summary (not readable from this session).
- Step 6 done: roadmap PR #34 (K1–K5 under Releases › R1 and Later; rollout to all clients gated on K3 + K4).
- Next step: step 7 (sdlc-reviewer → PR).
