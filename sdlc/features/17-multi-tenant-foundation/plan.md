# Plan: Multi-tenant foundation
Spec: ./spec.md · Status: **approved** (Sidambara, 2026-11-03) · Date: 2026-11-03

## Locks
- At plan approval, on main (small roadmap commit/PR): **schema lock → 17, architecture lock → 17**, status `in-progress`.
- Merge of docs PR #23 first (roadmap row 17), so the lock commit applies cleanly.

## Files that change
| Path | New/modified | Why |
|---|---|---|
| `src/lib/tenancy.ts` | new | `tenancyMode()`, the only reader of `TENANCY_MODE` (AC-1, AC-2) |
| `eslint.config.mjs` | modified | `TENANCY_MODE` fence, added to the shared secrets-fence block (AC-2) |
| `src/lib/auth/login-brand.ts` | new | `loginBrand()`: multi → constant, no DB; single → one non-test office (AC-3, AC-4) |
| `src/app/(auth)/login/page.tsx` | modified | uses `loginBrand()`; drops the direct service-role query |
| `src/lib/mail/core.ts`, `src/lib/mail/index.ts` | modified | `fromName` on the message, sanitise, fallback (AC-6–8) |
| `src/lib/reminders/actions.ts`, `src/lib/upload-links/actions.ts` | modified | pass `fromName: me.officeName` |
| `src/lib/staff/actions.ts` | modified | neutral message; `data: { firm }` on invite (AC-12, AC-13) |
| `src/app/(app)/settings/layout.tsx` | modified | Office item for Admin (AC-9) |
| `src/app/(app)/settings/office/page.tsx`, `office-form.tsx`, `src/lib/office/actions.ts` | new | Settings › Office (AC-9–11) |
| `src/lib/auth/permissions.ts` | modified | row `edit_office` (AC-10) |
| `src/lib/activity-feed/catalogue.ts` | modified | sentences for `office.updated`, `office.bootstrapped` (08's coverage test) |
| `supabase/migrations/2026110xxxxxxx_multi_tenant.sql` | new | deployment row, guard, office update grant/policy, `bootstrap_office`, test probe |
| `scripts/bootstrap-firm.mjs` (+ `scripts/bootstrap-core.mjs` for testable logic) | new | operator bootstrap (AC-14–18) |
| `tests/unit/tenancy.test.ts`, `login-brand.test.ts`, `office-form.test.tsx`, `bootstrap-script.test.ts` | new | unit |
| `tests/unit/mailer.test.ts`, `tests/unit/permissions.test.ts` | modified (additions only) | From name; new row |
| `tests/rls/office.test.ts`, `tests/rls/bootstrap.test.ts` | new | update rules, guard, two-firm edges, bootstrap function |
| `tests/rls/role-matrix.test.ts` | modified (additive probe) | `edit_office` probe per role |
| `tests/e2e/office-settings.spec.ts`, `tests/e2e/tenancy-edges.spec.ts` | new | Admin edit flow; login text + invite message across firms |
| `sdlc/product/architecture.md` | modified (architecture lock) | spec › Proposed architecture changes 1–6 |
| `sdlc/releases/README.md` | modified | staging/prod: `TENANCY_MODE`, bootstrap run, invite template, sender env |
| `sdlc/product/references/ui-reference.md` | modified | deviation row: Settings › Office (no mockup) |
| `.env.example` | modified | `TENANCY_MODE` name, comment |

## Migrations
One: `2026110xxxxxxx_multi_tenant.sql` (spec › Data model 1–5). Applied to dev before review; live function bodies checked md5 = file; recorded in the PR (CLAUDE.md rule).

## Steps
- [ ] 0. Branch housekeeping: confirm #23 merged, locks commit on main, rebase this branch on main. — proof: `git log`, roadmap shows locks → 17
- [x] 1. `tenancy.ts` + ESLint fence + unit tests (unset/multi/single/invalid; a test that greps `src/` for `TENANCY_MODE` outside the allowed file). — proof: `npx vitest run --project unit tests/unit/tenancy.test.ts`, `npm run lint`
- [x] 2. `login-brand.ts` + login page change + unit test (multi: constant and `createAdminClient` never called — mocked spy; single: non-test office name/branch; none → constant). — proof: unit file; existing `smoke.spec.ts` / `auth.spec.ts` unedited and green in CI
- [x] 3. Mailer `fromName` (sanitise CR/LF/quotes/angle brackets, ≤ 70, fallback to `MAIL_FROM_NAME`) + both callers + `mailer.test.ts` additions (failing first). — proof: unit; 06/10 RLS + e2e unedited
- [x] 4. Migration + `office.test.ts` (Admin updates name/branch; Manager/Staff/Limited refused; other columns refused; other firm's row refused; guard via `test_single_office_guard()`; multi = no guard) + `bootstrap.test.ts` (create, reuse while no staff, refuse once staffed, claim only in single — through the test probe, mode mismatch refused, service-role-only grants). Written failing first, then the migration. Apply to dev (Supabase connector), md5 check. — proof: `npx vitest run --project db tests/rls/office.test.ts tests/rls/bootstrap.test.ts` against dev
- [x] 5. Settings › Office: page, form, server action (zod 1–120, trimmed; `revalidatePath("/", "layout")`; `logActivity` `office.updated` with field names), layout item, permissions row + role-matrix probe, catalogue sentences. — proof: unit (`office-form`, `permissions`, `activity-catalogue`), RLS `role-matrix`, e2e `office-settings.spec.ts` locally
- [x] 6. Invite: neutral message + `data.firm`; unit test on the invite options (mocked admin client); e2e addition in `tenancy-edges.spec.ts` (Admin of firm B invites firm A's staff email → AC-12 text). — proof: unit + e2e locally
- [ ] 7. (code + unit tests done; the one real `--test` run on dev waits for dev keys in a session) Bootstrap script: `bootstrap-core.mjs` (argument parsing, refusals: `.test` without `--test`, production ref without `--yes-production`, dry run without `--yes`) + `bootstrap-firm.mjs` (calls `bootstrap_office`, then invite + `staff_user` insert + activity; re-run safe). Unit tests with a mocked client; one real run on dev with `--test` into a fresh `e2e office bootstrap` test office. — proof: unit file; dev run output recorded in the session log
- [x] 8. Cross-firm edges: `tenancy-edges.spec.ts` (two test firms; login shows "CA Document Vault"; B's reminder From name is B's via the test transport's captured message; B's `/u` shows B) + `office.test.ts` two-firm RLS cases. — proof: e2e + RLS locally
- [x] 9. Docs: `architecture.md` (6 items), `releases/README.md` checklist, `ui-reference.md` row, `.env.example`. — proof: diff reviewed
- [ ] 10. Full verification (lint, typecheck, unit, RLS on dev, build; e2e in CI) → `verifier`; `sdlc-reviewer` → fix Important findings failing-first → PR with AC → test → result table; dev Regression `only` = 17's RLS files. — proof: CI green on the last code commit

## Risks
| Risk | Mitigation | Rollback |
|---|---|---|
| Login text change breaks an existing e2e assertion | Searched: smoke/auth assert "Sign in" heading only, not the office name. Step 2 runs both locally | Revert step 2 commit |
| A test office could trip the guard on dev | Guard counts only non-test offices; dev gets no deployment row (guard off); the probe refuses to run if a real deployment row exists | Drop the trigger in a follow-up migration |
| `fromName` sanitising changes 06/10 email text | Only the From header changes; body untouched; 06/10 tests unedited must stay green | Revert step 3 |
| Column grant on `office` widens writes | Grant limited to `(name, branch)`; policy Admin + own office; RLS test covers every other column and other firms | Revoke in a follow-up migration |
| Bootstrap invite fails mid-way (office created, no admin) | Re-run reuses the staff-less office (AC-15) | Re-run |
| Session can't run e2e/RLS without dev keys | Copy `.env.local` from the Mac via the desktop link (CLAUDE.md); otherwise rely on CI + dev Regression `only` | — |

## Proof of done
- Every AC → test (spec › Test strategy) green; table in the PR.
- Full suite green in CI on the last code commit, nothing edited (AC-22); additive edits only to `mailer.test.ts`, `permissions.test.ts`, `role-matrix.test.ts`.
- Migration on dev, md5 = file; dev Regression `only` = `rls/office rls/bootstrap rls/role-matrix` green.
- Bootstrap dry run + real run on dev (test office) recorded.
- No RUN_SLOW (no 02/03 write path).

[Likely] ≈ 4–6 working days of build sessions + review.

## Deviations from plan
- **Step 3 — `fromName` is a send option, not a message field** (`sendMail(message, cfg, { fromName })`, `deliver(…, opts)`). 06's `reminder-actions.test.ts` compares the whole message with `toEqual`; a new message field would have meant editing that test. As an option, every existing test stays unedited and the message type is unchanged. Behaviour is as specified (AC-6, AC-7).
- **Step 4 — `bootstrap_office` has a test path** (`test: true`): it works only on test offices and never reads or writes the deployment mode. Offices can't be deleted, so tests on the real path would leave real firms on dev (picked up by the daily job).
- **Step 4 — the guard probe is `public.test_tenancy_probe()`, not the spec's `test_single_office_guard()`**: one service-role probe, each scenario in a rolled-back block, covers the guard (single / multi / unset), the single-mode claim and the mode mismatch. Inside each block the existing real offices are flagged as test offices, so the result doesn't depend on what dev or CI's stack holds. It refuses where a deployment mode is set or no test office exists (prod), so `office.test.ts`'s probe tests skip on staging after its bootstrap (release README › Firms and tenancy, item 7).
- **Step 4 — catalogue sentences for `office.updated` / `office.bootstrapped` moved here from step 5** (08's coverage test fails as soon as a migration writes a new action).
- **Files differ slightly from "Files that change":** new `src/lib/office/schema.ts` (validation, unit-testable) and `src/app/(app)/settings/office/{loading,error}.tsx` (architecture "Screens" rule); the form test is `tests/unit/office-settings.test.tsx` (planned `office-form.test.tsx`); the login test is `tests/unit/login-brand.test.ts`, testing the module that decides the brand (the spec named `login-page.test.tsx`); new `tests/unit/staff-invite.test.ts` and `tests/unit/sender-wiring.test.ts`.
- **AC-21 "B's upload page shows B's name"** has no new test: `/u` shows the link's own office (`link_open` returns that office's name; 10's tests, unchanged). The other AC-21 edges are in `office.test.ts` and `tenancy-edges.spec.ts`.
- **Review fixes (sdlc-reviewer, 2026-11-03; dev delta `multi_tenant_review_fixes`):** probe skips where it refuses by design (I-2); the multi probe bootstraps next to exactly one staff-less firm, so "created" proves multi never claims (I-3); the script needs `--env dev|staging|prod`, treats `--env prod` or `APP_ENV=production` as production, and refuses `--test` there (I-4); sender-wiring test for both callers (I-6); advisory locks in the guard and the bootstrap (N-1, N-2); the probe also refuses with no test office (N-3); a stronger "left nothing behind" test (N-4); the script checks the email first, withdraws the invite if the staff row fails, and reports a failed activity row (N-5); `senderName` strips all control/format characters and cuts by character (N-6); RLS on `private.deployment` (N-7); Office loading/error states (N-8); `data.firm` is template-only, commented (N-13); architecture's matrix count (N-12). **I-5 decided (Sidambara, 2026-11-03): reuse only by explicit office ID** — spec AC-15 amended; `bootstrap_office(p.office_id)`, script `--office <id>`, dry run lists staff-less namesakes; the probe proves the same name without an ID makes a second firm (dev delta `multi_tenant_reuse_by_id`). I-1 (locks on main) = docs PR #23.
- **Live md5 on dev after the deltas:** `bootstrap_office` ff03e5f7…, `test_tenancy_probe` 1ec247d3…, `office_single_guard` 90af908b…

## Session log
### 2026-11-03
- Done: intent approved (Q1–Q7); spec approved (S1–S6); plan approved; roadmap row + locks in docs PR #23 (open). Steps 1–6, 8, 9 built; migration on dev (+ review delta); draft PR #24. CI green on 78510e9 (steps 1–7; RLS `office` 9, `bootstrap` 4, `role-matrix` 109 on the local stack; both new e2e specs). sdlc-reviewer: 6 Important / 13 Nits, all fixed except I-5 (owner) and I-1 (merge #23).
- In progress: CI on the review fixes (73f5792 + this commit); step 7's real `--test` run on dev; step 10 (AC table, ready for review).
- Blocked / failing: step 0 needs PR #23 merged.
- I-5 decided (reuse only by office ID) and built.
- Next step: CI green → AC table → mark PR #24 ready; step 7's real `--test` run on dev when a session has dev keys.
- Decisions made (cross-cutting): written in architecture.md on this branch (17 holds the architecture lock once #23 merges).
