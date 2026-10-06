# CA Document Vault — working rules for Claude
@AGENTS.md
@sdlc/product/product.md
@sdlc/product/architecture.md
@sdlc/product/roadmap.md

## Active feature
Determined by branch: a branch containing <NN-slug> → sdlc/features/<NN-slug>/. At session start read its plan.md (checkboxes + latest session log). On main: product-level work only.

## Verification commands (must all pass before a step is done)
- `npm run lint` → 0 errors, 0 warnings
- `npm run typecheck` → 0 errors
- `npm test` → unit tests pass
- `npm run test:db` → RLS/integration tests pass against the **dev** Supabase project (needs SUPABASE_SECRET_KEY in .env.local)
- `npm run test:e2e` → Playwright passes (runs in CI; browser download is blocked in Cowork)
- `npm run build` → exits 0
Subagents: `verifier` (after each step), `sdlc-reviewer` (before a PR). Hook: `.claude/hooks/production-gate.sh`.

## Test runs — keep the feedback loop short (Raja, 2026-09-29)
- **New or changed tests run locally before every push (Raja 2026-10-06):** run each new or changed test file on its own in the session first — unit/RLS with `npx vitest run --project <unit|db> <files>` (RUN_SLOW=1 for slow files), e2e with `npx playwright test -c playwright.local.config.ts <files>` against a local build (~5 min). Push only when they pass; CI is for the full suite, not where a new test fails for the first time. If `playwright.local.config.ts` is missing (new session machine), recreate it before running e2e. (05: a new e2e test failed in CI after ~40 min; the local run found two problems in 5 min.)
- **A PR needs CI only** (full suite on CI's own build). Don't dispatch the deployed-URL Regression per PR; it runs nightly and at the release gate (architecture.md policy).
- **Docs-only changes skip the tests (chore ci-docs-only, Raja 2026-09-30):** a PR or push to main that changes only `sdlc/**` or `*.md` runs the "What changed" job and skips lint/unit/RLS/e2e. Nightly Regression always runs (it catches drift). A code PR's **last commit before merge must have a full green run** — batch docs commits with code, or push them after CI finishes; `[skip ci]` only for a docs-only commit on a draft whose result is already known. Release evidence cites the last *code* commit's green run on main.
- **Proving a fix on the deployed site:** dispatch Regression with `only` = the affected test files (e.g. `inbox add-document`); ~3–5 min, marked "Quick check — not release evidence".
- **Test lanes (2026-09-29):** CI's DB job and Regression each lease one of **2** lanes on the dev database (`scripts/test-lane.mjs`, table `test_lane`) and use that lane's own fixture offices/users (`e2e office <label> #<lane>`, `e2e-<label>-l<lane>@example.test`), so up to 2 runs overlap; a 3rd waits (≤ 30 min). Local/Claude-session runs have no `TEST_LANE` and use the un-suffixed `local` set — so only one local run at a time. A newer push to a PR cancels that PR's older CI run.
- **Running tests in a Claude cloud session:** `.env.local` (dev keys only) is copied from Raja's Mac via the desktop link; the egress allowlist includes the dev Supabase host. Node needs `NODE_USE_ENV_PROXY=1`; Playwright needs the proxy and `/opt/pw-browsers/chromium` (a local, untracked `playwright.local.config.ts`). Previews (`*.vercel.app`) are not reachable from the session.
- e2e `signIn()` reuses a user's session after their first real sign-in; pass `{ fresh: true }` when the test is about signing in.
- **RUN_SLOW before merge (Raja 2026-10-01):** a feature that changes 02/03 write paths (client/plan/import/document functions or their triggers) runs the slow tests before merge: a Regression dispatch on the branch with `base_url` = the branch's Vercel preview (full suite), or `only` = the affected test files. Without `base_url`, e2e would test main's deployment, not the branch. PR CI doesn't set RUN_SLOW, so a slow-path regression otherwise first shows up in the nightly (04: nightly 36792152274).

## Rules
- Follow the AI-native SDLC session start/end routines.
- Never edit a test to make it pass; fix the code.
- Never work directly on main except roadmap/product docs.
- On a feature branch, do not edit roadmap.md, and edit architecture.md only if this feature holds the architecture lock.
- Only the feature holding the schema lock may add database migrations.
- All data access goes through RLS-protected tables; never use the service-role key in client-reachable code.
- No PII (PAN, mobile, email, client names) in URLs, logs or analytics.
- Every release follows the Release & regression policy in architecture.md (staging gate, manual checklist, evidence in sdlc/releases/). Never run data-writing tests against prod.
- Never hard-delete documents or clients (archive only).
- v1 is staff-only: no client-facing auth or links. The only client-facing outputs are staff-triggered reminders: email via Brevo and pre-filled WhatsApp click-to-chat (no attachments, no app links, no PAN/GSTIN). No automatic sends.
