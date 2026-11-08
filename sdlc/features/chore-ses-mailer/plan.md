# Chore: ses-mailer
Owner: Sidambara · Decided 2026-11-06 (option 1: SES for staging and prod, dev unchanged) · Holds the architecture lock (roadmap) · No schema change.

## Why
Staging must send the way prod will, so the R1 gate tests the real email path; reminder content stays in India (decision log 2026-11-06).

## Scope
- `src/lib/mail/ses.ts`: SES v2 `SendEmail` transport (ap-south-1 only, 10 s timeout, no SDK retries, explicit credentials, RFC 2047 names). Same result contract as `brevo.ts`.
- `core.ts`: `MAIL_TRANSPORT=ses` accepted; `deliver` picks the ses factory lazily; a caller without it gets `MAIL_CONFIG`.
- `index.ts` wires `sesFromEnv`. ESLint fence: `SES_*` read only in `ses.ts`. `LINK_IP_SALT` required with `ses` as with `brevo`.
- Docs: architecture (mailer), README (env vars), `sdlc/releases/README.md` › "Email through AWS SES" (the AWS steps), `.env.example`.
- Not in scope: sign-in SMTP (a Supabase setting), Brevo removal, a delivery webhook.

## Steps
- [x] 1. SES transport + unit tests (`tests/unit/mail-ses.test.ts`), config + deliver wiring.
- [x] 2. Salt rule with `ses` (`tests/unit/link-salt.test.ts`, failing first without the change).
- [x] 3. Docs and the AWS checklist.
- [x] 4. PR CI green; merged (PR #36, 80b3850).
- [x] 5. Staging on SES (2026-11-08): sign-in code and one real reminder delivered; SPF, DKIM, DMARC pass. Prod follows with its own IAM users.

## Test changes (approved requirement change)
- `tests/unit/mailer.test.ts`: "rejects an unknown transport" used `ses` as its unknown value; `ses` is now a real transport (owner decision 2026-11-06), so the case uses `smtp`. Assertion unchanged.

## Session log
- 2026-11-07: steps 1–3. `@aws-sdk/client-sesv2@3.1153.0` pinned (released 2026-10-19). Unit: mailer + ses + salt green.
- 2026-11-07: PR #36 green and merged. AWS: the account already had SES production access in Mumbai (50,000/day), so no sandbox request. Sending domain `cavault.pulsebay.in` (subdomain, owner 2026-11-07: keeps the vault's reputation apart from pulsebay.in's own mail); DNS by Sankar: 3 DKIM CNAMEs, MAIL FROM `bounce.cavault.pulsebay.in` (MX + SPF), DMARC `p=none`.
- 2026-11-08: identity, DKIM and custom MAIL FROM verified. IAM: one send-only user for the app (`ses:SendEmail`, From = `no-reply@cavault.pulsebay.in`) and one SMTP user for Supabase Auth. Staging: `MAIL_TRANSPORT=ses`, `MAIL_FROM_EMAIL=no-reply@cavault.pulsebay.in`, allow-list kept, `APP_ENV` unset. **Proof:** a sign-in code and one reminder (Staging Test Firm, 2 items) arrived in the inbox; the follow-up is `sent` with SES's message ID (`010901a1ba62…`, 60 chars), no error code; Gmail shows SPF, DKIM and DMARC PASS. Note: the SES account's reputation is shared with Pulsebay's other Mumbai sending (weekly bounce check).
