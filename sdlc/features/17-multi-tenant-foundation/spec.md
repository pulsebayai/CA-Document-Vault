# Spec: Multi-tenant foundation
Intent: ./intent.md · Status: draft · Date: 2026-11-03

## Summary of design decisions (proposed; marked S-n for the gate)
- **S1 — Sender name = the firm's name.** No separate sender column: the From display name is `office.name`, edited on Settings › Office. One platform From address (`MAIL_FROM_EMAIL`); Reply-To stays the staff member (intent Q2). `MAIL_FROM_NAME` becomes the fallback for mail with no office (none today).
- **S2 — Email ceiling stays per office** (intent Q6): `EMAIL_DAILY_MAX` keeps applying to each office separately, as today. No new column.
- **S3 — Single-office guard in the database:** a one-row `private.deployment` (tenancy mode) written by the bootstrap; a trigger on `office` refuses a second real (non-test) office when the mode is `single`. Test offices are exempt.
- **S4 — Bootstrap = operator script + one SQL function:** `scripts/bootstrap-firm.mjs` (service role, run by the operator against one environment) calls `public.bootstrap_office(p jsonb)` (service role only), then invites the first Admin through Supabase Auth. Re-runnable.
- **S5 — Login page:** `multi` shows "CA Document Vault" and reads **nothing** from the database (today it reads `office` with the service role on a public page); `single` shows the deployment's one real office.
- **S6 — CI "both modes" without a second e2e run:** the full suite runs in `multi` (unset = multi). `single` behaviour is covered by unit/component tests (mode module, login page) and an RLS test of the guard. No extra e2e job.

## User stories & acceptance criteria

### Tenancy mode
- **AC-1** Given `TENANCY_MODE` is unset, When the server reads the mode, Then it is `multi`. Given `multi` or `single` (any case, trimmed), Then that mode. Given any other value, Then reading it throws (fail closed: the page errors rather than guessing).
- **AC-2** `TENANCY_MODE` is read only in `src/lib/tenancy.ts` (ESLint fence, like `SUPABASE_SECRET_KEY`); a unit test fails if the mode is read anywhere else (lint rule + a grep test listing the allowed callers).

### Login page
- **AC-3** Given `multi`, When anyone opens `/login`, Then the brand line reads "CA Document Vault" with no branch, and the page makes **no** database call (no `office` read, no service-role client imported).
- **AC-4** Given `single`, When anyone opens `/login`, Then the brand line shows the name and branch of the deployment's one **non-test** office (today's query also picks test offices; this fixes it). If none exists yet, "CA Document Vault".
- **AC-5** Everything else on `/login` is unchanged (form, messages, CSP, redirects; 01's and 06's tests unedited).

### Per-firm sender
- **AC-6** Given a staff member of firm A sends a reminder (06) or an upload-link email (10), Then the email's From is `"<firm A's name>" <MAIL_FROM_EMAIL>` and Reply-To is the staff member (unchanged). A staff member of firm B sending the same gets firm B's name.
- **AC-7** The firm name in From is the name at send time (an edit on Settings › Office applies to the next email); characters that would break a header (CR, LF, `"`, `<`, `>`) are removed, and it is cut to 70 characters.
- **AC-8** The mail safety rules are unchanged (test transport default, `.test` never sent, allow-list outside production, two-phase send, caps).

### Settings › Office (Admin only)
- **AC-9** Given an Admin, When they open Settings, Then an **Office** item is listed (after Users and roles) with the firm's name (required, 1–120) and branch (optional, 1–120). Save updates the header at once and writes one activity row `office.updated` with the changed field names only.
- **AC-10** Given a Manager, Staff or Limited user, Then Settings shows no Office item, `/settings/office` returns 404, and a direct update of `office` through the API is refused by the database (RLS + column grant). New permissions-matrix row **"Edit the firm's name and branch"** (Admin yes, others no) with a probe per role.
- **AC-11** No user can change any other `office` column (is_test, counters, test clock, FY start) or any other firm's row.

