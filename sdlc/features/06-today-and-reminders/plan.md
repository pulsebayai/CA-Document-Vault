# Plan: Today & reminders
Spec: ./spec.md · Status: approved (Raja 2026-10-01 17:32 IST) · Date: 2026-10-01
Holds (from approval): **architecture lock** (batch D, Raja 2026-10-01); schema = **additive-only exception** (07 holds the schema lock). 06's architecture changes go into architecture.md **in this PR** (lock holder).
Base: `feat/06-today-and-reminders` from main `5e871f3`. **07 merges first**; 06 merges main in after that (step 9) and re-runs the full suite.

## Design choices made while planning (from reading the code)
- **Safe default transport.** If `MAIL_TRANSPORT` is unset, the mailer uses `test`. CI, local runs and previews therefore never send without someone setting `brevo` on purpose, and `ci.yml` / `regression.yml` don't change. Production and staging set `MAIL_TRANSPORT=brevo` explicitly (R1 checklist).
- **Brevo key fenced like the service-role key:** an ESLint `no-restricted-syntax` rule allows `process.env.BREVO_API_KEY` only in `src/lib/mail/brevo.ts` (the same mechanism as `SUPABASE_SECRET_KEY` in `eslint.config.mjs`).
- **The cap is a unique partial index,** and the two-phase send claims it with the `pending` row. A double click or a second tab can't send twice; the second insert fails with `ALREADY_EMAILED_TODAY`.
- **`today_items` is one invoker function** returning `{ counts, cards }` for (scope, show, page). Effective assignee = `coalesce(cdt.assigned_staff_id, cg.assigned_staff_id, c.incharge_id)`, the same columns as `can_see_client`. The first version covers expected items only. After 07 merges, a second 06 migration replaces **06's own** function to add To review / Ready to dispatch (allowed under the exception).
- **Test-office purge without touching 02/03/04 functions:** 06's foreign keys to `client` and `expected_doc` are `on delete cascade`. The no-delete trigger on 06's tables honours `app.purge_office` (the existing flag).
- **Landing-page change touches merged tests** (decision below): `auth.spec.ts` (3 assertions), `users.spec.ts:54` and the shared `signIn()` helper (`tests/e2e/helpers.ts:21,58`) expect `/clients` after sign-in.
- **Stay out of 07's files:** 06 doesn't touch `documents/[id]/*`, `src/lib/review|dispatch/*`, search files or migrations other than its own. The shared file is `clients/[id]/documents-view.tsx`, where 06 changes **only the expected rows** (Remind / Log call / history) and 07 the document rows.

## Files that change
| Path | New/Mod | Why |
|---|---|---|
| supabase/migrations/<ts>_follow_up.sql | new | enums; `follow_up`, `follow_up_item` (+ RLS select via `can_see_client`, no-delete/no-update triggers honouring `app.purge_office`, cap index, FK cascades); `begin_email_reminder`, `finish_email_reminder`, `record_follow_up`, `today_items` (expected), `chasing_metric` |
| supabase/migrations/<ts>_today_documents.sql | new | (after 07 merges) replaces 06's `today_items` to add To review / Ready to dispatch |
| src/lib/mail/{index,brevo,test-transport}.ts | new | the mailer interface; Brevo HTTP API; test transport; allow-list and `.test` rule; 10 s timeout |
| src/lib/reminders/{message,actions,queries}.ts | new | the message builder (AC-10); send/whatsapp/call actions (two-phase); dialog data; client history |
| src/lib/today/queries.ts | new | `today_items` → view model; the scope/show enum parsing |
| src/app/page.tsx | mod | `/` → `/today` |
| src/lib/auth/actions.ts | mod | the three post-sign-in redirects → `/today` |
| src/components/app-header.tsx | mod | nav: Today first; logo → `/today` |
| src/app/(app)/today/{page,today-view,loading,error}.tsx | new | the Today screen |
| src/app/(app)/clients/remind-dialog.tsx, log-call-dialog.tsx | new | shared dialogs (Today + client page) |
| src/app/(app)/clients/[id]/documents-view.tsx | mod | Remind / Log call / "reminded N times" on **expected rows only** |
| src/app/(app)/clients/[id]/expected-view.tsx | mod | same on the Expected tab + Reminders list |
| src/app/(app)/settings/collection/page.tsx | mod | metric 2 block |
| eslint.config.mjs | mod | `BREVO_API_KEY` allow-list |
| .env.example, README.md | mod | the new env vars, per environment; staging/prod set `MAIL_TRANSPORT=brevo` |
| tests/rls/follow-up.test.ts, today.test.ts, chasing-metric.test.ts | new | step 1 (red first) |
| tests/unit/reminder-message.test.ts, mailer.test.ts, today-view.test.tsx, remind-dialog.test.tsx | new | builder rules, transport/allow-list, zero network calls in tests, views |
| tests/e2e/today.spec.ts, reminders.spec.ts | new | Today, dialogs, history, metric 2, ≤ 390 px, axe, screenshots |
| tests/e2e/auth.spec.ts, users.spec.ts, helpers.ts | mod | **only if decision 1 = (a)**: `/clients` → `/today` in the 4 post-sign-in URL assertions and the `signIn()` waits; in `auth.spec.ts` AC-1 one added `page.goto("/clients")` before its unchanged Clients-shell checks. One commit, listed in the PR |
| tests/support/expected.ts | mod | helpers to create follow-ups (**additions only**) |
| sdlc/product/architecture.md | mod | the spec's 5 architecture changes + decision rows (06 holds the lock) |
| sdlc/product/references/ui-reference.md | mod | deviations: Settings › Reminders not built; Remind dialog with preview; Log call |

