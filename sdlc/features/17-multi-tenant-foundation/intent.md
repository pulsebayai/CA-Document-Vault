# Intent: Multi-tenant foundation (one codebase for SaaS, Dedicated and Customer-owned)
Author: Sidambara (drafted with Claude) · Status: draft · Date: 2026-11-03
Roadmap item: 17-multi-tenant-foundation · Release: **R1** (owner, 2026-11-03) · Moves product metric: none directly — a business enabler (more firms on the same product); guards metric 5 (adoption) by keeping Kushal's experience unchanged
Source: chat decisions 2026-11-01 → 11-03, recorded in `sdlc/notes/2026-11-03-multi-tenant-decisions.md` (project doc).

## Problem
- **The product can't be sold to a second firm without leaking the first one.** The data layer is already per-firm (`office_id` + RLS on every business table, signed Storage links only after an RLS lookup, tenant-first definer functions), but the shell around it assumes one firm:
  - the **login page** shows the oldest office's name to every visitor (`src/app/(auth)/login/page.tsx`): a second firm's staff would see "Kushal Associates";
  - the **email sender** is one per environment (`MAIL_FROM_EMAIL` / `MAIL_FROM_NAME`), so every firm's reminders and upload links would come from one firm's name;
  - **inviting staff** answers "This person already has an account." for an email used at *another* firm, telling Firm B who works for Firm A;
  - a **new firm can only be created by hand** (SQL insert + manual first-Admin link; the seed migration hard-codes Kushal Associates);
  - the firm's **name and branch** can only be changed in the database.
- **Some firms will want their own infrastructure** (client data is personal and sensitive): the same code must run as one firm per deployment, without a second product.

**Cost of not doing it:** Kushal's staging/prod would launch single-firm, and taking a second firm later means changing a live system (login, email, invites) under real data; a firm asking for its own infrastructure can't be served at all.

## Proposed outcome
1. **`TENANCY_MODE` = `multi` | `single`**, a server-only setting read from one module (ESLint-fenced, like the service-role key). It switches **only the shell**, never the data model, RLS or business logic:
   - `multi` (SaaS, Kushal's staging/prod): login shows the platform name; the firm's name appears after sign-in.
   - `single` (Dedicated / Customer-owned deployment): login shows that deployment's one firm; the database refuses a second real office.
2. **Per-firm email sender:** sender name (and, if the spec decides so, address) stored on `office`, used by the mailer interface for reminders and upload-link emails; environment variables only as a fallback. Built provider-neutral, ready for the SES switch.
3. **Settings › Office** (Admin only): firm name, branch, sender name.
4. **Neutral invite error** for an email already in use anywhere: no hint that it belongs to another firm.
5. **Bootstrap a new firm with one command:** office + first Admin (invite) + seed catalogue + financial years, service-role only, logged. Used for Kushal on staging/prod and for every later firm.
6. **Tests in both modes:** the full suite in `multi` (the default for CI); mode-specific tests (login page, single-office guard, bootstrap) in both.

## Users & systems affected
- **Staff of every firm:** see their own firm's name (already true after sign-in); Admins get Settings › Office.
- **Clients:** reminder emails and upload-link emails come from their firm's name.
- **Owner/operator (Pulsebay):** creates firms with the bootstrap command instead of SQL.
- **Systems (detailed in the spec):** login page, `src/lib/auth/staff.ts`, `src/lib/staff/actions.ts` (invite), `src/lib/mail/*` (sender), `office` table (new columns) and a bootstrap function → **schema lock** (free); architecture decisions (tenancy model, deployment models, one-email-one-firm) → **architecture lock** (free); CI workflow (mode matrix).

## Success metrics
1. **No cross-firm leak at the edges:** with a second test firm on dev/staging, a test proves that firm's login page, invite errors, reminder email and upload page never show Kushal's name, and the reverse. (Pass/fail; joins the regression suite.)
2. **New firm in ≤ 10 minutes:** a fresh firm bootstrapped on staging with one command, first Admin signs in and sees an empty, seeded vault — timed at the R1 staging gate.
3. **Kushal unchanged:** every existing test passes unedited in `multi` mode; after sign-in Kushal's staff see no difference (R1 manual checklist).

## Constraints
- **Shell only.** No change to RLS policies, `private.current_office_id()`, business tables or business functions. The flag is read in ≤ 6 places (spec lists them); a lint/test guard keeps it there.
- **One email = one firm** (owner, 2026-11-02): no membership table, no office switcher.
- No PII in URLs or logs; the bootstrap logs IDs only.
- Service role only in server modules (existing rule); bootstrap callable only with the service role.
- Mailer stays provider-neutral (Brevo today, SES at staging/prod setup).
- [Likely] ≈ 5–7 working days incl. review; staging/prod creation itself is not part of 17.

## Behaviour that must not change
- Everything after sign-in, for every role (Kushal's pilot experience).
- RLS isolation, Storage path rules, signed-link lifetimes, DSC encryption.
- Reminder caps (per client per day; office ceiling), test-transport defaults (`MAIL_TRANSPORT` unset = never sends; `.test` never emailed).
- The upload page (10) already shows the link's own firm: keep it.
- Every existing test unedited.

## Out of scope (later phases, recorded in the decisions note)
- Self-signup, billing (Razorpay, GST invoices), plan limits, super-admin console, offboarding/export/purge (SaaS growth phase, before a self-serve firm).
- Cross-tenant RLS test sweep over every table/function (**before the second real firm**, its own chore; 17 adds only the edge tests in metric 1).
- Deployment kit for Dedicated/Customer-owned (runbook, fleet release script, health checks), replacing the Kushal seed migration, moving test-only helpers out of customer databases.
- Per-firm DSC encryption keys (today one `DSC_ENC_KEYS` per environment).
- Per-firm subdomains / white-label login.
- Feature 16 (client notifications) — postponed by the owner; will use 17's sender.

## Product-level changes this needs (on main, with the owner's OK)
- `product.md` lists **"Multi-firm SaaS (tenancy, billing, self-serve onboarding)" as a non-goal** → narrow it to "billing and self-serve onboarding (later)" and add the three deployment models.
- `architecture.md` decision log: reverse **2026-09-25 "Single office, single tenant"**; add tenancy modes, deployment models, one-email-one-firm, operator access only through a logged server-side path (never a staff login in a customer's office).

## Open questions (for the spec)
1. **Platform name on the multi-mode login page:** "CA Document Vault", or a product brand?
2. **Sender address:** one platform address with the firm as display name and Reply-To = the staff member (recommended; one verified domain), or a verified address per firm (each firm's DNS team adds DKIM)? Changes what `office` stores and the staging checklist.
3. **Single-office guard:** how does the database know the mode (a one-row settings table set at deployment, vs a check only in the bootstrap)? A database rule survives a mistaken SQL insert; a bootstrap check doesn't.
4. **`TENANCY_MODE` unset:** fail closed (app refuses to start in production) or default to `multi`?
5. **Bootstrap interface:** an npm script (service role, run by the operator) calling one SQL function, or the SQL function alone? First Admin by invite email (normal flow) — confirm.
6. **Email ceiling across firms:** `EMAIL_DAILY_MAX` is per office; with many firms on one SES account, is a platform-wide ceiling needed now, or later with billing?
7. **Who may edit the firm name:** Admin only (recommended), and is the change logged in Activity?
