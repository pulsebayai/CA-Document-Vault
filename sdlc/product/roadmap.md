# Roadmap: CA Document Vault
Updated: 2026-10-02 (06 shipped, PR #24 — batch D done; architecture lock released) · earlier: 2026-10-02 (07 shipped, PR #25; schema lock released) · earlier: 2026-10-01 (batch D launched: 07 ∥ 06; batch E = 05 ∥ 08) · earlier: 2026-10-01 (03b shipped, PR #19 — batch C done) · earlier: 2026-10-01 (04 shipped, PR #17; schema + architecture locks released) · earlier: 2026-09-30 (07 + 08 moved into R1; batch E) · Architecture lock: none · Schema lock: none

| # | Feature slug | One-line intent | Product metric | Depends on | Touches (entities / screens / shared code) | Arch change? | Batch | Status |
|---|---|---|---|---|---|---|---|---|
| 01 | walking-skeleton | Admin-provisioned staff login (email OTP), office + roles, empty Clients screen, CI, deployed to Mumbai | 5 | — | auth, office, staff_user, layout, CI | yes | — | shipped (2026-09-25, PR #1) |
| 02 | clients-and-catalogue | Masters (groups, types with default schedules, FY/period); add/edit/archive clients + CSV import; enabling a group copies its types into client instances with own schedule | enabler | 01 | client*, doc_group, doc_type, financial_year, period, client_doc_type; Clients, Add client, Client›Settings, Settings›Catalogue | schema | A | shipped (2026-09-28, PR #4) |
| 03 | document-intake-and-search | File storage (private, signed URLs, 25 MB, allow-list), Add document with dimensions from context, DOC-IDs (DOC-FY26-27-NNNNN, per FY), Inbox, Client › Documents list, inline "new type" (proposed, client-only) | 1, 3, 4 | 02 | document, document_version, storage; Inbox, Add document, Client›Documents | schema | B | shipped (2026-09-28, PR #7; fixes #8–#9) |
| 03b | document-search | Header search (clients + documents, DOC-ID jump) + `/documents` results page: filters on every dimension, facets with counts, text on DOC-ID/file name/remark; search text never in URLs | 3 | 03 | header, `/documents`, `src/lib/search/`; `search_documents` / `search_document_facets` (read-only functions) | no (read-only migration exception, Raja 2026-09-29) | C | shipped (2026-10-01, PR #19) |
| 04 | expected-docs-schedule | Generate expected docs from client instances; due/overdue; link files to expected docs; metric 1 measurable | 1 | 02, 03 | expected_doc, pg_cron, `document.expected_doc_id`, triggers on plan/registration/document tables; Client›Expected + Documents cards, Clients "Has overdue", Settings›Collection; start-period default; FY auto-create | schema + arch (5 changes) | C | shipped (2026-10-01, PR #17) |
| 05 | type-governance | Admin review queue for proposed types: approve / edit / map to existing (re-points documents) / reject; audit; in-app notifications | 3 | 03 | doc_type_proposal, notification; Settings›Catalogue, notification centre (re-points `expected_doc` → needs 04) | schema | E | planned |
| 06 | today-and-reminders | Per-staff Today (overdue, due this week, to review, inbox); "Remind" emails client (Brevo); "WhatsApp" opens pre-filled chat; both logged | 1, 2 | 03, 04, 07 (Today's "To review" / "Ready to dispatch") | follow_up, follow_up_item, mailer (Brevo); Today (landing), header nav, Remind/Log call on Client›Documents & Expected, Settings›Collection (metric 2) | yes (email provider) | D | shipped (2026-10-02, PR #24) |
| 07 | review-and-dispatch | Received → reviewed → ready to dispatch → dispatched for originals; history | 1 | 03 | document status + review history, dispatch packets; 03 save trigger + 04 linking; Client›Documents, document page, `/documents` filters | schema | D | shipped (2026-10-02, PR #25) |
| 08 | bulk-activity-roles | Bulk zip download / bulk mark reviewed, Activity log screen, Users & roles screen with full RLS matrix | 5 | 03, 07 (bulk "mark reviewed" needs 07's reviewed status) | activity, RLS; Activity, Settings›Users | no | E | planned |

Later: **06 post-pilot fix (D8 / I-1, risk accepted for the pilot):** make `finish_email_reminder` service-role only, called from an admin-allow-listed server module that passes the sender (today any signed-in staff member could record an email as sent without Brevo being called: a false "reminded" row and a metric-2 count); plus N-1 (office/items checks inside 06's definer helpers) and N-6 (no call logged more than 90 days back) · client portal / upload links · automatic scheduled client reminders · AI type suggestions · receipt & dispatch acknowledgement emails · staff nudge emails · retention & archive rules · pause/resume groups · storage quota view · WhatsApp Business intake · multi-office.

## Releases
Every release passes the *Release & regression policy* (architecture.md); records + evidence in `sdlc/releases/`.
- **R1 — Pilot, full v1 (target: as early as possible):** 01–08 incl. 03b. **Changed 2026-09-30:** the client wants all features together, so 07 and 08 moved in from R2; the pilot stage is kept. After the last merge, create staging + prod Supabase projects and prod Vercel env *before* any real client data, used by 2–3 staff on a 20–30 client subset for the monthly GST cycle, then all clients.
  - Cost of the change: the pilot starts after batch E (07 → 08). Check the expected start date against the GST cycle it should cover — missing that cycle's early-month intake delays the pilot by a month, not days.
  - R1 staging checklist additions (from 02): AC-22 plan set-up timed by a **Staff-role** user (≤ 2 min; 02 was timed by an Admin at 1:15) · 02 AC-17 proof = first nightly `regression.yml` on main after the merge (RUN_SLOW) — RLS step passed in nightly 36502490351 (2026-09-29).
  - R1 staging checklist additions (from 03): AC-5 re-timed by a **Staff-role** user filing 3 documents (03 was timed by the Admin: 1 doc, 15 s) · downloads not cached by the browser (stored `Cache-Control: private, no-store`; Supabase's signed download doesn't echo it) · smoke on staging: **no CSP errors** (preview failures were the Vercel Toolbar; confirm staging/prod show no toolbar) · full `regression.yml` against staging (e2e reaches deployed URLs since #8).
  - R1 staging/prod checklist additions (from 06). Brevo returns 201 ("Sent" in the vault) **before** it checks the sender, and drops the email if the sender isn't verified; with no webhook, the vault can't see that.
    - **Brevo sender verified before go-live** (staging and prod accounts): the firm's domain authenticated (DKIM + DMARC, added by whoever runs its DNS), or at least `MAIL_FROM_EMAIL` confirmed under Senders.
    - **Env vars per environment** (Vercel, server-only): `MAIL_TRANSPORT=brevo`, `BREVO_API_KEY` (that environment's own account), `MAIL_FROM_EMAIL` (a plain address), `MAIL_FROM_NAME`, `EMAIL_DAILY_MAX`. `APP_ENV=production` **only on prod**; staging keeps the allow-list (`EMAIL_ALLOWLIST` = the testers).
    - **One real send per environment, confirmed in the Brevo log** (Transactional → Logs shows **Delivered** for the follow-up's `provider_message_id`; inbox, not spam; From = the firm, Reply-To = the sender).
    - **Review backlog at go-live:** 07 leaves every existing filed document at "To review", so Today shows the whole backlog. If the pilot starts with existing documents, bulk-mark them reviewed first (08's bulk action) or accept the long list.
    - **Weekly bounce check during the pilot** (Brevo → Transactional → Logs: blocked / bounced / spam): the vault records only Sent / Failed.
    - 06 step 11 timing (Staff role: sign-in → find overdue → remind one client ≤ 30 s; 10 s on the preview via WhatsApp) **re-done on staging with Send email**.
  - R1 staging checklist addition (from 08, when it lands): check the full RLS matrix on staging with one user per role before any real client data is loaded.
- **R2:** none planned — next candidates come from the Later list, prioritised from pilot feedback.

## Before pilot (carried from 01)
- **Volume test after all R1 features are built (Raja 2026-09-29):**
  - 10k documents with the approved test-only `seed_test_documents` (invoker; `is_test` offices only; loops `create_document`);
  - 03b AC-12 timings (suggestions < 300 ms, results + facets < 1 s, Limited < 1 s); add indexes only if a target fails.
    - **Indexes alone may not be enough (03b pre-PR review, 2026-10-01):** `search_documents` counts and ranks every match (`count(*) over ()` + `row_number()`) on every call, including each 5-row header suggestion, so a `(office_id, received_on desc)` index can't serve a top-N. If a target fails, the fix is a separate count + `ORDER BY … LIMIT/OFFSET`: a migration replacing both search functions.
    - Also time header suggestions' `search_clients` call: since 04 it counts `expected_doc` per matching client.
  - 04's volume step (~180k expected items: daily job < 60 s, measured first; screens < 1 s; save + < 50 ms).
- Create staging + prod (timed run of README procedure = AC-17 proof) · staging/prod Brevo account (separate from dev; paid plan; firm's domain DKIM/DMARC added by whoever runs its DNS) for sign-in codes and reminders · Supabase session inactivity timeout (paid) · LCP measurement on prod URL · consider GitHub Pro for branch protection on `main` · never name a staging/prod office `e2e office …` (auto-flagged is_test, purgeable by the test reset).

## Batches
Parallel planning checkpoint 2026-09-26; **re-run 2026-09-29 (Raja)** — review capacity ~6 h/day (can extend) → max 2 parallel.
- **A:** 02 alone — **done 2026-09-28** (PR #4).
- **B:** 03 alone — **done 2026-09-28** (PR #7; fixes #8–#9). Search split out to 03b.
- **Before C builds — chore `test-isolation` (~1 day, Raja 2026-09-29, CI option 2):** per-run test offices + fixture users (run-id suffix) and a nightly purge of old test data, so CI/Regression runs no longer share one queue slot (a waiting run was cancelled 4× on 28–29 Sep). Planning docs for C may proceed meanwhile.
- **Chore test-isolation — done 2026-09-29** (PR #13 + #14). CI/Regression lease 1 of **2** test lanes with lane-suffixed fixtures; the `dev-database` queue is gone. 4 runs overlapping on 2 lanes all passed (2026-09-29 22:00–22:35).
- **C — launched 2026-09-29 (Raja), confirmed from both plans:** **04 ∥ 03b.**
  - **Code overlap: none.** 03b calls `search_clients` directly (04 extends it and keeps its existing parameters).
  - Merge 04 first; 03b rebases and re-runs the full suite.
  - Locks: schema + architecture → 04. 03b holds a **read-only migration exception**: it may add only its two new SECURITY INVOKER search functions, and no table, column, policy, trigger or existing-function change.
  - Volume tests for 03b and 04 → deferred (see Before pilot).
  - **Batch C done 2026-10-01.** 03b shipped (PR #19): main merged in, full suite green (CI 36843722573), plus a second read-only migration `20261001093454` (review fix: Limited search keeps the user's own unfiled document).
  - **04 shipped 2026-10-01 (PR #17)**; locks released. 03b next: rebase on main → full suite → PR. 04 changed `search_clients` (same parameters + new columns/`p_has_overdue`), Add document (pre-fill), client page tabs and Add/Edit client redirects.
- **D — launched 2026-10-01 (Raja), confirmed from both plans: 07 ∥ 06.**
  - Re-ordered at the checkpoint: 06's Today needs 07's review states, and E as planned had 08 waiting on 07 inside the batch. So D = 06 ∥ 07 and E = 05 ∥ 08 (08's dependency on 07 is met by then).
  - **Overlap:** `clients/[id]/documents-view.tsx` only (07 document rows, 06 expected rows) plus `ui-reference.md` deviation rows. No migration overlap.
  - **Merge 07 first**; 06 then merges main in, adds its To review / Ready to dispatch parts (plan step 9) and re-runs the full suite.
  - **Locks:** schema → 07. Architecture → 06 (Brevo mailer; written in 06's PR); 07's four architecture items go to architecture.md on main at its merge. 06 holds an **additive-only exception**: its own new tables and functions only; cascading FKs only so the test-office purge keeps working.
  - 07 changes 03/04 write paths → **RUN_SLOW before merge**. 06 doesn't.
  - Email decisions (2026-10-01): Brevo for sign-in and reminders; Sent/Failed only in the pilot (no webhook); Reply-To = the sender.
  - **07 shipped 2026-10-02 (PR #25)**: 4 migrations (`20261001122110`, `…123125`, `…123450`, `…154640`); CI 36888132235 and full RUN_SLOW Regression 36903979616 green on the branch preview. Schema lock released. **06 next:** merge main in (it uses `src/lib/documents/state.ts`; 07 moved the received-document row of `clients/[id]/documents-view.tsx` into `document-row.tsx`), finish step 9, full suite → PR.
  - **For the batch E checkpoint:**
    - 02's `clients-list.test.ts` NFR timing check (≤ 1 s round trip, US runner → Mumbai) flaked 3× on 1 Oct (1,134 ms). Propose a chore: measure it server-side, or set a realistic budget (Raja's OK).
    - 05's "map to existing" re-points `document.doc_type_id`, which resets reviews under 07 AC-4; 05's spec must decide.
  - **06 shipped 2026-10-02 (PR #24)**, so **batch D is done.** The architecture lock is released. 06's R1 checklist items are in Releases › R1, and its post-pilot fix (D8 / I-1) is in Later.
- **E (re-ordered 2026-10-01): 05 ∥ 08**, after batch D. Reconfirm from plans at the next checkpoint. 05 takes the schema lock (re-points documents, plan rows, expected items); 08 has no schema change.
- Rejected 2026-09-29: 04 ∥ 05 — 05 depends on 04's `expected_doc` and both need the schema lock (05 would idle most of 04's build). Earlier rejected: 02 → 03∥04 → 05∥06 (hidden 04→03 dependency).
