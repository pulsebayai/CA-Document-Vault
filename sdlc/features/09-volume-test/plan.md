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
| supabase/migrations/<ts>_volume_seed.sql | new | `seed_test_documents(p_count int, p_template jsonb)`: SECURITY INVOKER, loops 03's `create_document`, refused unless the caller's office `is_test`. `seed_test_activity(p_count int)`: same guard; synthetic rows that pass `ACTIVITY_PII`. Approved in principle by Raja 2026-09-29 (03b plan); activity top-up is new |
| tests/support/volume.ts | new | get-or-seed the office, count check, fixture users, storage uploads (10 parallel), ping, median timer |
| tests/rls/volume.test.ts | new | V1–V10, `describe.skipIf(!process.env.VOLUME)` |
| tests/rls/volume-seed.test.ts | new | the seed functions are refused in a non-test office and for Limited (always runs; fast) |
| tests/support/search.ts, tests/rls/document-search-perf.test.ts | — | deferred from 03b; **folded into volume.test.ts** instead of created |
| .github/workflows/regression.yml | mod | `volume` input → `VOLUME=1`, concurrency group `volume`, timeout |
| scripts/regression-summary.mjs | mod | a "Volume timings" table (target, server ms, round trip ms, pass/fail) |
| sdlc/releases/R1/evidence/volume-dev.md | new | timings table + run URL |

## Steps
- [ ] 0. Roadmap PR on main (your OK): row 09 "volume-test (chore, R1 gate)", schema lock → 09. Docs only.
- [ ] 1. **Spike (no commit):** in rolled-back transactions on dev, time one `create_document` in a loop, a 200-row import chunk and generation for 1,000 clients, to pick chunk sizes under the 8 s statement timeout (03's DOC-ID counter serialises filings: 20 in parallel already timed out once). Proof: numbers in the session log.
- [ ] 2. Migration draft + `volume-seed.test.ts` red → **SQL gate (you)** → apply (MCP; fallback: you run it in the SQL editor, I verify by md5) → green.
- [ ] 3. `tests/support/volume.ts` + one local seed of the office. Proof: the count check passes and seeding time is logged.
- [ ] 4. `volume.test.ts` V1–V10, run locally (`VOLUME=1 npx vitest run --project db tests/rls/volume.test.ts`). Proof: timings table.
- [ ] 5. `regression.yml` input + summary table; one dispatched volume run on main's deployment (your OK for the CI run). Proof: run URL + evidence file.
- [ ] 6. **Record, don't fix:** for each missed target, capture `EXPLAIN ANALYZE` (read-only, on dev) and the likely fix; add one known-issue line per target to roadmap › Later and to the evidence file. No migration or app change.
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

## Session log
### 2026-10-07
- Done: plan approved (Raja 08:04–08:05): row 09 + schema lock; activity top-up (`seed_test_activity`); on demand + R1 gate, not nightly; missed targets recorded, no fixes.
- Next step: roadmap PR (row 09, schema lock) → step 1 spike.