**Expected overlap with 07:** `clients/[id]/documents-view.tsx` only (different rows; 07 merges first). `tests/support/*`: different files (07 `documents.ts`, 06 `expected.ts`). No migration overlap.

## Migrations (additive-only exception; schema lock: 07)
1. `<ts>_follow_up`: new objects only. Dry-run (rolled back, local fixture users only), **SQL gate**, apply, md5, advisors.
2. `<ts>_today_documents`: after 07 merges. Replaces only `today_items`. Same gate.

## Steps (estimates = build sessions with Claude; your time in brackets)
- [x] 0. Draft PR; CI green (docs). (—) — PR #24 (draft).
- [x] 1. **RLS/DB tests first (red)**, proof: `test:db` fails for the right reasons (1). Cases:
  - cap (second email refused; failed doesn't count; pending > 10 min ignored; office ceiling);
  - items must be the client's and open;
  - visibility per role, incl. Limited;
  - no app write path; activity has no address, text or note;
  - `today_items`: counts = rows, effective assignee type → group → incharge, the due-this-week boundary (IST), on-hold excluded, scope;
  - chasing metric (reminders before receipt only, per channel);
  - test purge works.
- [ ] 2. **Migration 1**: written, dry-run, **SQL gate**, applied, advisors clean. Proof: step-1 tests green in CI; all existing suites green. (1) [review SQL: 30 min]
- [ ] 3. **Mailer + message builder:** transports, allow-list, `.test` rule, default `test`, ESLint fence; the builder's AC-10 rules. Proof: unit tests red → green, incl. a fetch spy proving zero network calls under `test`. (0.5)
- [ ] 4. **Server actions:** two-phase email send, WhatsApp record, log call, dialog data, history, Today data; errors as code + request ID. Proof: unit + RLS through the actions. (0.5)
- [ ] 5. **Today screen** (expected rows), the landing redirect, nav, logo; the sign-in assertions per decision 1. Proof: e2e + unit. (1.5)
- [ ] 6. **Remind + Log call dialogs** on Today, Client › Documents (expected rows) and Client › Expected; history; the client's Reminders list. Proof: e2e + unit. (1.5)
- [ ] 7. **Metric 2** on Settings › Collection. Proof: RLS (definition) + e2e. (0.5)
- [ ] 8. **Real-send check on dev:** set `MAIL_TRANSPORT=brevo` + the dev key + `EMAIL_ALLOWLIST=<your address>` on the preview, then send one reminder to a test client whose email is your address. Proof: you receive it; From / Reply-To / content are checked; the follow-up shows Sent. (0.25) [you: 10 min]
- [ ] 9. **After 07 merges:** merge main; migration 2 (`today_items` + documents); To review / Ready to dispatch rows using 07's `documentState()` and actions. Proof: RLS + e2e. (1)
- [ ] 10. a11y (axe), ≤ 390 px, screenshots, ui-reference deviations. Proof: e2e evidence. (0.5)
- [ ] 11. **Timed check** (Staff role, preview): sign-in → find overdue → remind one client, ≤ 30 s. [you or a staff member: 10 min]
- [ ] 12. architecture.md (lock) → full suite → `verifier` → `sdlc-reviewer` → fix Important findings → PR with the AC → test → result table. (0.5) [PR review: 1 h]

**Total ≈ 8.25 build sessions.** Your time ≈ 2.5 h. **First cut:** the client page's Reminders list (row history stays). Second cut: count-as-filter on Today (counts stay, filtering dropped).
**RUN_SLOW:** not required. 06 changes no 02/03 write path; its tables are new and its functions only read 04's.

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| A real email leaves dev/CI by mistake | low | default transport `test`; the allow-list outside production; `.test` always suppressed; a zero-network unit test; the ESLint key fence |
| Brevo quota shared with sign-in on dev (free 300/day) | low | CI never sends; the step-8 check sends 1 email; caps |
| Today query slow at 1,000 clients | medium | one set-based function; paging; timings join the volume test |
| 07 late, so steps 9+ wait | medium | steps 1–8 don't depend on 07; 9 is isolated |
| Merge conflict in `documents-view.tsx` | medium | separate row components; 07 merges first; resolved in step 9 |
| Changing merged sign-in assertions hides a regression | low | one commit: URL swaps in 4 assertions + the helper's 2 waits, plus one added navigation in auth AC-1 so its Clients-shell checks still run unchanged; listed in the PR, reviewed by `sdlc-reviewer` |

## Proof of done
- Every AC → test (table in the PR); the full suite green on the last code commit; the step-8 real send and the step-11 timing recorded.
- Existing tests unchanged, **except** the post-sign-in URL assertions if decision 1 = (a).

## Decisions (Raja 2026-10-01: 1 = (a), 2 = yes, as recommended)
1. **Landing after sign-in vs. merged tests.**
   - **(a) Recommended:** sign-in lands on Today (spec AC-1, your Q1). Change `/clients` → `/today` in the 4 post-sign-in assertions (`auth.spec.ts` ×3, `users.spec.ts` ×1) and the shared `signIn()` waits, and add one `goto("/clients")` in auth AC-1 before its Clients-shell checks (which stay as they are). One clearly labelled commit. This is an intended behaviour change, not weakening a test.
   - (b) Sign-in keeps landing on Clients; only `/` and the logo go to Today. No test changes, but staff start on Clients every morning, which contradicts Q1.
2. **Default mail transport = `test` when unset.** Recommend **yes**: the safest default; staging/prod must opt in.

## Deviations from plan
(filled in during the build)

## Session log
