# Intent: Super admin console (platform-level firm management)
Author: Sidambara (drafted with Claude) · Status: **approved** (Sidambara, 2026-11-04 13:27: Q1–Q5 as recommended, **except Q1 changed at the spec gate (13:31): no second factor in R1** — email code like staff, 2FA after R1; reason + 60-minute window; firm sees access in Activity + bell; neutral suspended message; usage = staff, clients, documents, files stored, last activity) · Date: 2026-11-04
Roadmap item: 19-super-admin-console · Release: **R1** (Sidambara, 2026-11-04) · Moves product metric: none directly. It enables more firms, which matters because Kushal Associates distributes the vault to other CA firms.
Decisions already made (Sidambara, 2026-11-04):
- Super admin = **Pulsebay only**. Kushal asks Pulsebay to set up each firm.
- Super admin **can read a firm's data, read-only, with every view logged**.
- Read-only **excludes file downloads and DSC password reveal**.
- **Suspend / reactivate** is in scope.
- No self-signup (after R1).

## Problem
- **Setting up a firm today needs a terminal.** 17's `scripts/bootstrap-firm.mjs` creates the firm and invites its first Admin, but it runs with the service-role key from a developer's machine. It works, but:
  - it can't be shown to Kushal as a product;
  - it puts the most powerful key in the database on a laptop for a routine task.
- **There is no view across firms.** Nobody can see which firms exist, how many staff and clients each has, or whether a firm is active, short of running SQL.
- **A firm can't be stopped.** If a distributed firm stops paying or leaves, the only option is deactivating its staff one by one, from inside that firm.
- **Support has no safe way in.** To answer "why can't I see this document?", the operator has no access short of SQL. Architecture (17) says the operator never holds a staff account in a customer's firm.

**Cost of not doing it:**
- The R1 demo to Kushal can't show "the platform sets up another firm".
- Every new firm needs a developer.
- A non-paying or departing firm keeps full access.

## Proposed outcome
1. **A super admin identity outside every firm.**
   - Pulsebay's people sign in with the same email one-time code as staff. They're recorded in a new platform-admin list, never in any firm's staff.
   - One email = one firm (17) extends to: an email is staff in one firm, **or** a super admin, never both.
   - Super admins are added only by the operator (one-off script), not from the UI.
   - Their sign-in lands on a separate **Platform** area. They see no firm screens.
2. **Firms list:**
   - name, branch, status (active / suspended), created date;
   - usage: staff (active / invited), clients, documents, files stored (MB), last activity date.
   - Counts only; no client names on this screen.
3. **Create a firm** from the UI:
   - name, branch, first Admin's name and email;
   - the same rules as 17's `bootstrap_office`: catalogue and preferred formats seeded, first Admin invited by email, logged.
   - Also "resend invite" while the first Admin hasn't signed in.
4. **Suspend / reactivate a firm**, with a reason.
   - While suspended:
     - its staff can't sign in or use the vault (immediately, like deactivation);
     - its client upload links stop working;
     - its nightly jobs skip it.
   - Nothing is deleted. Reactivation restores everything as it was.
5. **Read-only view of a firm's data, with every view logged** (decided).
   - The super admin opens a firm with a **written reason** (e.g. a support ticket).
   - Access lasts **60 minutes**, then must be reopened.
   - Screens, read-only:
     - Clients (list and client page);
     - Documents (list and document details);
     - Expected items;
     - Activity.
   - **No file view or download, no DSC password reveal** (decided), and no writes of any kind.
   - **Every opening and every page viewed is logged** twice:
     - in a platform audit log;
     - in the firm's own Activity ("Pulsebay support viewed …").
   - The firm's Admins get a bell notification when access is opened.
6. **Platform audit log:** every super admin action (create, invite, suspend, reactivate, open access, view) is append-only and visible to super admins.

## Users & systems affected
- **Pulsebay operator (super admin):** new Platform area.
- **Firm Admins:**
  - see support access in Activity, and get a bell notification;
  - see a "firm suspended" message if suspended.
- **Firm staff:** locked out while suspended.
- **Clients:** their upload link shows the generic "link not active" page while the firm is suspended (10's single answer for any unusable link).
- **Systems, detailed in the spec:**
  - sign-in routing;
  - a new platform-admin table and audit table;
  - `office` gets suspended fields;
  - `private.current_office_id()` returns nothing for a suspended firm, so every RLS policy refuses at once;
  - 10's link checks and 04's nightly job skip suspended firms;
  - read-only data screens served by a server-only, logged module;
  - 18's cross-firm guard gets the new objects.
- **Locks:** schema lock + architecture lock.

## Success metrics
1. **New firm in ≤ 5 minutes from the UI.** Timed on staging: create, the first Admin accepts the invite, and they see an empty, seeded vault.
2. **Suspension is immediate and complete.** Pass/fail test: a signed-in staff member of a suspended firm is refused on their next request, and their upload links answer "not active".
3. **No unlogged access.** Pass/fail test: every super admin read of firm data has an audit row and a firm activity row, and none happens outside an open, unexpired access.
4. **No path from super admin to writes, files or DSC passwords.** Pass/fail test: 18's sweep extended to the super admin.

## Constraints
- **Isolation stays as proven by 18.** The super admin is never a staff member of any firm, and firm RLS is unchanged except the suspended check. Data viewing goes through one server-only module that takes the firm explicitly and logs before it returns, the same "log before return" pattern as 14's DSC reveal.
- **Read-only means read-only:** no write function, no signed file URL and no DSC reveal is reachable from the Platform area.
- **The service-role key stays server-side.** It is used only in the allow-listed modules (17's ESLint fence).
- **No PII in URLs, logs or analytics.** The access reason is free text: stored on the access record, never in activity data (02's rule).
- **18's guard:** every new table, view and function gets its cross-firm and platform case in the same PR.

## Out of scope (R1)
- Self-signup and billing.
- Data export and offboarding (after R1).
- Adding super admins from the UI.
- Super admin editing firm data.
- Impersonating a staff member.
- Per-firm settings beyond name and branch.
- Dedicated / Customer-owned deployment kit.

## Decisions (approved 2026-11-04, as recommended)
1. **Q1 — second factor for super admins.** I recommend **requiring an authenticator app (TOTP) on top of the email code** for super admins only. One stolen super admin login can read every firm, so it's the platform's most sensitive account. Supabase Auth supports TOTP MFA [Likely, to confirm in the spec]. Cost: [Uncertain] +1–2 days.
2. **Q2 — the access window.** I recommend a written reason plus **60 minutes**, reopened as needed, with the firm's Admins notified each time it opens. Alternative: always-on read access with logging only. That's simpler, but harder to defend to privacy-conscious firms.
3. **Q3 — what the firm sees.** I recommend that support access shows in the firm's Activity, and that Admins get a bell notification. Alternative: platform-only logging, where the firm can't see it. I don't recommend that; it builds no trust.
4. **Q4 — suspended firm's sign-in message.** I recommend: "This firm's access is paused. Contact your firm's administrator." It names no reason and no vendor.
5. **Q5 — usage counts.** I recommend staff, clients, documents, files stored (MB) and last activity date. Should anything else be shown, e.g. emails sent this month, which Brevo/SES limits make worth watching?

## Estimate
[Uncertain] 7–10 working days including review, plus 1–2 if Q1 = TOTP. The pilot moves to ≈ mid-to-late January, as noted on the roadmap.