### Invites
- **AC-12** Given an Admin invites an email that already belongs to a staff record **in any firm**, Then the message is "This email can't be invited. Use a different address." (no "already has an account", no firm name). The invite still fails (one email = one firm). *Accepted residue:* the failure itself tells the inviting Admin that the address is in use somewhere; it never says where.
- **AC-13** The invite email carries the firm's name to Supabase's template as `data.firm` (so the template can read "You've been invited to {{ .Data.firm }} on CA Document Vault"). Changing the hosted template is a staging/prod checklist step, not code.

### Bootstrap a firm
- **AC-14** Given the operator runs `node scripts/bootstrap-firm.mjs --name "<firm>" [--branch "<b>"] --admin-email <e> --admin-name "<n>"` with an environment's service-role key, Then in one run: the office exists (not test), its catalogue and financial years are seeded (02's `seed_catalogue`), its six preferred formats are set (11's real-office seed), the first Admin is invited by email, and activity rows `office.bootstrapped` (system) and `staff.invited` are written. Output: office ID and "invite sent" — no names or emails in logs beyond what the operator typed.
- **AC-15** Re-running with the same firm name while that office has **no staff** reuses it (no duplicate office; a failed invite can be retried). Once it has staff, the script refuses ("firm already set up").
- **AC-16** In `single` mode, if the database already holds exactly one real office with no staff (the 2026-09-25 seed row), the bootstrap **claims** it: renames it to the given name/branch instead of inserting. In `multi` mode it never renames another office.
- **AC-17** The bootstrap records the mode it ran with in `private.deployment` on first run; a later run with a different `TENANCY_MODE` is refused ("deployment is single/multi").
- **AC-18** `bootstrap_office` is executable by the service role only (not anon, not authenticated), like `reset_test_office`.

### Single-office guard
- **AC-19** Given `private.deployment.mode = 'single'` and one real office exists, When anything (SQL, API, function) inserts another non-test office or flips a test office to non-test, Then the database refuses (`SINGLE_OFFICE`). Test offices (`is_test`) can still be created (tests run in any mode).
- **AC-20** Given no deployment row or mode `multi`, Then office inserts behave as today.

### No cross-firm leak at the edges (intent metric 1)
- **AC-21** With two test firms A and B on the same database: B's login page (multi) never shows A's name; B's invite of an A-staff email shows AC-12's message; B's reminder From name is B's; B's upload page shows B's name (10, unchanged); B's Admin can't read or update A's `office` row.
- **AC-22** Every existing test passes unedited in `multi` (unset).

## Functional requirements
- `src/lib/tenancy.ts` (server-only): `tenancyMode(): "multi" | "single"`; the only reader of `process.env.TENANCY_MODE`. Allowed callers (S6 list, enforced by test): login page, bootstrap script (reads env itself, outside `src/`). Later features (signup, billing, admin console) add themselves to the list.
- `CurrentStaff` keeps `officeName` (already there); the two mail callers pass `fromName: me.officeName` to `sendMail`; `deliver` builds From as `{ email: cfg.from.email, name: sanitise(fromName) ?? cfg.from.name }`.
- `inviteStaff`: message change (AC-12) and `data: { firm: me.officeName }` on `inviteUserByEmail` (AC-13). The `.test` path (no email) is unchanged.
- Settings › Office: server component + server action as the signed-in Admin (RLS), zod validation (trimmed, 1–120), `revalidatePath("/", "layout")` so the header updates, `logActivity` with `{ fields: [...] }`.
- Bootstrap script (Node, outside `src/`, reads `.env` of the target the operator chooses): refuses `--admin-email` ending `.test` unless `--test` is given; refuses a production project unless `--yes-production` is passed (it prints the project ref first).

## Non-functional requirements
- **Security:** the login page in multi mode no longer uses the service-role client (one fewer public service-role path). `bootstrap_office` service-role only, `search_path = ''`, tenant-first. RLS on `office` gains an Admin-only update policy limited by a column grant (`name`, `branch`).
- **Privacy:** activity rows carry IDs and field names only (the `ACTIVITY_PII` guard applies). The script never logs the admin email after the invite line the operator typed.
- **Accessibility:** the Office form follows the existing settings forms (labels, errors announced, ≤ 390 px).
- **Performance:** no new per-request query (the header already reads the office name with the staff row).

## Data model changes (needs the schema lock)
One migration `2026110x_multi_tenant.sql`:
1. `private.deployment` (single row: `id boolean primary key default true check (id)`, `mode text not null check (mode in ('multi','single'))`, `set_at timestamptz`). No grants to app roles.
2. Trigger `office_single_guard` (BEFORE INSERT OR UPDATE OF is_test on `office`, definer, `search_path = ''`): when the row is non-test and the mode is `single` and another non-test office exists → `SINGLE_OFFICE`.
3. Column grant `update (name, branch) on public.office to authenticated` + policy `office_update_admin` (`id = private.current_office_id()` and `private.has_role('{admin}')`), with check the same.
4. `public.bootstrap_office(p jsonb)` → `{office_id, created|reused|claimed}` (service role only): validates name/branch; sets or checks `private.deployment`; reuse/claim rules AC-15/16; `private.seed_catalogue` + `private.seed_preferred_formats(office, true)`; activity `office.bootstrapped` (actor null).
5. `public.test_single_office_guard()` (service role only, **refuses to run when a real deployment row exists**): runs AC-19's scenario inside an exception block (rolled back) and returns the error code — so the guard is tested without changing dev's shared state.
- Nothing else changes: no RLS policy on any business table, no business function.

## Existing code affected
| Area | Files | Change | Coverage today |
|---|---|---|---|
| Login page | `src/app/(auth)/login/page.tsx` | mode branch; no DB read in multi | e2e smoke + auth (heading only) |
| Mailer | `src/lib/mail/core.ts`, `index.ts` | `fromName` option, sanitise | unit (core) |
| Mail callers | `src/lib/reminders/actions.ts`, `src/lib/upload-links/actions.ts` | pass `fromName` | RLS + e2e (06, 10) |
| Invite | `src/lib/staff/actions.ts` | message + `data.firm` | e2e users |
| Settings | `settings/layout.tsx`, new `settings/office/*` | new item/page | e2e settings |
| Permissions | `src/lib/auth/permissions.ts`, `tests/rls/role-matrix.test.ts` | one row + probe | role-matrix |
| Lint | `eslint.config.mjs` | `TENANCY_MODE` fence | — |
| Scripts | new `scripts/bootstrap-firm.mjs` | operator tool | new tests |
| Docs | `architecture.md` (lock), `sdlc/releases/README.md` (staging steps) | | |

## Backward compatibility & data migration
- **Kushal Associates on dev:** unchanged (no `private.deployment` row → guard off, multi behaviour). Dev's `/login` changes from "Kushal Associates" to "CA Document Vault".
- **Staging/prod (to be created):** migrations replay creates the 2026-09-25 "Kushal Associates" seed row (no staff). The operator runs the bootstrap with `--name "Kushal Associates"` in `multi` → AC-15 reuses the seeded row, seeds formats, invites Kushal's Admin. Replaces today's manual "link the first Admin" step.
- **Env vars:** `TENANCY_MODE=multi` set explicitly on staging/prod (checklist), although unset means multi.
- No existing data is rewritten.

## API / interfaces
- `tenancyMode()` (TS) · `sendMail(message, cfg?)` with `message.fromName?: string` · server action `saveOffice(form)` → `{ok, message} | {ok:false, error, fieldErrors}` · SQL `public.bootstrap_office(p jsonb)` · SQL `public.test_single_office_guard()` (test only).
- Script CLI as in AC-14; exit code ≠ 0 on any refusal.

## UX flows & screens
- **Login (multi):** existing layout; brand mark + "CA Document Vault". No branch line.
- **Settings › Office:** two fields (Firm name, Branch), Save, success line "Saved." (`role="status"`), field errors inline; loading/error states from `src/components/states.tsx`. Help line: "Your firm's name appears on the vault header, on emails to clients (as the sender) and on client upload pages."
- **Users › Invite:** only the error text changes.
- No mockup screen exists for Office; it follows Settings › Users' form style (ui-reference deviation row added).

## Test strategy
| AC | Test | Suite | Prod-smoke safe |
|---|---|---|---|
| 1, 2 | `tests/unit/tenancy.test.ts` (modes, invalid, allowed callers) + ESLint fence | unit | — |
| 3, 4 | `tests/unit/login-page.test.tsx` (render per mode; multi: no DB client constructed) | unit | — |
| 5 | existing `smoke.spec.ts`, `auth.spec.ts` unedited | e2e | smoke yes |
| 6, 7, 8 | `tests/unit/mail-core.test.ts` additions (From name, sanitising, fallback); existing 06/10 tests unedited | unit | — |
| 9 | `tests/e2e/office-settings.spec.ts` (Admin edits, header updates, activity row) | e2e | no |
| 10, 11 | `tests/rls/office.test.ts` (update by role, other columns, other firm) + role-matrix probe | RLS | — |
| 12, 13 | `tests/e2e/users.spec` addition (message) + unit for `data.firm` | e2e/unit | — |
| 14–18 | `tests/rls/bootstrap.test.ts` (function: create, reuse, claim only in single via test probe, mode mismatch, grants) + `tests/unit/bootstrap-script.test.ts` (argument checks, `.test` / production refusals, with a mocked client) | RLS/unit | — |
| 19, 20 | `tests/rls/office.test.ts` via `test_single_office_guard()` | RLS | — |
| 21 | `tests/rls/office.test.ts` (two firms) + `tests/e2e/tenancy-edges.spec.ts` (login text; invite message) | RLS/e2e | — |
| 22 | full suite in CI | all | — |
- New RLS tests run on CI's local stack (migration replays from scratch) and on dev before review (CLAUDE.md rule: apply to dev, md5 = file, Regression `only`).
- No RUN_SLOW needed (no 02/03 write path).

## Proposed architecture changes (needs the architecture lock)
1. Decision log: **reverse 2026-09-25 "Single office, single tenant"** → multi-firm by `office_id` + RLS (already in place); deployment models SaaS / Dedicated / Customer-owned from one codebase; `TENANCY_MODE` switches the shell only.
2. Decision log: **one email = one firm** (no membership table); operator access to a firm's data only through logged server-side tools, never a staff account in a customer's office.
3. Core entities › Operational: `office` is "one row per firm" (not "one row"); `private.deployment`.
4. Stack › Mailer: From = platform address with the firm's name; `MAIL_FROM_NAME` fallback only.
5. Auth: bootstrap replaces manual first-Admin linking; invite template carries `data.firm`.
6. Environments: staging/prod run `multi`; checklist items (below).

## R1 staging/prod checklist additions
- `TENANCY_MODE=multi` on staging and prod Vercel (server-only).
- Run the bootstrap for Kushal Associates on staging, then prod; record office ID and invite time; Kushal's Admin signs in.
- Supabase Auth → Email templates → Invite: use `{{ .Data.firm }}`; send one test invite per environment.
- `MAIL_FROM_EMAIL` = the platform address (verified domain on the provider: Brevo now, SES after the switch); `MAIL_FROM_NAME` = "CA Document Vault".

## Risks & areas of concern
- **Deployment row vs env drift:** `TENANCY_MODE` lives in Vercel, the guard's mode in the database. Mitigated by AC-17 (bootstrap refuses a mismatch); a manual env change without a bootstrap is not detected. [Uncertain] whether a startup check is worth adding; proposed: no (single-mode deployments don't exist yet; the deployment kit adds a health check).
- **Claiming the seeded office (AC-16)** renames a row in single mode only; in multi a wrong name creates a second office rather than renaming Kushal. Mitigation: the script prints what it will do and needs `--yes` before writing.
- **Invite failure reveals that an email is in use** (AC-12 residue) — inherent in one-email-one-firm; accepted.
- **Hosted Auth templates are dashboard config,** not code: missed template step = invite email without the firm name (cosmetic). Checklist covers it.
- Login text change on dev/preview may surprise Kushal reviewers ("where is our name?") — the name appears after sign-in; mention in the PR.

## Out of scope
Everything in intent › Out of scope (self-signup, billing, plan limits, super-admin console, offboarding, cross-tenant RLS sweep of every table, deployment kit, seed-migration replacement, per-firm DSC keys, subdomains), plus: a separate sender name or address per firm, per-firm email ceiling column, a startup check of mode drift.
