# Chore ci-speed: plan
Drafted 2026-10-27 · Status: **approved** (in chat, 2026-10-27 21:36 IST: answers to the open questions 1–2 below = yes, as written) · Branch `chore/ci-speed` · Locks: **architecture** (reverses "no local Supabase/Docker" for PR CI only), no schema change.

## Problem (measured, GitHub API + junit files, 2026-10-14 → 27)
- **CI keeps getting slower:** a push to main took 52 min on 2026-10-14, 84 min on 10-26 and 83 min on 10-27. Features 10 and 11 added ~30 min in 2 weeks (RLS 561 → 644 tests, e2e 101 → 121). Job limits have already been raised to 120 min.
- **Reruns:** 11's PR needed 4 CI runs (68, 81 [attempt 2], 44 [failed], 74 [attempt 2] min) + main 83 + RUN_SLOW Regression 84 + a quick check 11. That's **≈ 7 h of CI wall time for one feature**, ≥ 2 h of it reruns.
- **The nightly is red 6 of 12 times since the 10-15 fix** (10-16, 17, 19, 23, 24, 26). 5 of them failed in the RLS step at ~30 min, so e2e never ran. In the one with files on hand (40137817353), `client-edit` create_client failed with a *statement timeout* (9.6 s). The others show the same signature [Likely same cause; artifacts not downloadable from the session].
- **Where the time goes** (nightly 40239687499): unit 9 s · RLS 891 s · e2e 817 s, run **one after the other in one job** with `workers: 1` and `fileParallelism: false`.

## Root cause
Every test goes from a US GitHub runner to the **shared, persistent, hosted dev DB (Mumbai, Nano)**, one test at a time. That one design causes:
1. Latency on every round-trip ([Likely] ~1.6 s per RLS test).
2. No parallelism: 2 lanes; an earlier 3-lane trial timed out e2e.
3. Data and load drift: the volume office, 330k+ append-only activity rows, two runs on one small instance. This makes statement timeouts intermittent, so runs get re-run.

## Approach
Give each CI job its **own throwaway local Supabase** (`supabase start` on the runner), built **only from migration files**. **Keep hosted dev for:** the nightly, the RUN_SLOW / preview Regression dispatches and the staging gate. Those catch hosted-only drift (auth email, storage settings, the deployed site), so the release policy stays intact.

## Steps
- [x] **0. Migration replay proof** (done 2026-10-27, trial 40538705315) (shared with the staging rehearsal, Before pilot)
  - `supabase start` + every file in `supabase/migrations/` (workflow `local-db-trial.yml`, branch-only, no secrets).
  - Schema diff vs dev = empty: `scripts/schema-fingerprint.sql` run on both (functions incl. definitions and EXECUTE grants, relations + RLS flags + grants, columns + column grants, constraints, indexes, policies, triggers, enums/domains, sequences, buckets, pg_cron jobs, extensions).
  - Known risks: 05 `20261002083900` and 08 `20261002120000` were applied through the dashboard; `pg_cron` / Storage available locally.
  - Also: time the RLS suite against the local DB (serial, unchanged tests) as evidence for step 2.
  - Done when: the diff is empty, or every difference is explained and fixed in a new migration.
- [ ] **1. Low-risk CI wins** (no DB change) — built 2026-10-27, waiting for its CI run
  - Cache the Playwright browsers.
  - Build the app once (the changed-e2e-first step starts a second build).
  - ~~Print per-step timings in the summary.~~ Dropped: the Actions API already gives per-step times (used for the baseline below).
  - Done when: CI is ≥ 5 min faster [Likely], and the same tests run.
- [ ] **2. RLS on a local Supabase** (the RLS step is the timeout source and is DB-only) — built 2026-10-27, waiting for its CI runs
  - A new `rls` job running in parallel with `e2e`.
  - Fixtures seeded locally. No test lane needed. Raise `fileParallelism` only after it's green serially.
  - Done when: RLS passes 3 runs in a row locally on CI, ≤ 5 min [Likely 2–4].
  - Effect: CI ≈ verify + e2e alone ≈ 25–30 min; DB timeouts in RLS gone.
