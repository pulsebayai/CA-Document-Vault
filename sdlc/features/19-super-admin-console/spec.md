# Spec: Super admin console
Intent: ./intent.md (approved 2026-11-04) · Status: **draft — awaiting approval** · Date: 2026-11-04

## Summary of design decisions (proposed; marked Y-n for the gate)
- **Y1 — `platform_admin` is its own table, outside every firm.**
  - Columns: `id` = the auth user, `email`, `full_name`, `status` (active / deactivated), `created_at`.
  - RLS on: a super admin reads only their own row; no app writes.
  - Rows are added only by a new operator script, `scripts/add-platform-admin.mjs` (service role, dry run unless `--yes`, `--yes-production` on prod), as 17's bootstrap script does.
  - **An email is either staff in one firm or a super admin.** A database trigger on both tables refuses a clash. The staff invite keeps 17's neutral message.
  - `private.current_office_id()` is null for a super admin, so every firm RLS policy refuses them, exactly as 18 proved for non-staff.
- **Y2 — Second factor (intent Q1).**
  - Super admins enrol an authenticator app (Supabase Auth TOTP) at first sign-in, then enter its code after the email code at every sign-in.
  - Each platform check requires the session's assurance level `aal = aal2` (the `aal` claim in the JWT, set by Supabase Auth after a verified second factor).
  - With `aal1`, the Platform area shows only the "enter your code" or enrolment page.
  - Staff sign-in is unchanged: no second factor for staff in R1.
