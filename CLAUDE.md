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
- **A PR needs CI only** (full suite on CI's own build). Don't dispatch the deployed-URL Regression per PR; it runs nightly and at the release gate (architecture.md policy).
- **Proving a fix on the deployed site:** dispatch Regression with `only` = the affected test files (e.g. `inbox add-document`); ~3–5 min, marked "Quick check — not release evidence".
- **Queue:** CI's DB job and Regression share the dev database (`dev-database` group, one waiting slot — a new run cancels the waiting one). Dispatch only after the PR's DB job has started.
- **Running tests in a Claude cloud session:** `.env.local` (dev keys only) is copied from Raja's Mac via the desktop link; the egress allowlist includes the dev Supabase host. Node needs `NODE_USE_ENV_PROXY=1`; Playwright needs the proxy and `/opt/pw-browsers/chromium` (a local, untracked `playwright.local.config.ts`). Previews (`*.vercel.app`) are not reachable from the session.
- e2e `signIn()` reuses a user's session after their first real sign-in; pass `{ fresh: true }` when the test is about signing in.

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
- v1 is staff-only: no client-facing auth or links. The only client-facing outputs are staff-triggered reminders: email via SES and pre-filled WhatsApp click-to-chat (no attachments, no app links, no PAN/GSTIN). No automatic sends.
