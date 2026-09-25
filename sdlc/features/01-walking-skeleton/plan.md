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
- [ ] 2. Test harness: Vitest + RTL, Playwright config, test-data tagging + cleanup helpers, one smoke test each — proof: `npm test`, `npm run test:e2e`
- [ ] 3. Dev project auth settings: sign-ups off, email OTP 6-digit template, site URL — proof: settings verified via MCP/dashboard; `supabase/config.toml` records them
- [ ] 4. Migration 0001 applied to dev (MCP `apply_migration`) + seed (Kushal Associates · Pondicherry, Admin rajak@pulsebay.in) — proof: tables/policies listed; Supabase security advisor shows no RLS warnings
- [ ] 5. RLS tests first (Vitest as each role against dev): deactivated → 0 rows; non-admin write denied; activity immutable — proof: `npm run test:rls` green
- [ ] 6. Supabase clients + proxy (session refresh, staff lookup, deactivated → sign out) — proof: integration tests
- [ ] 7. Login flow (request code, verify, neutral message, lockout 5/15 min) — proof: e2e AC-1..3
- [ ] 8. App shell per ui-reference (tokens, header, nav, avatar menu, sign out) + Clients empty state — proof: e2e AC-4, 12–14 + screenshot vs mockup 01/03
- [ ] 9. Users and roles: list, invite, change role, deactivate/reactivate, last-admin guard, activity logging — proof: integration + e2e AC-5..11
- [ ] 10. Accessibility pass (axe in Playwright on /login, /clients, /settings/users) — proof: 0 serious/critical violations
- [ ] 11. CI workflow (local Supabase in runner) — proof: green run on the PR
- [ ] 12. SDLC tooling: REVIEW.md, verifier + sdlc-reviewer agents, production-gate hook — proof: hook blocks `git push origin main` in a dry test
- [ ] 13. Link dev: `supabase db push` to dev project `ysddbwskljzhbjjohool` + seed; user imports repo in Vercel, sets env vars; bom1 verified — proof: Admin signs in on dev URL (AC-1, 16)
- [ ] 14. README environment procedure + dry-run on a scratch Supabase project (then deleted, with your OK) — proof: AC-17 timed < 30 min
- [ ] 15. sdlc-reviewer pass, fix Important findings, open PR — proof: PR green, review requested

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
- Next step: step 1 (scaffold), built in this Cowork session against hosted dev (no Docker)
- Decisions made (cross-cutting → flag for architecture.md): office_id everywhere (applied); env naming (applied)