- [ ] **3. E2E on a local Supabase, split 3 ways** (`--shard`, each shard with its own DB and app build)
  - Check that sign-in (OTP codes via admin API / local mail), Storage signed uploads and the `/u` upload route work locally.
  - Done when: 3 green runs in a row. [Uncertain] PR CI ≤ 15 min.
- [ ] **4. Policy + docs** — RLS part done with steps 1–2 (architecture.md + CLAUDE.md); e2e part with step 3
  - Update architecture.md:
    - Environments: "no local Supabase/Docker" → PR CI uses an ephemeral local DB; nightly/RUN_SLOW/staging stay hosted.
    - Add a decision-log row.
  - Update CLAUDE.md test rules: lanes only for hosted runs.

## Files that change
`.github/workflows/ci.yml` · `.github/workflows/local-db-trial.yml` (step 0 only, then removed) · `playwright.config.ts` · `supabase/config.toml` · `supabase/.gitignore` · `scripts/local-db.sh` · `scripts/schema-fingerprint.sql` · comments only: `tests/support/setup-env.ts` (error text), `vitest.config.mts`, `scripts/test-lane.mjs` · docs: `sdlc/product/architecture.md`, `CLAUDE.md`, this plan + `evidence/`. Step 3 adds the e2e job's local stack (same files). **No migration, no product code, no test assertion changes.**

