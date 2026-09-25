# Spec: Walking skeleton — secure staff sign-in, deployed end-to-end in India
Intent: ./intent.md · Status: approved · Screens: references/mockup/01-today.jpg (header), 06-settings-users.jpg, 03-clients.jpg (empty state)

## User stories & acceptance criteria
**Sign-in**
- AC-1 Given the seeded Admin (rajak@pulsebay.in), when they enter their email on `/login`, then a **sign-in link** is emailed; opening it in the same browser signs them in (via `/auth/callback`) and lands on `/clients`. If the email also shows a 6-digit code (custom SMTP template, before pilot), entering the code works too. *(Changed 2026-09-25: Supabase default email cannot show codes without custom SMTP.)*
- AC-2 Given an email with **no** staff record, when entered on `/login`, then the page shows the same neutral message as AC-1 ("If this email has access, we've sent a code") and **no auth user is created** (`shouldCreateUser: false`).
- AC-3 Given a wrong or expired code, then an inline error is shown; after 5 failed attempts the email is locked for 15 minutes. Given an expired/used link or one opened in another browser, `/auth/callback` shows a clear message and a way back to sign in.
- AC-4 Given a signed-in user, when they choose *Sign out* from the avatar menu, then the session ends and `/login` is shown; back-button does not reveal app pages.

**Staff management (Settings › Users and roles, Admin only)**
- AC-5 Given the Admin, when they invite a person (name, email, role ∈ Admin/Manager/Staff/Staff (limited)), then a `staff_user` row is created with status *Invited*, an invite email is sent, and the person appears in the list.
- AC-6 Given an invited person, when they sign in with a code for the first time, then their status becomes *Active*.
- AC-7 Given the Admin, when they change someone's role, then it takes effect on that user's next request.
- AC-8 Given the Admin, when they deactivate a user, then that user's very next request is rejected (redirect to `/login` with "Your access has been removed. Contact your administrator.") and database reads return nothing for them — even with an unexpired token.
- AC-9 The last active Admin cannot deactivate or demote themselves (button disabled + server rejects).
- AC-10 Non-Admins do not see *Settings › Users and roles*; direct URL returns 404; server actions reject; RLS denies writes.
- AC-11 Every invite, role change, deactivation, reactivation and sign-in writes an `activity` row (actor, action, target, time). Activity rows cannot be updated or deleted by anyone.

**App shell**
- AC-12 Signed-in pages show the mockup header: brand (icon + "Kushal Associates", branch "Pondicherry" as secondary text), nav, avatar with initials. In this feature nav shows **Clients** and **Settings** only (others appear when their features ship). Search box and *Add document* are hidden until feature 03.
- AC-13 `/clients` shows the mockup page header ("Clients", "0 clients") and an empty state: "No clients yet — clients are added in the next release."
- AC-14 Unauthenticated access to any app route redirects to `/login`.

**Delivery**
- AC-15 Every PR runs lint, typecheck, unit/integration tests, e2e tests and build in GitHub Actions; `main` requires a passing run + 1 review.
- AC-16 `main` auto-deploys to the dev URL (`*.vercel.app`) with functions in bom1; PRs get preview deploys using the **dev** Supabase project.
- AC-17 A fresh environment (staging/prod later) is created by: create Supabase project → `supabase db push` → run seed script with the first Admin email. Documented in README; < 30 min.

## Functional requirements
- Auth: Supabase Auth email OTP — link (PKCE, `/auth/callback`) with default templates now; code entry once custom SMTP templates show `{{ .Token }}`. Session in HTTP-only cookies via `@supabase/ssr`. Sign-ups disabled at project level.
- Invite: server action checks caller is active Admin → creates `staff_user` → `auth.admin.inviteUserByEmail`. **Only place the service-role key is used**, in a server-only module (`import 'server-only'`).
- Deactivate: set `status = deactivated` → revoke sessions (`auth.admin.signOut` / ban) → RLS helper rejects immediately regardless.
- Middleware refreshes session and loads `staff_user`; missing or deactivated → sign out + redirect.

