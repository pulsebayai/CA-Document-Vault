# Intent: Walking skeleton — secure staff sign-in, deployed end-to-end in India
Author: Raja · Status: approved · Date: 2026-09-25
Roadmap item: 01-walking-skeleton · Moves product metric: 5 (Adoption) — enabler for all others

## Problem
Nothing exists yet. Every later feature (clients, documents, search, reminders) needs the same foundation: a deployed app in the Mumbai region, staff accounts the Admin controls, role enforcement in the database, and an automated check that stops broken code reaching production. Building features before this foundation means retrofitting security (RLS, roles) and deployment later — the most expensive and error-prone order.

## Proposed outcome
An Admin can open the **dev** URL, sign in with an email one-time code, invite a colleague with a role, and that colleague can sign in and see an (empty) Clients screen. Every pull request is checked automatically and gets a preview deploy on the dev database, all in the Mumbai region. Staging/prod environments are created before the pilot (not in this feature).

## Users & systems affected
- Admin (first account, seeded) · Manager / Staff / Staff (limited) (invited)
- New: GitHub repo + Actions, Vercel project (functions bom1). Existing: Supabase **dev** project `ysddbwskljzhbjjohool` (ap-south-1).

## Success metrics
- Admin → invite → colleague signed in: **< 5 minutes**, no developer involvement.
- Sign-up by an uninvited email is impossible (tested).
- A deactivated user loses access on their next request (tested).
- CI runs lint, typecheck, unit, e2e, build on every PR; main is protected.
- 100% of app data and files stored in ap-south-1; functions run in bom1 (verified in dashboards).
- Environment setup is scripted (migrations + seed) so staging/prod can be created from scratch in < 30 minutes.

## Constraints
- India data residency (architecture.md).
- No passwords; email OTP only. No self sign-up.
- Roles enforced by Postgres RLS from day one, not only in UI.
- Free tiers acceptable for dev; nothing in this feature may depend on a paid-only feature.

## Out of scope
- Clients, documents, catalogue, search (02+). Users & roles *management screen* beyond invite / change role / deactivate (full matrix UI is 08).
- Custom domain (at prod setup). Firm branding beyond the mockup's shell.
- SES / client email (06).

## Decisions (resolved open questions)
- Accounts: GitHub `RajaPulsebay/ca-document-vault` (private) · Supabase org Pulsebay, dev project `ysddbwskljzhbjjohool` · Vercel: user's account, project imported once the app exists.
- First Admin (seeded in dev): rajak@pulsebay.in
- Plans: free tiers for **dev only**. Paid (Vercel Pro + Supabase Pro) required before the pilot's prod environment — see architecture.md.
- Dev URL: free `*.vercel.app` address. Custom domain at prod setup.
- Review capacity: ~6 h/day → up to 2 features in parallel after 01 (skill max 3; 2 keeps review quality).
- UI: mockup (cavault.pulsebay.com) is the UI source of truth except documented deviations; this feature builds the app shell (top nav, header, layout, design tokens) to match it.
