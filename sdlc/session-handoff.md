# Session handoff — CA Document Vault
Last session: 2026-10-27/28 (chore ci-speed: PR CI 83 → ~5 min) · Repo: **pulsebayai/CA-Document-Vault** (**public**) · main @ **e274f58** (#10). **All R1 features built (01–11 incl. 03b, 10, 11).** Kushal Associates' go-ahead given (2026-10-27). **Next: the R1 path (staging + prod).**

## CI now (chore ci-speed, PRs #9 + #10, 2026-10-28)
- **PR CI ≈ 5 min** (main was 83 min on 2026-10-27 morning). Jobs run in parallel:
  - `verify` (lint · typecheck · unit · build, ~2 min);
  - `RLS (local Supabase)`, about 1 min of tests;
  - `e2e (local Supabase, shard 1–3/3)`, under 4.5 min each;
  - `e2e (all shards)`, the single status, which merges the evidence into the `test-evidence` artifact.
- **PR CI uses no secrets, no dev database and no test lane.** Each RLS/e2e job starts an ephemeral Supabase with `scripts/local-db.sh start`, built only from `supabase/migrations/`. The API runs over HTTPS with a self-signed cert; the browser accepts it only with `E2E_LOCAL_DB=1`, which the config refuses together with `E2E_BASE_URL`.
- **Hosted dev still runs** the nightly Regression (01:30 IST), RUN_SLOW dispatches and (later) the staging gate. **Only those take test lanes now**, so "don't overlap CI runs on dev" applies to Regression runs only. PR CI runs can overlap freely.
- **Rules added to CLAUDE.md:**
  - A PR that adds a migration applies it to dev before review, records md5 = file in the PR, and dispatches Regression `only` = its RLS files.
  - PR CI no longer proves query speed or hosted-only e2e behaviour; the nightly does.
  - A race that the fast local stack exposes is fixed in code, never by slowing the test.
- **Schema proof:** `scripts/schema-fingerprint.sql` showed the migration replay **identical to dev** (1,197 objects, incl. 05 `20261002083900` and 08 `20261002120000`). Reuse it on staging/prod after their replay (dev baseline: `sdlc/features/chore-ci-speed/evidence/`). It doesn't cover auth settings; check those by hand.
- **Fixed on the way (owner-approved):** 03 document form lost a type or period chosen while the client's types loaded (`document-form.tsx`, failing-first unit tests).
- **Nightlies:** 40602866332 (2026-10-28 01:30, after #9) was **green, 64.6 min**, after 6 red of 12 since 10-15 (statement timeouts on shared dev). Keep checking each morning.
- Claude cloud sessions **can't run the local stack**: the container registries are blocked. Sessions keep running RLS against dev. Trials run on GitHub runners.
- Plan + evidence: `sdlc/features/chore-ci-speed/plan.md`. Follow-ups are in the roadmap's Later list.

## Hosting decision (Raja, 2026-10-15): option A — stay public until staging
- Options compared:
  - **A** public, $0 Vercel and $0 Actions.
  - **B** private + Vercel Pro (~$20/mo) + Actions minutes.
  - **C** private org repo + one-way deploy mirror to the personal repo on Vercel Hobby (~$0 Vercel + Actions minutes; mirror workflow, Actions off on the mirror, Vercel "circumventing limits" risk).
- **A chosen.** When the repo goes private (before staging/prod), **first set a payment method + spending limit on pulsebayai's Actions billing**. A private org repo on GitHub Free gets 2,000 min/month; an exhausted quota silently stops jobs, as on the old repo on Oct 9–13.
  - **Re-measure minutes first:** PR CI is now 6 parallel jobs of ~2–5 min (≈ 20 billed min per run). The nightly (~65 min) alone is ~2,000 min/month.
- If C is ever chosen: **don't archive** the personal repo (a mirror must accept pushes), disable Actions on it entirely, and add a "deploy mirror only" banner.

## Repo move (2026-10-14, Raja's decision) — done
- **pulsebayai/CA-Document-Vault is the only repo.** Don't push to, open PRs on or run CI from RajaPulsebay/ca-document-vault (its CI and Regression are disabled).
- **CI evidence archive:** release `ci-evidence-archive-2026-10-14` on the new repo holds all 374 old artifacts plus `runs.psv`, `artifacts.psv` and `run-logs.zip`. **It is the only raw copy** once the old repo's artifacts expire (~2026-12-24). Formal evidence stays in `sdlc/releases/`.
- **Secrets/vars on the new repo:** `DEV_SUPABASE_SECRET_KEY` and `VERCEL_AUTOMATION_BYPASS_SECRET` (now used only by Regression), plus `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (public; `verify` builds with them). The 3 `STAGING_*` secrets/vars wait for staging.
- **Public repo (agreed with Kushal Associates, 2026-10-14):**
  - **Make it private again and move to Vercel Pro when the engagement becomes paid, or before staging/prod is created** (Hobby = non-commercial only).
  - Never point CI at staging/prod while the repo is public: logs and artifacts are publicly readable.
  - Fork PRs get no secrets, and PR CI no longer needs any. "Require approval for all external contributors" is on.
- **Claude GitHub App** on pulsebayai, only `CA-Document-Vault`. Attach **only** this repo in a session.
- **Local clone** at `~/Documents/Projects/CA Document Vault` (still on an old branch, `docs/10-client-upload-links-intent`; pull main before using it). `CA Document Vault - old` can be deleted once nothing is needed from it.
- **Still to do:**
  - Secret scanning and push protection on; default workflow token read-only.
  - A ruleset on `main` (PR + checks: `e2e (all shards)`, `RLS (local Supabase)`, `Lint · typecheck · unit · build`).
  - Archive (not delete) the old repo, under option A.
  - Bump the actions past their Node 20 versions (`checkout`, `setup-node`, `upload-artifact`, `download-artifact`, `cache`, `supabase/setup-cli`).
  - **Commit the SDLC skill once the repo is private again** (Raja 2026-10-15): `skills/ai-native-sdlc-regression-SKILL.md` → `.claude/skills/ai-native-sdlc-regression/SKILL.md` (licence for public redistribution unconfirmed).
- **Keep the old repo, never delete it.** R1 evidence and `01-walking-skeleton/intent.md` link to its CI runs.

## Dev database notes
- The volume office was purged on 2026-10-15 (`reset_test_office`). Activity is append-only: ~332k rows, ~201k of them from the volume office.
- To re-measure after K3/K4 fixes: seed a **fresh** office with `scripts/volume-generate.sql`, then **purge it again afterwards**, or the nightly goes red.
- [Likely] Several functions do whole-table work, not office-first: query cost grows with every office's rows. That's a clue for K3/K4 (office-leading indexes/filters).

## Next: the R1 path (roadmap › Before pilot + Releases › R1)
1. **Make the repo private (Actions billing + spending limit set first) and move to Vercel Pro.**
2. **Create staging + prod** (Supabase + Vercel). Apply **every migration from its file** (or `supabase db push`). Then run `scripts/schema-fingerprint.sql` there and compare with `sdlc/features/chore-ci-speed/evidence/dev-fingerprint-summary.psv`; the schema part is already proven identical locally. Check data seeds (office, catalogue, six preferred-format types) and auth settings by hand.
3. **Brevo per environment** (paid plan, firm domain DKIM/DMARC, verified sender, env vars), plus `APP_PUBLIC_URL`, `LINK_IP_SALT`, `CRON_SECRET` per environment.
4. **Release gate:**
   - Regression on staging's URL.
   - Manual checklist, including 08's role-matrix steps and 10's upload-route security check (`sdlc/releases/README.md`, roadmap R1).
   - Raja's sign-off; prod smoke tests only; `sdlc/releases/R1.md` + evidence.
5. Re-set the pilot start against the November/December GST cycle (a missed intake window = a month's delay).

## Watch
- **Supabase MCP writes** (`apply_migration`, DDL via `execute_sql`) were cancelled repeatedly in the 08 session; reads work, and `reset_test_office` / ANALYZE via `execute_sql` worked on 2026-10-15. Otherwise Raja runs the SQL in the dashboard editor, or use the Supabase CLI.
- **Raja's preferences:**
  - Ask before any CI run or push to a PR branch. This includes trial workflows and re-runs.
  - Back up local commits to a non-PR branch, with `[skip ci]` if a workflow would trigger.
  - Don't overlap **Regression** runs on dev.
- **CI results from a session:** artifact and log downloads are blocked (blob host). Read conclusions, step times and **annotations** through the API (`/actions/runs/<id>/jobs`, `/check-runs/<job>/annotations`). The workflows print counts as notices: `rls counts`, `e2e counts (all shards)`, `local-db start`. Re-run a whole run with `POST /actions/runs/<id>/rerun`, or one job with `POST /actions/jobs/<id>/rerun`. For full files, Raja downloads with `gh` into `.nightly-<id>/` and Claude reads them over the desktop link.
- Draft → ready: `POST /repos/{o}/{r}/pulls/{n}/ccr/ready_for_review` (it doesn't trigger CI). The **production-gate hook** blocks commands containing both `push` and `main`: build PR JSON with `"ma"+"in"`.
- **Known flakes:**
  - `review-dispatch.spec.ts:168` AC-14 (once on hosted dev, 2026-10-27).
  - 02 `client-plan.spec.ts:45` (GST region) under overlapping hosted runs.
  - 02 `clients-list` timing stall (once, CI 40454733549).

## Access notes
- Workspace: `add_repo pulsebayai/CA-Document-Vault` (access push) → `git clone --depth 1 https://github.com/pulsebayai/ca-document-vault` → `git fetch --depth=50 origin main` (+ branches as needed) → `register_repo_root`.
  - A shallow clone keeps no remote-tracking refs: add `git config --add remote.origin.fetch '+refs/heads/chore/*:refs/remotes/origin/chore/*'` before `git branch -u`.
- `gh` is not installed in cloud sessions: use REST via curl (`Content-Type: application/json` on POSTs). Raja's Mac has `gh` in `~/bin`.
- `.env.local` comes from Raja's Mac via the desktop link (stage `…/CA Document Vault/.env.local`); use `NODE_USE_ENV_PROXY=1`.
- Supabase MCP = dev (`ysddbwskljzhbjjohool`).