## Non-functional requirements
- **Security:** RLS on every table, default deny; security headers (CSP, HSTS, X-Frame-Options DENY, Referrer-Policy strict-origin); no PII in URLs or logs; OTP rate limits (Supabase defaults + AC-3 lockout).
- **Residency:** Supabase ap-south-1; Vercel functions `bom1` (`vercel.json` `regions`).
- **Accessibility:** WCAG 2.1 AA — keyboard-navigable login and menus, labelled inputs, focus visible. Mockup muted text `--ink-3` (#8A909D) is ~3.3:1 on white → **darkened to meet 4.5:1** for text under 18px.
- **Performance:** login and Clients pages LCP < 2.5 s on 4G from India.
- **Session:** access token 1 h with refresh; forced re-sign-in after 7 days inactivity.

## Data model changes (schema lock: 01)
- `office` (id, name, branch, fy_start_month=4, created_at) — one row, seeded: **Kushal Associates · Pondicherry**.
- `staff_user` (id = auth.users.id, office_id, full_name, email unique, role enum admin|manager|staff|limited, status enum invited|active|deactivated, invited_by, created_at, activated_at, deactivated_at)
- `activity` (id, office_id, actor_id, action, entity_type, entity_id, data jsonb, created_at) — insert-only.
- Helpers (security definer, `search_path` pinned): `current_staff()`, `is_active_staff()`, `has_role(role[])`.
- RLS: `office`, `staff_user` readable by active staff of the same office; `staff_user` writes Admin only; `activity` insert via server functions, select by active staff, **no update/delete policy**.
- **office_id on every business table from day one** (single office in v1; avoids a painful migration if multi-office ever comes).

## API / interfaces
- Routes: `/login`, `/auth/confirm`, `/clients`, `/settings/users`.
- Server actions: `requestCode(email)`, `verifyCode(email, code)`, `inviteStaff`, `changeRole`, `deactivateStaff`, `reactivateStaff`, `signOut`.

## UX flows & screens
- `/login`: office name + "Sign in" → email → "Send code" → 6-box code input → "Verify". States: sending, sent (resend after 60 s), wrong code, expired, locked, deactivated message.
- `/settings/users`: mockup 06 layout (Person, Email, Role select, status chip, ⋯ menu: Deactivate/Reactivate) + "+ Invite a person" dialog. Permission-matrix panel is read-only text in 01 (full screen = feature 08).
- Empty, loading (skeleton rows) and error (inline banner with retry) states on every screen.

## Test strategy
| AC | Test |
|---|---|
| 1, 4, 6, 12–14 | Playwright e2e against the **hosted dev** Supabase; sign-in codes generated via admin API (`generateLink`, no email sent) |
| 2, 3 | e2e + integration (no auth user created; lockout) |
| 5, 7, 9–11 | Integration (server actions) + e2e for invite happy path |
| 8, 10, 11 | **RLS tests** (Vitest + supabase-js signed in as each role, against dev): deactivated user reads 0 rows; non-admin cannot write; activity cannot be updated/deleted |
| 15–17 | CI run on the PR itself; README procedure dry-run on a scratch project (then deleted) |
Unit: role helpers, input validation (zod), initials/avatar formatting.

## Proposed architecture changes
- Add `office_id` to all business tables (see Data model) — needs approval (this feature holds the architecture lock).
- Supabase built-in email for OTP/invites in dev (SES only for client reminders in 06).

## Risks & areas of concern
- **Supabase default email has low hourly send limits** [Likely] — fine for dev testing; must switch Auth email to custom SMTP (SES) before pilot. Tracked for the prod-setup step.
- **Tests run against the hosted dev project** (no local Supabase/Docker): test records are tagged `e2e-<run id>` and removed after each run; CI runs are serialised (concurrency group) to avoid collisions; the dev service-role key is a GitHub secret (dev only — never prod).
- **Dev database pauses after ~7 days idle on free plan** → CI fails fast with a clear "dev project paused" message; resume via dashboard/MCP.
- Service-role key leakage → server-only module + lint rule + reviewer check.

## Out of scope
Clients data, documents, catalogue, search, Today/Inbox/Activity screens, SES, custom domain, full permission-matrix UI (08), staging/prod creation.

## Decisions (resolved open questions)
- 2026-09-25 (approved): sign-in by **email link** while on Supabase default email (templates need custom SMTP); code entry kept for later. Links must be opened in the same browser; lockout applies to codes only (links rely on Supabase's per-email rate limit).
- Office: **Kushal Associates**, branch **Pondicherry** (seeded; editable in Settings › Office in a later feature).
- Nav shows only shipped screens (Clients, Settings in 01); no "coming soon" pages.
- Muted text darkened to meet WCAG AA (approved deviation from mockup).
- `office_id` on every business table (approved architecture change).
- Supabase built-in email for OTP/invites in dev; custom SMTP (SES) required before pilot (tracked for prod setup).
- No local Supabase/Docker: all tests run against hosted dev; **staging is mandatory before prod** (only place migrations are rehearsed before real data).
