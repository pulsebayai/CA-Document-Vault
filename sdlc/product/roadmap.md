# Roadmap: CA Document Vault
Updated: 2026-09-29 (Batch C launched: 04 ∥ 03b) · Architecture lock: **04** · Schema lock: **04** (03b: read-only migration exception — two new SECURITY INVOKER search functions only)

| # | Feature slug | One-line intent | Product metric | Depends on | Touches (entities / screens / shared code) | Arch change? | Batch | Status |
|---|---|---|---|---|---|---|---|---|
| 01 | walking-skeleton | Admin-provisioned staff login (email OTP), office + roles, empty Clients screen, CI, deployed to Mumbai | 5 | — | auth, office, staff_user, layout, CI | yes | — | shipped (2026-09-25, PR #1) |
| 02 | clients-and-catalogue | Masters (groups, types with default schedules, FY/period); add/edit/archive clients + CSV import; enabling a group copies its types into client instances with own schedule | enabler | 01 | client*, doc_group, doc_type, financial_year, period, client_doc_type; Clients, Add client, Client›Settings, Settings›Catalogue | schema | A | shipped (2026-09-28, PR #4) |
| 03 | document-intake-and-search | File storage (private, signed URLs, 25 MB, allow-list), Add document with dimensions from context, DOC-IDs (DOC-FY26-27-NNNNN, per FY), Inbox, Client › Documents list, inline "new type" (proposed, client-only) | 1, 3, 4 | 02 | document, document_version, storage; Inbox, Add document, Client›Documents | schema | B | shipped (2026-09-28, PR #7; fixes #8–#9) |
| 03b | document-search | Header search (clients + documents, DOC-ID jump) + `/documents` results page: filters on every dimension, facets with counts, text on DOC-ID/file name/remark; search text never in URLs | 3 | 03 | header, `/documents`, `src/lib/search/`; `search_documents` / `search_document_facets` (read-only functions) | no (read-only migration exception, Raja 2026-09-29) | C | in-progress (docs approved 2026-09-29) |
| 04 | expected-docs-schedule | Generate expected docs from client instances; due/overdue; link files to expected docs; metric 1 measurable | 1 | 02, 03 | expected_doc, pg_cron, `document.expected_doc_id`, triggers on plan/registration/document tables; Client›Expected + Documents cards, Clients "Has overdue", Settings›Collection; start-period default; FY auto-create | schema + arch (5 changes) | C | in-progress (docs approved 2026-09-29) |
| 05 | type-governance | Admin review queue for proposed types: approve / edit / map to existing (re-points documents) / reject; audit; in-app notifications | 3 | 03 | doc_type_proposal, notification; Settings›Catalogue, notification centre (re-points `expected_doc` → needs 04) | schema | D | planned |
| 06 | today-and-reminders | Per-staff Today (overdue, due this week, to review, inbox); "Remind" emails client (SES); "WhatsApp" opens pre-filled chat; both logged | 1, 2 | 03, 04 | follow_up, email; Today, Client›Documents | yes (email provider) | D | planned |
| 07 | review-and-dispatch | Received → reviewed → ready to dispatch → dispatched for originals; history | 1 | 03 | document status, dispatch; drawer | schema | — | planned |
| 08 | bulk-activity-roles | Bulk zip download / bulk mark reviewed, Activity log screen, Users & roles screen with full RLS matrix | 5 | 03 | activity, RLS; Activity, Settings›Users | no | — | planned |

Later: client portal / upload links · automatic scheduled client reminders · AI type suggestions · receipt & dispatch acknowledgement emails · staff nudge emails · retention & archive rules · pause/resume groups · storage quota view · WhatsApp Business intake · multi-office.

## Releases
Every release passes the *Release & regression policy* (architecture.md); records + evidence in `sdlc/releases/`.
- **R1 — Pilot (target: as early as possible):** 01–06 incl. 03b, then create staging + prod Supabase projects and prod Vercel env *before* any real client data, used by 2–3 staff on a 20–30 client subset for the monthly GST cycle, then all clients.
  - R1 staging checklist additions (from 02): AC-22 plan set-up timed by a **Staff-role** user (≤ 2 min; 02 was timed by an Admin at 1:15) · 02 AC-17 proof = first nightly `regression.yml` on main after the merge (RUN_SLOW) — RLS step passed in nightly 36502490351 (2026-09-29).
  - R1 staging checklist additions (from 03): AC-5 re-timed by a **Staff-role** user filing 3 documents (03 was timed by the Admin: 1 doc, 15 s) · downloads not cached by the browser (stored `Cache-Control: private, no-store`; Supabase's signed download doesn't echo it) · smoke on staging: **no CSP errors** (preview failures were the Vercel Toolbar; confirm staging/prod show no toolbar) · full `regression.yml` against staging (e2e reaches deployed URLs since #8).
- **R2 — Full v1:** 07–08.

## Before pilot (carried from 01)
- **Volume test after all R1 features are built (Raja 2026-09-29):**
  - 10k documents with the approved test-only `seed_test_documents` (invoker; `is_test` offices only; loops `create_document`);
  - 03b AC-12 timings (suggestions < 300 ms, results + facets < 1 s, Limited < 1 s); add indexes only if a target fails.
- Create staging + prod (timed run of README procedure = AC-17 proof) · prod email via SES ap-south-1 on the firm's domain · Supabase session inactivity timeout (paid) · LCP measurement on prod URL · consider GitHub Pro for branch protection on `main` · never name a staging/prod office `e2e office …` (auto-flagged is_test, purgeable by the test reset).

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
  - 03b's 100k volume test → deferred (see Before pilot).
- **D (decide at next checkpoint):** 05 (needs 04's `expected_doc`; schema) and whether 06 can run beside it (06 needs schema for `follow_up` + the email-provider architecture change).
- Rejected 2026-09-29: 04 ∥ 05 — 05 depends on 04's `expected_doc` and both need the schema lock (05 would idle most of 04's build). Earlier rejected: 02 → 03∥04 → 05∥06 (hidden 04→03 dependency).
