# Releases & regression evidence
One record per release (`R1.md`, `R2.md` …) + an `Rn/evidence/` folder. Policy: `sdlc/product/architecture.md` → *Release & regression policy*.

## Before the first regression run against a deployed URL (once)
Vercel Deployment Protection sends unauthenticated browsers to `vercel.com/login`, so e2e can't sign in (run 36439895456).
In Vercel › project › Settings › Deployment Protection, create **Protection Bypass for Automation**; save the value as the
GitHub Actions secret `VERCEL_AUTOMATION_BYPASS_SECRET`. `tests/e2e/preview-access.ts` sends it once per browser context,
to the tested URL's own origin only, and uses the cookie Vercel returns. Not used for `target = prod` (smoke only).

## Quick checks
Regression → *Run workflow* has an `only` box (space-separated words matched against test file paths). Use it to prove a fix
on a deployed preview in minutes. A filtered run's summary says **"Quick check — partial run; not release evidence"**
and must never be copied into `Rn/evidence/`; release records need a full run (`only` empty).

## How a release record is produced
1. Confirm `main` CI is green (note the run URL and SHA).
2. Deploy `main` to **staging**; run GitHub Actions → **Regression** → *Run workflow* with `target = staging` (URL of staging).
3. Download the run's `regression-evidence` artifact; copy `summary.md`, `junit-*.xml` and `e2e-results.json` into `Rn/evidence/`.
4. Do the manual checklist on staging; fill in `Rn.md` (template below); owner signs off in chat.
5. Promote to prod; run **Regression** with `target = prod` (**smoke only**); attach its summary.

## Template
```markdown
# Release Rn — <name>
Date: · Commit: <sha> · Features: 0x, 0y · Approved by: <name, date>

## Automated regression
| Suite | Env | Run | Passed | Failed | Skipped |
|---|---|---|---|---|---|
| Unit | CI | <url> | | | |
| RLS (DB security) | staging | <url> | | | |
| E2E | staging | <url> | | | |
| Smoke | prod | <url> | | | |

## Acceptance criteria covered (new in this release)
| Feature | AC | Test | Result |

## Manual checklist (staging)
- [ ] Sign in with code; sign out · [ ] Key screens match mockup (list) · [ ] One real end-to-end path: <describe> · [ ] No console/CSP errors · [ ] Mobile width sanity check

## Known issues / waivers
```

## Role matrix check on staging (08 AC-14; R1, before any real client data)
The automated proof is `tests/rls/role-matrix.test.ts` (every cell of `src/lib/auth/permissions.ts`, per role). On staging, a person confirms the same with real sign-ins:
1. Create one user per role (Admin, Manager, Staff, Staff (limited)) and two clients: **A** with the Limited user as incharge, **B** with the Staff user as incharge.
2. Admin: Settings › Users shows "What each role can do" with 17 rows, matching `permissions.ts`.
3. Limited: Clients lists only A; `/clients/<B>` and B's documents show Not Found; `/activity` says "Your actions and your clients, newest first" and shows nothing about B. Can review and dispatch on A; has no Waive, Undo, Archive, plan-change or Settings › Users controls.
4. Staff: sees A and B; can waive, change plans and propose a type; has no Undo review/dispatch/waive, Archive, Assign/Pause or Users controls.
5. Manager: all of Staff, plus Undo, Archive, Assign/Pause, catalogue and Settings › Collection; no Users page and no "Add financial year".
6. Admin: everything, including Users and "Add financial year".
7. Bulk: on `/documents`, select 3 documents → **Download zip** saves `vault-documents-<date>.zip` with `<DOC-ID> <file>` entries; **Mark reviewed** on a mixed selection shows the skipped DOC-IDs. Time a 30-file / ~100 MB zip on office broadband (< 60 s, 08 AC-15).
Record pass/fail per step in the release record's manual checklist.

## DSC passwords (14; R1, staging and prod)
Before any real DSC password is entered on prod:
1. **Key per environment:** generate a 32-byte key on the owner's machine (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`), set `DSC_ENC_KEYS=1:<key>` and `DSC_KEY_ID=1` in that environment's Vercel project (server-only; Production and Preview). Never reuse the dev key; never the public test key (the app refuses it in production).
2. **Key backup:** the same value stored in the owner's password manager, outside Vercel. A lost key makes every stored password unreadable.
3. **Round trip on staging:** add a DSC with a dummy PIN, Show password shows it, Activity › Password reveals lists the reveal; a Limited user sees the DSC but no Show password.
4. **Written risk acceptance** by Kushal Associates (intent "Risks"): anyone with a Staff, Manager or Admin login can reveal every client's PIN; every reveal is logged. Filed in `sdlc/releases/R1/`.
5. **Weekly reveal check during the pilot:** an Admin or Manager opens Activity › Password reveals and confirms each reveal was expected.
6. **Key rotation (when needed):** add `2:<new key>` to `DSC_ENC_KEYS`, set `DSC_KEY_ID=2`, re-encrypt with a one-off server script (decrypt by the old id, save through `dsc_save`), then remove `1:`. Not automated in R1.

