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
- [ ] 4. PR CI green; merge.
- [ ] 5. After AWS approval: staging env vars, one real reminder on staging (checklist step 6). Then prod.

## Test changes (approved requirement change)
- `tests/unit/mailer.test.ts`: "rejects an unknown transport" used `ses` as its unknown value; `ses` is now a real transport (owner decision 2026-11-06), so the case uses `smtp`. Assertion unchanged.

## Session log
- 2026-11-07: steps 1–3. `@aws-sdk/client-sesv2@3.1153.0` pinned (released 2026-10-19). Unit: mailer + ses + salt green.