## Not doing (and why)
- **Moving tests out of PR CI** (screenshots, slow tests). Policy is "full suite per PR", and finding breakage late has already cost more than the wait.
- **A self-hosted runner** (Raja's Mac / India). The repo is public, so fork PRs could run code on it.
- **Changing the dev region.** It fixes latency only, not shared state.

## Decisions (2026-10-27)
1. **Approved:** reverse "all automated tests run on hosted dev — no local Supabase/Docker" for **PR CI only**.
2. **Approved order:** step 0 first (it is also the staging rehearsal's migration replay), then steps 1–3 before staging is created. [Likely] 2–4 working days.
3. Open: re-measure Actions minutes before the repo goes private (2,000 min/month).
4. Open: a bigger dev compute size as an interim fix for red nightlies ([Uncertain] paid plan; check pricing first).

## Session log
- **2026-10-27 (evening):** plan approved in chat. Branch `chore/ci-speed` from main 2bae65c.
  - Dev baseline fingerprint (MCP, read-only): 1,197 objects — bucket 1 · column 301 · constraint 243 · cron 2 · extension 7 · function 173 · function_acl 173 · index 134 · policy 50 · relation 28 · sequence 2 · trigger 61 · type 21 · view 1. Per-kind hashes in `evidence/dev-fingerprint-summary.psv`.
  - The Claude cloud session has Docker but **its network blocks every container registry** (Docker Hub, GHCR, ECR), and the Mac's linked shell has no Docker, so step 0 runs on a GitHub runner: `local-db-trial.yml` (push to this branch only; no secrets; never touches dev).
  - Added `supabase/config.toml` (CLI 2.122.0 defaults; realtime/studio/analytics/edge runtime off; auth rate limits raised for the suite; OTP length 8 like hosted).
  - Push approved in chat. Roadmap lock: PR #8 (docs-only).
  - **Trial run 40538705315 (5c4071e), step 0 result:**
    - `supabase start` + **all migrations replayed from files: 74 s**, no error.
    - **Schema fingerprint identical to hosted dev in all 14 kinds (1,197 objects)**, function definitions and grants included (`evidence/local-fingerprint-summary.psv` = `evidence/dev-fingerprint-summary.psv`). So the two dashboard-applied migrations (05 `20261002083900`, 08 `20261002120000`) match their files, and the staging replay risk in Before pilot is cleared for schema. Data (seed office, catalogue) is not compared.
    - **RLS suite, unchanged tests, serial: 64 s** (hosted dev: 891–1,140 s, ≈ 15× slower). **1 failure:** `bulk.test.ts:226` signLinks expects an `https:` link; the local API is `http://127.0.0.1:54321`. This is an environment difference, not a product bug. Fix in step 2 **by serving the local API over TLS** (`[api.tls]`), not by editing the test (CLAUDE.md rule).
    - To add in step 2: pass/fail/skip counts as an annotation (the artifact can't be downloaded from the session).
- [x] Step 0 done, except the TLS item, which moves into step 2.
- **2026-10-27 (late): steps 1 + 2 built** (one PR, approved in chat 22:13 IST).
  - **Baseline** (main CI 40521628959, 83 min, from the Actions API): verify 2 min; one "RLS + e2e" job 80.5 min = changed RLS first 311 s + Playwright install 343 s + changed e2e first 121 s (incl. a second build) + RLS 2,233 s + e2e 1,786 s.
  - `ci.yml`: jobs `verify` ∥ **`rls` (local Supabase)** ∥ **`e2e` (dev Supabase)**, all after `changes` only (e2e and rls no longer wait for verify).
    - `rls`: `scripts/local-db.sh start` (self-signed cert if missing → `supabase start` → URL/keys + `NODE_EXTRA_CA_CERTS` into `$GITHUB_ENV`), `npm run test:db:ci`, evidence summary + a counts annotation, artifact `rls-evidence`. No secrets, no lane. "Changed RLS tests first" is removed (the whole suite is ~1 min).
    - `e2e`: Playwright browsers cached per version (`install-deps` only on a hit), `npm run build` once + `E2E_PREBUILT=1` (playwright.config.ts then only starts the app), lane taken after the build, changed e2e first, full e2e, artifact `test-evidence` (same name as before).
  - **TLS for the local API** (`[api.tls]` + `supabase/certs/`, git-ignored, made by the script), so Storage-signed links are `https:` as on hosted projects: fixes step 0's `bulk.test.ts:226` without editing the test. Checked in the session: Node's fetch rejects the self-signed cert by default and accepts it with `NODE_EXTRA_CA_CERTS`.
  - `local-db-trial.yml` removed (folded into `rls`). `scripts/schema-fingerprint.sql` stays for the staging/prod replay.
  - Docs: architecture.md (policy 1, Environments, decision-log row, the 2026-09-25 row annotated), CLAUDE.md (local RLS rule; lanes = e2e job + Regression).
  - Session checks: lint 0, typecheck 0, unit 529/529, build OK. RLS/e2e can't run here (no registry access; no preview access).
  - Expected [Likely]: PR CI ≈ e2e job alone ≈ 35–40 min (from 75–83); RLS job ≈ 4 min. e2e stays the critical path → step 3.
  - **Pre-PR review (sdlc-reviewer, 2026-10-27): no blockers, 3 Important, 9 Nits, all addressed:**
    - I-1 PR CI no longer proves dev has the PR's migrations → CLAUDE.md rule: a PR with a migration applies it to dev, records md5 = file, and dispatches Regression `only` = its RLS files before merge (no schema change needed for a check in CI).
    - I-2 docs ahead of proof → CLAUDE.md says "being proven"; **don't merge until 3 green `rls` runs are recorded here** (run IDs, seconds, test count vs hosted 644).
    - I-3 a laptop `start` didn't export the local env, so tests would silently use `.env.local`'s dev keys → script header + CLAUDE.md give the export line; `start` only writes `$GITHUB_ENV` in Actions.
    - Nits: unused `db_tests` output commented · `E2E_PREBUILT === "1"` + "never set locally" · cache key adds `ImageOS` · cert renewed when < 1 day left · `API_URL` read from `supabase status` and must be `https:` · `mktemp` log · CLAUDE.md: PR CI no longer catches slow queries (nightly does) · `enable_signup = false` as the product · fingerprint adds `storage_policy` (dev: none, 2026-10-27; auth settings stay a manual check) · stale comments in `setup-env.ts`, `vitest.config.mts`, `test-lane.mjs`, CLAUDE.md verification line · this "Files that change" section.