## Firms and tenancy (17; R1, staging and prod)
1. **`TENANCY_MODE=multi`** on the staging and prod Vercel projects (server-only, Production and Preview). Unset also means multi; set it so the intent is visible.
2. **Sender:** `MAIL_FROM_EMAIL` = the platform address on a verified sending domain (Brevo now, SES after the switch); `MAIL_FROM_NAME` = "CA Document Vault". Emails then read `"<firm name>" <platform address>`, Reply-To = the staff member.
3. **Invite template** (Supabase → Authentication → Email templates → Invite user): subject "You've been invited to {{ .Data.firm }} on CA Document Vault", and the firm in the body. One test invite per environment.
4. **Bootstrap Kushal Associates** after the migration replay (the 2026-09-25 seed row exists with no staff): from a shell with that environment's values, `node scripts/bootstrap-firm.mjs --env staging --name "Kushal Associates" --branch "Pondicherry" --admin-email <Kushal's Admin> --admin-name "<name>"`, check the printed plan (project ref, mode multi) and the listed staff-less office named "Kushal Associates" (the seed row) with its ID, then run again with `--office <that id> --yes` (prod: `--env prod … --office <id> --yes --yes-production`). Without `--office` the script would create a second, empty "Kushal Associates". Record the office ID and time here; Kushal's Admin signs in from the invite.
5. **Edge check on staging with a second firm:** bootstrap "Staging Test Firm" (a real address you control), sign in as its Admin: the login page shows "CA Document Vault", the header shows "Staging Test Firm", Clients and Documents are empty, an invite of a Kushal staff email gets "This email is already in use…", and a reminder sent from it arrives as "Staging Test Firm". Never run this on prod.
6. **Settings › Office:** Kushal's Admin sees Office; a Manager doesn't.
7. **Expected skips:** after step 4, `tests/rls/office.test.ts`'s three probe tests skip on staging (the probe refuses once a deployment mode is set, and on any database with no test office, i.e. prod). They run on dev and CI's local stack. Not a failure.

## Super admins (19; R1, staging and prod)
1. **Migrations replayed** (`20261104140000_platform_a`, `20261104140100_platform_b`): no data step. Check that `public.platform_firms()` refuses a staff member (`NOT_PLATFORM_ADMIN`) and that `office` has the three suspend columns.
2. **Add the super admins with the script** — Pulsebay only, a **named few**, each on a **mailbox only that person can open** (no second factor in R1: the inbox is the key to every firm's client details; accepted risk, architecture decision log 2026-11-04). From a shell with that environment's values: `node scripts/add-platform-admin.mjs --env staging --email <person>@pulsebay.com --name "<full name>"`, check the plan (project ref), then add `--yes` (prod: `--env prod … --yes --yes-production`). Never a `.test` address, never an address that is staff in any firm (refused). Record who and when here. Someone who leaves: `--deactivate --yes` the same day.
3. **Smoke the console on staging** (a real super admin, real firms only):
   - sign in with the email code → `/platform`; open `/today` → back to `/platform`;
   - the firms list shows Kushal Associates (and the staging test firm from "Firms and tenancy" step 5);
   - on the staging test firm: open read access with a reason → a client and a document open, no file link; its Admin sees "Pulsebay support viewed …" under Activity › Support access and the bell; close → the views shut;
   - suspend the staging test firm → its signed-in Admin gets "This firm's access is paused" on the next click and one of its upload links shows the generic "not active" page; reactivate → both work again;
   - Platform › Audit lists each step, with the reasons;
   - a Kushal staff member opening `/platform` gets Not Found.
   Never open access to, or suspend, Kushal Associates on prod as a test.
4. **Reads stay logged:** check that the PostgREST setting `db-tx-end` is not overridable (`commit` — Supabase's default; never `commit-allow-override`), so a `Prefer: tx=rollback` call can't read client data and roll back its own log row. `tests/rls/platform.test.ts` › M-1 shows it per environment.
5. **Test super admins on staging:** the staging Regression creates `.test` super admins (fixtures); they act on test firms only and real super admins don't see their audit rows. Don't remove them by hand.
6. **Expected skip:** `tests/rls/platform-suspend.test.ts`'s nightly-skip probe (`test_platform_probe`) is refused once a deployment mode is set (staging, prod), like 17's probe. Not a failure.
