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
- [x] 2. **Migration A + B** on dev (md5 = file). Time `clients-list` and K4 before/after the `current_office_id` change (AC-15). Step 1 goes green; 17's `bootstrap` / `office` tests unedited and green. — proof: RLS run log + timings
- [x] 3. **18's guard + sweep:** coverage lines for every new object, plus a platform section in the sweep:
  - each `platform_*` function × {Firm A Admin, deactivated super admin, super admin without a window, window for another firm};
  - "no path to writes, files or DSC": every function executable by a super admin is either a `platform_*` function or refused by RLS.
  
  — proof: `tests/rls/cross-firm/` green
- [x] 4. **Operator script:** add-platform-admin core + unit tests; one real dev run with `--test`. — proof: unit + run output
- [x] 5. **Sign-in routing + paused page:** `finish.ts`, `staff.ts`, `/auth/paused`, `requirePlatformAdmin`. Unit tests for the routing table: staff, super admin, suspended staff, deactivated, neither. — proof: unit
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
- **Step 2 (2026-11-04):** migrations A + B applied on dev; all 29 function bodies md5 = file (B's `platform_create_firm` then re-applied as a dev delta `platform_b_create_firm_claims`, body = file). `platform.test.ts` + `platform-suspend.test.ts` green (16 passed, 1 todo); 17's `bootstrap` / `office`, the role matrix and 10's `upload-links` / `upload-links-public` unedited and green (152 passed).
  - **AC-15 timings (server side, old vs new helper bodies A/B in one rolled-back transaction):** `search_clients` first page, Admin, 1,003 clients: new 468.8 ms vs old 466.7 ms median (+0.4 %, budget 5 %). K4 card (`activity_feed` by document, 200k rows): Staff 27.8 vs 24.1 ms, Limited 50.8 vs 55.6 ms (noise, opposite signs; budget 1 s).
  - **D3 proven:** rolled-back probe on a real dev office: suspended → `run_daily_expected` wrote 0 activity rows for it; the same office unsuspended → 1 (`expected.generated`). One-off proof; the `it.todo` stays (a repeatable probe would need a service-role test function — not added).
- **D4 (step 2): no `bootstrap_core` refactor.** `platform_create_firm` calls 17's `bootstrap_office` unchanged (it is definer and callable from a definer), so 17's function and tests are untouched.
- **D5 (step 2): the bootstrap runs with the JWT claims cleared for that one call.** 02's tenant-first triggers (`doc_type_before_write` …) check `current_office_id()` for any caller with a JWT, and a super admin has no office (`OFFICE_DENIED`). Clearing `request.jwt.claims` transaction-locally around the call gives the operator path 17's script uses; the caller is checked before and the claims restored after (same technique as 10's `link_act_as`).
- **D6 (step 2): two step-1 test set-ups corrected (never green before; assertions not weakened).** (a) `link_open` answers an unusable link with `{ active: false }` (10's contract; only `link_ticket` / `link_register` return `{ error: "NOT_ACTIVE" }`): the suspend check now asserts `{ active: false }` and the control requires `active === true` (it accepted `{ active: false }` before, so it is stricter). (b) The expiry case moved `expires_at` before `opened_at`, which the table's check refuses; it now moves both and asserts the update succeeded.
- **Step 3 (2026-11-04):** 18's guard green with every new object listed (3 tables, 16 `platform_*` + `my_access_state` + `test_platform_probe`, 7 private helpers via the platform cases). Sweep on dev **166 passed / 0 failed** (was 145), no leak:
  - the 16 platform functions refuse Firm A's staff for Firm B's office and Firm A's own alike (closed for everyone, NOT_PLATFORM_ADMIN), also Limited, Staff and a deactivated super admin; an active one gets past the check (controls use a too-short reason / empty name, so nothing changes);
  - a window on Firm A: every read view refuses Firm B's office (NO_ACCESS) and Firm B's client/document IDs (NOT_FOUND), another super admin without a window gets NO_ACCESS, another super admin can't close it, and after closing the views stop;
  - a super admin reaches no firm table, no staff function's data (all 63 called with Firm A's control arguments), no Storage object; Firm A's snapshot unchanged;
  - the seed opens and closes a window on each firm, so `platform_access` / `platform_audit` hold rows of both and are swept like 18's no-policy tables.
- **D3 resolved (step 3):** the nightly skip is now a repeatable test: `public.test_platform_probe()` (service role; refused wherever a deployment mode is set, like 17's probe; added to migration B and applied on dev as delta `platform_b_test_probe`). `platform-suspend.test.ts` asserts `{ suspended_rows: 0, control_rows: 1 }`.
- **Step 3 test fix (my new case, never green):** "nothing outside the platform functions" first counted any non-empty answer as a leak; `today_items` answers a super admin with an empty card list and today's date. It now fails on any answer naming Firm A's IDs or marker (the read rule, applied to Firm A), plus Firm A's snapshot. `PLATFORM_FUNCTIONS` gained `platform_invite_target` (missing since step 1).
- **Step 4 (2026-11-04):** `scripts/add-platform-admin.mjs` + `scripts/platform-admin-core.mjs`, 16 unit tests (`tests/unit/platform-admin-script.test.ts`); lint + typecheck clean. Real dev run with `--test`: dry run (nothing written) → added (confirmed account, row, audit `admin.added`) → add again refused → `--deactivate` (status + open windows closed, audit) → add again refused with "Use --reactivate" → `--reactivate`; a staff member's email refused with the neutral message; `--env prod` without `--yes-production`, `APP_ENV=production` with `--env dev`, `--test` on prod and a `.test` address without `--test` all refused before any connection.
- **D7 (step 4): the script also deactivates and reactivates** (`--deactivate` / `--reactivate`), so a super admin who leaves is removed without a delete (no hard delete) and their open support windows close at once. No email is sent: sign-in already needs an existing confirmed account (`shouldCreateUser: false`), so the script creates one and the operator tells the person. Operator changes write a `platform_audit` row whose `admin_id` is the super admin the change is about (the operator has no row), `detail: { via: "script" }`. The test fixture (`tests/support/platform.ts`) now adds super admins through the script's core (spec: fixtures use the script).
- **Step 5 (2026-11-04):** one routing table `src/lib/auth/access.ts` (staff · platform · suspended · none) used by sign-in and by `requireStaff`'s refusal path. `finishSignIn` returns the state; the login form sends a code to an active super admin too (never to a deactivated one, same neutral answer); `requireStaff` asks `my_access_state()` only when the staff row is missing; `requirePlatformAdmin` (`src/lib/platform/guard.ts`) = `platform_whoami()`: signed out → /login, anyone else → Not Found. Platform layout + placeholder page (step 6 fills it). 23 unit tests (`tests/unit/platform-routing.test.ts`), checked by breaking the table and the active-status check (both caught). Typecheck, lint, build clean; unit 740/741 — the one failure is 08's activity-sentence coverage for the four actions migration B writes (`platform.viewed`, `platform.access_opened`, `office.suspended`, `office.reactivated`), which is step 7.
- **D8 (step 5): "paused" is a route + the login notice, not a page.** `/auth/paused` signs out and redirects to `/login?reason=paused` ("This firm's access is paused. Contact your firm's administrator."), the same pattern as 01's `/auth/removed` (a Server Component can't clear the session cookie). The code form shows the notice inline. A suspended firm's invited staff member isn't activated while the firm is paused.
- **D9 (step 5): a super admin's sign-in is recorded in the platform audit (`auth.signed_in`, method only) and fails closed:** if that row can't be written, the user is signed out (Y3, "log before return").
