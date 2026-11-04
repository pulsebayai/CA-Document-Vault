# Plan: Super admin console
Spec: ./spec.md (approved 2026-11-04) · Status: **approved** (Sidambara, 2026-11-04 13:36) · Date: 2026-11-04

## Locks
- At plan approval, a small roadmap PR on main gives **schema lock → 19, architecture lock → 19** and sets row 19 to `in progress`. PR #30 (18 shipped) merges first, so the lock commit applies cleanly.
- Both locks are released at 19's merge.

## Files that change
| Path | New/modified | Why |
|---|---|---|
| `supabase/migrations/2026110xxxxxxx_platform_a.sql` | new | Tables `platform_admin`, `platform_access`, `platform_audit`; `office` suspend columns; email-clash trigger pair; append-only guard; `notification_kind` value; `private.require_platform_admin()`, `private.platform_access_ok()` |
| `supabase/migrations/2026110xxxxxxx_platform_b.sql` | new | `current_office_id()` suspended → null; `link_request` + `run_daily_expected` skip suspended; `bootstrap_office` body → `private.bootstrap_core()` (no behaviour change); every `public.platform_*` function |
| `scripts/add-platform-admin.mjs` + `scripts/platform-admin-core.mjs` | new | operator script (dry run, `--yes`, `--yes-production`, `.test` only with `--test`), same pattern as 17 |
| `src/lib/platform/actions.ts` | new | server actions wrapping the `platform_*` RPCs as the signed-in user (RLS client), zod-validated |
| `src/lib/platform/invite.ts` | new | the one service-role step: `inviteUserByEmail` after `platform_whoami()` confirms the caller (ESLint allow-list + one line in architecture.md) |
| `src/lib/platform/guard.ts` | new | `requirePlatformAdmin()`: active super admin or `notFound()`; `isPlatformAdmin()` for routing |
| `src/lib/auth/finish.ts`, `src/lib/auth/staff.ts`, `src/lib/auth/actions.ts` | modified | after sign-in: super admin → `/platform`, suspended firm → `/auth/paused`; `requireStaff` sends super admins to `/platform` and suspended staff to `/auth/paused` |
| `src/app/auth/paused/page.tsx` | new | "This firm's access is paused. Contact your firm's administrator." (signs out) |
| `src/app/(platform)/platform/layout.tsx`, `page.tsx` (firms), `firms/new/page.tsx`, `firms/[id]/page.tsx` (summary, suspend, access), `firms/[id]/clients…`, `…/documents…`, `…/expected`, `…/activity`, `audit/page.tsx` + loading/error states | new | Platform area (Y5, Y7, AC-12) |
| `src/lib/activity-feed/catalogue.ts` | modified | sentences for `platform.access_opened`, `platform.viewed`, `office.suspended`, `office.reactivated`, `firm.created` (08's coverage test) |
| `src/components/notification-bell…` (05) | modified | text for kind `platform_access` |
| `eslint.config.mjs` | modified | service-role allow-list + `src/lib/platform/invite.ts` |
| `tests/rls/platform.test.ts`, `tests/rls/platform-suspend.test.ts` | new | AC-1, AC-4–AC-12 at the database |
| `tests/rls/cross-firm/coverage.ts`, `functions.ts`, `sweep.test.ts` | modified (additions) | 18's guard: the new tables and functions; the platform section (Y9, AC-14) |
| `tests/support/platform.ts` | new | super admin fixture (`.test`), helpers |
| `tests/unit/platform-*.test.ts`, `tests/unit/platform-admin-script.test.ts` | new | routing, actions, invite module (mocked), script |
| `tests/e2e/platform.spec.ts` | new | AC-2, AC-3, AC-6–AC-9, AC-13 on screen |
| `sdlc/product/architecture.md` | modified (architecture lock) | spec › Proposed architecture changes 1–5 + decision rows, incl. the accepted risk |
| `sdlc/releases/README.md` | modified | staging/prod: add super admins with the script (named few, own mailboxes), smoke the console |
| `sdlc/product/references/ui-reference.md` | modified | deviation rows: Platform area (no mockup) |
| `CLAUDE.md` | modified | one line: platform functions check the caller in the database and log before returning |

## Migrations
**A (schema):** tables, columns, guards, the two private checks.
**B (behaviour):** the `current_office_id` change, the link/nightly skips, the bootstrap refactor and the platform functions.

Both are applied to dev before review. Live function bodies are checked by md5 against the files and recorded in the PR. Then a Regression dispatch with `only` = 19's RLS files (CLAUDE.md).

**RUN_SLOW before merge** (CLAUDE.md): `current_office_id()` is used by every write path. Plus re-timing 02's `clients-list` and 15's K4 card (AC-15).

## Steps
- [x] 0. Locks PR on main (after #30); rebase the branch. *(the lock change was added to PR #30 itself, renamed "18 shipped + 19 started"; awaiting merge)* — proof: roadmap shows locks → 19
- [x] 1. **Failing first:** `tests/rls/platform.test.ts` (identity, email clash, every `platform_*` refuses staff and deactivated super admins, read views need a window for this firm, IDs of another firm refused, audit + firm activity rows, IDs only) and `platform-suspend.test.ts` (staff refused at once, links `NOT_ACTIVE`, nightly skip, reactivate restores, test offices and single mode refused). Red until step 2. — proof: red run recorded
- [ ] 2. **Migration A + B** on dev (md5 = file). Time `clients-list` and K4 before/after the `current_office_id` change (AC-15). Step 1 goes green; 17's `bootstrap` / `office` tests unedited and green. — proof: RLS run log + timings
- [ ] 3. **18's guard + sweep:** coverage lines for every new object, plus a platform section in the sweep:
  - each `platform_*` function × {Firm A Admin, deactivated super admin, super admin without a window, window for another firm};
  - "no path to writes, files or DSC": every function executable by a super admin is either a `platform_*` function or refused by RLS.
  
  — proof: `tests/rls/cross-firm/` green
- [ ] 4. **Operator script:** add-platform-admin core + unit tests; one real dev run with `--test`. — proof: unit + run output
- [ ] 5. **Sign-in routing + paused page:** `finish.ts`, `staff.ts`, `/auth/paused`, `requirePlatformAdmin`. Unit tests for the routing table: staff, super admin, suspended staff, deactivated, neither. — proof: unit
- [ ] 6. **Platform screens:**
  - firms list;
  - create firm + invite (the `invite.ts` service-role step) + resend;
  - firm page with suspend/reactivate;
  - open/close access with countdown;
  - the six read views (20 per page);
  - audit list.
  
  Each has loading and error states, follows the shared UI tokens, and meets WCAG AA (axe). — proof: unit (actions, invite mocked), e2e locally
- [ ] 7. **Firm side:** activity sentences, the bell text for `platform_access`, catalogue coverage test. — proof: unit
- [ ] 8. **e2e** `platform.spec.ts`:
  - sign in → firms → create a test firm → open access → view a client (PII visible) → the firm Admin sees the activity line and bell → close;
  - suspend → the firm's staff see the paused page → reactivate.
  
  Run locally against a local build. — proof: local run
- [ ] 9. **Docs:** architecture (5 items + decision rows incl. accepted risk), releases README, ui-reference, CLAUDE.md line. — proof: diff
- [ ] 10. **Full verification:**
  - lint, typecheck, unit, full RLS on dev (foreground batches), build;
  - `verifier` → `sdlc-reviewer` + a security review of the platform functions (it's the most privileged path) → fix Important findings failing-first;
  - PR with the AC → test → result table;
  - dev Regression `only` = 19's files, plus RUN_SLOW.
  
  — proof: CI green on the last code commit

## Risks
- **`current_office_id()` cost:** measured in step 2. If `clients-list` slows by more than 5 %, keep the suspended check in a cached per-statement form (`(select …)` wrapper, already used by every policy). Never loop per row.
- **Bootstrap refactor:** moving the body behind a helper must keep 17's tests unedited. If they need editing, stop and ask.
- **Super admin hitting staff pages:** the redirect lives in `requireStaff`. Every staff page already calls it via the `(app)` layout.
- **The public upload page (`/u`) while suspended:** must show the same generic page as any unusable link. 10's public tests stay unedited.

## Estimate
[Uncertain] 8–10 working days:
- steps 0–3 ≈ 3 days;
- 4–5 ≈ 1 day;
- 6–8 ≈ 3 days;
- 9–10 ≈ 1–2 days plus review fixes.

## Deviations
- **D1 (step 1): test super admins touch test firms only.** A super admin whose email ends in `.test` sees and acts on test offices only, and a real super admin on real offices only. Test fixtures can then never reach a real firm on staging or prod, and `platform_create_firm` by a `.test` super admin takes 17's test path, so the deployment mode is never set on dev. Each test run creates one new test firm (its first Admin can't be removed: no hard delete); the growth is small (≈ a few per day) and these offices are purged like any test office.
- **D2 (step 1):** first Admin = two steps. `platform_create_firm` returns the office; the server's invite module invites by email (admin API, which also creates the auth user), then `platform_record_first_admin(office, user, name, email)` records the staff row. A failed invite leaves a staff-less firm that can be retried, as 17's script does.
- **D3 (step 1):** the nightly-skip check (AC-7) needs a real office (`run_daily_expected` skips test offices), so it is proven with a rolled-back probe in step 2, as 17's `test_tenancy_probe` does; `it.todo` until then.
- **Step 1 red run (2026-11-04):** `tests/rls/platform.test.ts` + `platform-suspend.test.ts` fail at setup (`public.platform_admin` doesn't exist), 17 tests not reached.
