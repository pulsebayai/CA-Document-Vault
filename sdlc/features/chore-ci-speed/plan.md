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
- [ ] **0. Migration replay proof** (shared with the staging rehearsal, Before pilot)
  - `supabase start` + every file in `supabase/migrations/` (workflow `local-db-trial.yml`, branch-only, no secrets).
  - Schema diff vs dev = empty: `scripts/schema-fingerprint.sql` run on both (functions incl. definitions and EXECUTE grants, relations + RLS flags + grants, columns + column grants, constraints, indexes, policies, triggers, enums/domains, sequences, buckets, pg_cron jobs, extensions).
  - Known risks: 05 `20261002083900` and 08 `20261002120000` were applied through the dashboard; `pg_cron` / Storage available locally.
  - Also: time the RLS suite against the local DB (serial, unchanged tests) as evidence for step 2.
  - Done when: the diff is empty, or every difference is explained and fixed in a new migration.
- [ ] **1. Low-risk CI wins** (no DB change)
  - Cache the Playwright browsers.
  - Build the app once (the changed-e2e-first step starts a second build).
  - Print per-step timings in the summary.
  - Done when: CI is ≥ 5 min faster [Likely], and the same tests run.
- [ ] **2. RLS on a local Supabase** (the RLS step is the timeout source and is DB-only)
  - A new `rls` job running in parallel with `e2e`.
  - Fixtures seeded locally. No test lane needed. Raise `fileParallelism` only after it's green serially.
  - Done when: RLS passes 3 runs in a row locally on CI, ≤ 5 min [Likely 2–4].
  - Effect: CI ≈ verify + e2e alone ≈ 25–30 min; DB timeouts in RLS gone.
- [ ] **3. E2E on a local Supabase, split 3 ways** (`--shard`, each shard with its own DB and app build)
  - Check that sign-in (OTP codes via admin API / local mail), Storage signed uploads and the `/u` upload route work locally.
  - Done when: 3 green runs in a row. [Uncertain] PR CI ≤ 15 min.
- [ ] **4. Policy + docs**
  - Update architecture.md:
    - Environments: "no local Supabase/Docker" → PR CI uses an ephemeral local DB; nightly/RUN_SLOW/staging stay hosted.
    - Add a decision-log row.
  - Update CLAUDE.md test rules: lanes only for hosted runs.

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
  - Waiting: Raja's OK to push the branch (runs the trial) and the roadmap lock PR.
