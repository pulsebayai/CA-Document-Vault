# Plan: Walking skeleton — secure staff sign-in, deployed end-to-end in India
Spec: ./spec.md · Status: approved

## Files that change
| Path | New/Mod | Why |
|---|---|---|
| package.json, package-lock.json, tsconfig.json, next.config.ts, eslint.config.mjs, postcss/tailwind config | new | Next.js (App Router) + TS + Tailwind scaffold; scripts lint/typecheck/test/test:e2e/build |
| vercel.json, next.config.ts | new | `regions: ["bom1"]`; security headers in next.config |
| .env.example | new | variable names only (no values) |
| src/app/layout.tsx, src/app/globals.css | new | IBM Plex Sans, design tokens from ui-reference.md |
| src/app/(auth)/login/page.tsx, src/app/auth/confirm/route.ts | new | email → code sign-in |
| src/app/(app)/layout.tsx, src/components/app-header.tsx, src/components/avatar-menu.tsx | new | mockup header, nav (Clients, Settings), sign out |
| src/app/(app)/clients/page.tsx | new | empty state |
| src/app/(app)/settings/users/page.tsx, src/components/invite-dialog.tsx | new | Users and roles (Admin only) |
| src/lib/supabase/{server,client,proxy}.ts | new | @supabase/ssr clients |
| src/lib/supabase/admin.ts | new | **server-only** service-role client (invite, sign-out) |
| src/lib/auth/{actions,staff,roles}.ts | new | server actions, current staff, role checks, lockout |
| src/proxy.ts | new | session refresh, staff/active check, redirects (Next.js 16 renamed middleware → proxy; Node.js runtime) |
| supabase/config.toml | new | CLI project config (migrations dir); auth settings mirrored from dev dashboard |
| supabase/migrations/0001_foundation.sql | new | office, staff_user, activity, enums, helper fns, RLS, login_attempt |
| supabase/seed.sql, scripts/bootstrap-env.ts | new | office seed + first Admin for any environment |
| tests/rls/*.test.ts | new | RLS tests: supabase-js as each role against dev |
| tests/unit/*.test.ts, tests/integration/*.test.ts | new | Vitest |
| tests/e2e/*.spec.ts, playwright.config.ts, tests/support/{auth,cleanup}.ts | new | Playwright against dev; codes via admin `generateLink`; tagged-data cleanup |
| .github/workflows/ci.yml | new | lint, typecheck, unit, RLS + e2e against dev (serialised), build |
| REVIEW.md, .claude/settings.json, .claude/hooks/production-gate.sh, .claude/agents/{verifier,sdlc-reviewer}.md | new | SDLC tooling |
| README.md | new | setup + "create an environment in < 30 min" |
| CLAUDE.md | mod | real verification commands |

## Migrations
- `0001_foundation.sql` (schema lock held by 01): enums `staff_role`, `staff_status`; tables `office`, `staff_user`, `activity`, `login_attempt`; functions `current_staff()`, `is_active_staff()`, `has_role()`, `log_activity()`; RLS default-deny + policies from spec.

## Steps
- [x] 1. Scaffold Next.js + TS + Tailwind + ESLint; scripts; `vercel.json` (bom1, headers) — proof: `npm run lint && npm run typecheck && npm run build`
- [x] 2. Test harness: Vitest + RTL, Playwright config, test-data tagging + cleanup helpers, one smoke test each — proof: `npm test`, `npm run test:e2e`
- [x] 3. Dev project auth settings: sign-ups off, email OTP 6-digit template, site URL — proof: settings verified via MCP/dashboard; `supabase/config.toml` records them
- [x] 4. Migration 0001 applied to dev (MCP `apply_migration`) + seed (Kushal Associates · Pondicherry, Admin rajak@pulsebay.in) — proof: tables/policies listed; Supabase security advisor shows no RLS warnings
- [x] 5. RLS tests first (Vitest as each role against dev): deactivated → 0 rows; non-admin write denied; activity immutable — proof: `npm run test:rls` green
- [x] 6. Supabase clients + proxy (session refresh, staff lookup, deactivated → sign out) — proof: integration tests
- [x] 7. Login flow (request code, verify, neutral message, lockout 5/15 min) — proof: e2e AC-1..3
- [x] 8. App shell per ui-reference (tokens, header, nav, avatar menu, sign out) + Clients empty state — proof: e2e AC-4, 12–14 + screenshot vs mockup 01/03
- [x] 9. Users and roles: list, invite, change role, deactivate/reactivate, last-admin guard, activity logging — proof: integration + e2e AC-5..11
- [x] 10. Accessibility pass (axe in Playwright on /login, /clients, /settings/users) — proof: 0 serious/critical violations
- [x] 11. CI workflow (local Supabase in runner) — proof: green run on the PR
- [x] 12. SDLC tooling: REVIEW.md, verifier + sdlc-reviewer agents, production-gate hook — proof: hook blocks `git push origin main` in a dry test
- [x] 13. Link dev: `supabase db push` to dev project `ysddbwskljzhbjjohool` + seed; user imports repo in Vercel, sets env vars; bom1 verified — proof: Admin signs in on dev URL (AC-1, 16)
- [x] 14. (deferred by agreement → timed dry-run at staging creation) README environment procedure + dry-run on a scratch Supabase project (then deleted, with your OK) — proof: AC-17 timed < 30 min
- [x] 15. sdlc-reviewer pass, fix Important findings, open PR — proof: PR green, review requested

## Deviations from plan
- Review (step 15): nonce-based CSP added in `proxy.ts` (was planned for step 8 but missed). Not delivered in 01 and tracked: forced re-sign-in after 7 days inactivity (Supabase session inactivity timeout is a paid-plan setting — enable at prod setup); LCP < 2.5 s not measured yet (measure on prod URL before pilot).
- E2E sign-in helper uses the emailed-link route. Correct-code and invite flows are UI-tested too: the app never emails reserved `.test` addresses (protects the send quota), so the admin-API code/link is the only valid one in tests.
- Dev email: custom SMTP via dedicated Gmail `cadocvault.dev@gmail.com` (App Password), chosen to avoid DNS changes on pulsebay.in; unlocks templates (code + link). Prod remains SES ap-south-1 on the firm's domain.
- Sign-in: link (PKCE) + invite-link handler added at `/auth/callback` (approved spec change 2026-09-25); `/auth/removed` route clears the session for deactivated users (Server Components cannot clear cookies).
- Step 2: Playwright browser download is blocked in the Cowork workspace → e2e runs in GitHub Actions (step 11) only; everything else runs locally each step.
- Step 1: Next.js 16 renamed middleware → `proxy.ts`; Google Fonts blocked → IBM Plex Sans self-hosted via @fontsource (also avoids a third-party request).

## Risks
| Risk | Mitigation |
|---|---|
| RLS gap exposes data later | RLS tests written before app code (step 5); default-deny; reviewer checks every new table |
| Service-role key leaks to browser | `server-only` import; ESLint rule forbidding admin client outside `src/lib/supabase/admin.ts`; env var not `NEXT_PUBLIC_` |
| Supabase email limits block testing | tests generate codes via admin API — no emails sent |
| Tests pollute/collide in shared dev DB | tagged test data + cleanup; CI concurrency group (one run at a time) |
| Migration mistake on dev (no local sandbox) | dev = synthetic data only; migrations reviewed before apply; staging mandatory before prod |
| Dev project paused (free plan) | CI detects and fails with clear message; resume |
| Vercel step needs your dashboard access | step 13 is a short guided checklist; everything else automated |
Rollback: dev only — revert PR + compensating migration. No production exists.

## Proof of done
AC table (AC-1..17 → test file → pass) in the PR description; CI green; screenshots of /login, /clients, /settings/users beside mockup 01/03/06; Admin sign-in demonstrated on the dev URL.

## Session log
### 2026-09-25
- Done: product foundation approved; intent approved; mockup captured; spec + plan drafted
- In progress: spec + plan approved (no local Supabase; tests against hosted dev; staging mandatory before prod)
- Blocked / failing: —
- Next step: step 13 (Vercel import by user), 14 (env procedure dry-run), 15 (review + PR ready)
- Decisions made (cross-cutting → flag for architecture.md): office_id everywhere (applied); env naming (applied)

### 2026-09-25 (build)
- Done: steps 1–12. Migrations applied to dev; Admin rajak@pulsebay.in linked (invited). CI green on PR #1: verify job + RLS (10 tests) + e2e (10 passed, 1 skipped: invite email).
- In progress: step 13 (Vercel), 14, 15.
- Blocked / failing: none. Cowork egress blocks *.supabase.co (DB tests run in CI) and Playwright browser download.
- Decisions: link sign-in while on default Supabase email (approved); AC-10 asserts Not Found content (HTTP 200 due to streaming); e2e uses per-run test offices; no local Supabase.
- Flag for architecture.md: custom SMTP (SES) required before pilot for codes + invites to non-members (already in risks).

### 2026-09-25 (ship)
- Done: steps 13–15. Vercel dev (team `cad-oc-vault`, bom1) + preview deploys; dev email via custom SMTP (Gmail `cadocvault.dev@gmail.com`, App Password); Admin rajak@pulsebay.in signed in with code on the preview → Active, audited. Review finding fixed: nonce-based CSP. CI: RLS tests + 14 e2e green. Dev test data purged; tests now reuse fixture users.
- In progress: merge PR #1 (owner approved in chat).
- Blocked / failing: none.
- Next step: on main — mark 01 shipped, release locks, apply architecture flags; then Parallel planning checkpoint for 02–06.
- Decisions: AC-17 timed dry-run happens at staging creation (owner OK); `main` protected (PR + both CI checks, 0 required approvals because single maintainer).
- Flag for architecture.md: SMTP per env (dev Gmail, prod SES) — already recorded; Supabase OTP length is 8 on new projects (app accepts 6–8).