- **Y3 — Every platform action is a SECURITY DEFINER function in `public`, checked in the database.**
  - Each `platform_*` function starts with `private.require_platform_admin()`, which checks: active row, `aal2`, `search_path = ''`.
  - It then works on the firm it is given **explicitly**, filtering every query on that `office_id`, and writes its audit row **in the same transaction before returning** (14's "log before return").
  - These functions are executable by `authenticated`, but refuse everyone who isn't an active `aal2` super admin. They return IDs, counts and display fields, and never storage paths, `password_ct` or token hashes.
  - **Why not a service-role server module:** the checks and the log would then live in TypeScript, and a coding slip would bypass both. In the database they hold for every caller, and 18's sweep can probe them like any other function.
  - **The one exception is the email invite**, which needs Supabase's admin API (service role). It sits in one allow-listed server module, `src/lib/platform/invite.ts`. That module first calls `platform_whoami()` as the signed-in user and stops unless it confirms an `aal2` super admin.
- **Y4 — Support access window (intent Q2).**
  - `platform_open_access(office, reason)` creates a `platform_access` row (`admin_id`, `office_id`, `reason` 10–500 characters, `opened_at`, `expires_at` = +60 minutes, `closed_at`).
  - Every read function requires an open, unexpired row for (this super admin, this firm). "Close access" ends it early.
  - Opening writes:
    - a platform audit row;
    - a firm activity row `platform.access_opened` (actor null, data = access ID only, so the reason never reaches activity);
    - one bell notification to each active Admin of the firm (new notification kind `platform_access`, IDs only).
  - Each page read writes:
    - a platform audit row;
    - a firm activity row `platform.viewed` (data = access ID, view name, entity ID).
- **Y5 — Read views (intent §5).** Each is one definer function returning only what the screen needs:

  | View | Function | Shows |
  |---|---|---|
  | Clients | `platform_clients(office, query, page)` | code, name, type, incharge name, groups, archived; 20 per page |
  | Client | `platform_client(office, client)` | details, registrations (masked), plan groups, counts |
  | Documents | `platform_documents(office, client?, page)` | DOC-ID, type, period, received as/on, shown state, current file name and size; 20 per page |
  | Document | `platform_document(office, document)` | metadata, version list (file name, size, uploader, date), review history |
  | Expected | `platform_expected(office, client, page)` | items with derived state |
  | Activity | `platform_activity(office, page)` | 08's sentences from IDs; sign-ins excluded |

  - **Excluded everywhere (decided):** file view or download (no signed URLs, no storage paths), DSC records and passwords, upload-link tokens, follow-up recipient snapshots.
  - **Masking (Y5a, for the gate):** PAN, GSTIN, mobile and email are shown masked (`ABCxxxx12F`, `a…@…`, `98xxxxxx01`), as 06 does for recipients. Support rarely needs them in full, and masking narrows what a stolen super admin session could take.
- **Y6 — Suspend / reactivate (intent §4, Q4).**
  - New `office` columns: `suspended_at`, `suspended_by` (→ `platform_admin`), `suspend_reason`. Written only by `platform_suspend_firm(office, reason)` / `platform_reactivate_firm(office)`.
  - `private.current_office_id()` returns null when the staff member's office is suspended. Every RLS policy then refuses at once, with no change to the 61 policies.
  - Sign-in and the app shell show **"This firm's access is paused. Contact your firm's administrator."**:
    - `finishSignIn` signs out and redirects to `/auth/paused`;
    - `requireStaff` redirects to `/auth/paused`.
  - **10's links:** `link_request` treats a suspended office as unusable and returns the single `NOT_ACTIVE`.
  - **04's nightly job:** `run_daily_expected` skips suspended offices. On reactivation the next run catches up, as for any missed day.
  - **Recorded:** firm activity rows `office.suspended` / `office.reactivated` (actor null), plus platform audit rows.
  - Not allowed: suspending a test office from the UI, or suspending in single mode (the deployment's only firm).
- **Y7 — Firms list and create (intent §2–3, Q5).**
  - **`platform_firms()`** returns, per real (non-test) firm:
    - name, branch, status, created date;
    - staff active / invited;
    - clients (live);
    - documents (live);
    - files stored (MB, from `storage.objects` under `office/<id>/`);
    - last activity date.
  - **`platform_create_firm(p)`:**
    - runs 17's bootstrap path (the same internal steps as `bootstrap_office`: catalogue, years, preferred formats), then records the first Admin as invited;
    - the server module then sends the invite email (Y3's exception);
    - "Resend invite" is offered while that Admin is still invited;
    - refused in single mode, as 17's guard already does.
- **Y8 — Routing.**
  - New route group `src/app/(platform)/platform/…` with its own layout: no firm header or firm nav.
  - After sign-in, a super admin lands on `/platform`, and staff land on `/today` as now.
  - A super admin opening a staff page is sent to `/platform`; a staff member opening `/platform` gets Not Found.
  - The proxy/middleware is unchanged; the checks live in the layouts and the database.
- **Y9 — 18's guard covers 19.**
  - Every new table and function gets a line in `coverage.ts` and a case.
  - The sweep gains a "platform" section, which checks that every `platform_*` function refuses:
    - Firm A's staff (Admin included);
    - an `aal1` super admin;
    - an `aal2` super admin without an open access window (for reads).
  - A "no path to writes, files or DSC" check lists every function a super admin can execute and asserts it's a `platform_*` function, or one that RLS already refuses for them.

## User stories & acceptance criteria
### Identity and sign-in
- **AC-1** The operator adds a super admin with the script, which shows a dry run first. An email that is already staff anywhere is refused, and so is a staff invite for a super admin's email (neutral message, 17).
- **AC-2** On first sign-in, a super admin is asked to enrol an authenticator app (QR code and secret), then enter a code. On later sign-ins they enter a code after the email code. Without `aal2` they see only those pages.
- **AC-3** A super admin lands on `/platform` and never sees a firm's header or screens. Opening `/today` or `/clients` sends them to `/platform`. A staff member opening `/platform` gets Not Found.
- **AC-4** Every `platform_*` function refuses:
  - anyone without an active `platform_admin` row;
  - an active super admin at `aal1`.
  
  It refuses with no data and no audit row (refusals are counted by Supabase's own logs only).

### Firms
- **AC-5** The firms list shows every real firm with the Y7 fields, sorted by name. Test firms are hidden. No client names or PII appear.
- **AC-6** **Create a firm:**
  - the super admin enters name, branch (optional), and the first Admin's name and email;
  - the result is the firm seeded as by 17, the Admin invited by email, and audit rows `firm.created` and `staff.invited`;
  - the same email rules as 17 apply.
  
  An Admin who hasn't signed in yet can be re-invited ("Resend invite").
- **AC-7** **Suspend:**
  - needs a reason (10–500 characters);
  - the firm's signed-in staff are refused on their next request and see the paused message;
  - sign-in shows the same message;
  - its upload links answer `NOT_ACTIVE`;
  - the nightly job skips it.
  
  **Reactivate:** everything works as before, with no data changed. Both are audited, and recorded in the firm's activity.

### Read-only support access
- **AC-8** Opening access needs a reason (10–500 characters).
  - The window lasts 60 minutes (shown as a countdown) and can be closed early.
  - The firm's activity shows "Pulsebay support opened read-only access".
  - Each active firm Admin gets one bell notification.
  - The reason is stored on the access row only.
- **AC-9** Within an open window, the six Y5 views work for that firm only, read-only.
  - PAN, GSTIN, mobile and email are masked.
  - There is no file view or download, and nothing from DSC, upload-link tokens or follow-up recipients.
  - Each page read writes a platform audit row and a firm activity row `platform.viewed`.
- **AC-10** Read views are refused:
  - outside an open window (expired, closed, never opened);
  - for another firm than the window's;
  - with IDs that belong to another firm (a client of firm B while the window is for firm A).
- **AC-11** No platform function, view or server action can write firm data, sign a file URL, or return `password_ct`, token hashes, storage paths or full PII (18-style sweep, Y9).

### Audit
- **AC-12** **Platform › Audit** lists every super admin action, newest first, filterable by firm and action: who, when, what, reason where given. It is append-only: nobody updates or deletes it, the service role included (like 02's activity guard).
- **AC-13** In the firm's own Activity, support access, page views, suspension and reactivation appear as sentences, e.g. "Pulsebay support viewed client C0004". 08's catalogue coverage test covers them.

### Guard and regression
- **AC-14** 18's coverage guard and sweep include every new table and function. The extended sweep shows no path from a super admin to writes, files or DSC passwords.
- **AC-15** Every existing test passes unedited, except where 17's operator flow is extended (none planned). The suspended check in `current_office_id()` adds ≤ 5 % to 02's `clients-list` timing [Uncertain, measured].

## Data model changes (needs the schema lock)
1. `platform_admin` (Y1), with a trigger-pair email uniqueness check against `staff_user`.
2. `platform_access` (Y4).
3. `platform_audit` (id, admin_id, action, office_id null, access_id null, detail jsonb (IDs only, `ACTIVITY_PII`-style check), at): append-only guard.
4. `office`: `suspended_at`, `suspended_by`, `suspend_reason` (no grant to staff; written only by the platform functions).
5. `notification_kind` gets `platform_access`; activity actions `platform.access_opened`, `platform.viewed`, `office.suspended`, `office.reactivated`, `firm.created`.
6. Functions:
   - `private.require_platform_admin()`, `private.platform_access_ok(office)`;
   - `public.platform_whoami()`, `platform_firms()`, `platform_create_firm(p)`, `platform_resend_invite_check(office)`, `platform_suspend_firm`, `platform_reactivate_firm`, `platform_open_access`, `platform_close_access`;
   - the six read views, and `platform_audit_list(p)`.
7. **Changed existing objects:**
   - `private.current_office_id()` (suspended → null);
   - `private.link_request` (suspended → `NOT_ACTIVE`);
   - `private.run_daily_expected` (skip suspended);
   - the `bootstrap_office` internals factored into a private helper used by both the script path and `platform_create_firm`, with no behaviour change.

## Existing code affected
- `src/lib/auth/finish.ts` (super admin and paused routing), `src/lib/auth/staff.ts` (paused and super admin redirects), `src/app/auth/paused` (new).
- New: `src/app/(platform)/…`, `src/lib/platform/*`, `scripts/add-platform-admin.mjs`.
- ESLint service-role allow-list gains `src/lib/platform/invite.ts`.
- `src/lib/activity-feed/catalogue.ts` gets sentences for the new actions.
- `tests/rls/cross-firm/coverage.ts` + sweep: the platform section.

## Test strategy
- **RLS / integration:**
  - Super admin fixture: a `.test` email added with the script's core. Its TOTP is enrolled in the test using the factor secret, with codes computed by a small TOTP helper (RFC 6238, Node `crypto`, no new dependency) to reach `aal2`.
  - Every `platform_*` function × {Firm A Admin, `aal1` super admin, `aal2` super admin without a window, with a window for another firm, with a window for this firm}.
  - Suspension effects (staff refused, links `NOT_ACTIVE`, nightly skip, reactivation).
  - Masking and audit rows.
- **Unit:** masking helpers, routing decisions, invite module (mocked admin client), catalogue sentences.
- **e2e:**
  - enrol → code → firms list → create a test firm → open access → view a client → see the firm-side activity line and bell → close;
  - suspend → the firm's staff see the paused page → reactivate.
- **18's sweep extended (AC-14).**

## Proposed architecture changes (architecture lock)
1. **Platform identity:** super admins are a separate table outside every firm, with TOTP required. They are never staff, and an email belongs to one side only.
2. **Platform actions are definer functions** that check the caller (active super admin at `aal2`) and log before returning. The only service-role step is the invite email, in one allow-listed module. This refines 17's "operator access only through logged server-side tools".
3. **Support access** is reason + 60-minute window + firm-visible log + bell, read-only and masked, with no files and no DSC.
4. **Suspension lives in `current_office_id()`**, so every RLS policy honours it with no policy changes. 10's links and 04's nightly job also honour it.
5. A decision-log row, plus an R1 checklist item: super admins on staging/prod are added with the script, and TOTP is enrolled before first use.

## Risks & areas of concern
- **[Likely] Changing `private.current_office_id()` touches every RLS query.** It's a one-row join to `office`, cached per statement (`select private.current_office_id()`). It's measured with 02's `clients-list` and 15's K4 timings before merge, and RUN_SLOW runs because every write path is affected.
- **TOTP in automated tests:** codes are time-based. The helper computes the current code from the enrolled secret; [Uncertain] it may need a small retry at a 30-second boundary.
- **Masking vs support needs:** if support needs a full value, there is no unmask in R1. Revisit after the pilot.
- **Bootstrap refactor:** moving `bootstrap_office`'s body into a helper must keep 17's tests unedited and green.

## Out of scope
As in the intent. Also: staff TOTP, an unmask action, super admin roles (all super admins are equal in R1), and email notifications to firm Admins about support access (the bell only).

## Open questions for the gate
1. **Y3:** definer functions in the database, with one service-role step for the invite email (recommended), vs a service-role server module for everything.
2. **Y5a:** mask PAN, GSTIN, mobile and email in support views (recommended), or show them in full.
3. **Y6:** suspension via `current_office_id()` (recommended: one place, every policy). The cost is a re-timed RLS suite plus RUN_SLOW.
