# Roadmap: CA Document Vault
Updated: 2026-09-28 (03 started; 03 split into 03 intake + 03b search) · Architecture lock: 03 (spec changes 1–4, approved 2026-09-28) · Schema lock: 03

| # | Feature slug | One-line intent | Product metric | Depends on | Touches (entities / screens / shared code) | Arch change? | Batch | Status |
|---|---|---|---|---|---|---|---|---|
| 01 | walking-skeleton | Admin-provisioned staff login (email OTP), office + roles, empty Clients screen, CI, deployed to Mumbai | 5 | — | auth, office, staff_user, layout, CI | yes | — | shipped (2026-09-25, PR #1) |
| 02 | clients-and-catalogue | Masters (groups, types with default schedules, FY/period); add/edit/archive clients + CSV import; enabling a group copies its types into client instances with own schedule | enabler | 01 | client*, doc_group, doc_type, financial_year, period, client_doc_type; Clients, Add client, Client›Settings, Settings›Catalogue | schema | A | shipped (2026-09-28, PR #4) |
| 03 | document-intake-and-search | File storage (private, signed URLs, 25 MB, allow-list), Add document with dimensions from context, DOC-IDs (DOC-YY-NNNNN, FY), Inbox, Client › Documents list, inline "new type" (proposed, client-only) | 1, 3, 4 | 02 | document, document_version, storage; Inbox, Add document, Client›Documents | schema | B | in-progress |
| 03b | document-search | Documents/Search screen: filter on every dimension + facets (status, received as, channel, received by) + text on file name/remark; header search box | 3 | 03 | Documents/Search, header search | no (indexes only) | — | planned |
| 04 | expected-docs-schedule | Generate expected docs from client instances; due/overdue; link files to expected docs; metric 1 measurable | 1 | 02, 03 | expected_doc, pg_cron; Client›Expected | schema | C | planned |
| 05 | type-governance | Admin review queue for proposed types: approve / edit / map to existing (re-points documents) / reject; audit; in-app notifications | 3 | 03 | doc_type_proposal, notification; Settings›Catalogue, notification centre | schema | C | planned |
| 06 | today-and-reminders | Per-staff Today (overdue, due this week, to review, inbox); "Remind" emails client (SES); "WhatsApp" opens pre-filled chat; both logged | 1, 2 | 03, 04 | follow_up, email; Today, Client›Documents | yes (email provider) | D | planned |
| 07 | review-and-dispatch | Received → reviewed → ready to dispatch → dispatched for originals; history | 1 | 03 | document status, dispatch; drawer | schema | — | planned |
| 08 | bulk-activity-roles | Bulk zip download / bulk mark reviewed, Activity log screen, Users & roles screen with full RLS matrix | 5 | 03 | activity, RLS; Activity, Settings›Users | no | — | planned |

Later: client portal / upload links · automatic scheduled client reminders · AI type suggestions · receipt & dispatch acknowledgement emails · staff nudge emails · retention & archive rules · pause/resume groups · storage quota view · WhatsApp Business intake · multi-office.

## Releases
Every release passes the *Release & regression policy* (architecture.md); records + evidence in `sdlc/releases/`.
- **R1 — Pilot (target: as early as possible):** 01–06 incl. 03b, then create staging + prod Supabase projects and prod Vercel env *before* any real client data, used by 2–3 staff on a 20–30 client subset for the monthly GST cycle, then all clients.
  - R1 staging checklist additions (from 02): AC-22 plan set-up timed by a **Staff-role** user (≤ 2 min; 02 was timed by an Admin at 1:15) · 02 AC-17 proof = first nightly `regression.yml` on main after the merge (RUN_SLOW).
- **R2 — Full v1:** 07–08.

## Before pilot (carried from 01)
- Create staging + prod (timed run of README procedure = AC-17 proof) · prod email via SES ap-south-1 on the firm's domain · Supabase session inactivity timeout (paid) · LCP measurement on prod URL · consider GitHub Pro for branch protection on `main` · never name a staging/prod office `e2e office …` (auto-flagged is_test, purgeable by the test reset).

## Batches
Parallel planning checkpoint 2026-09-26 (preliminary — reconfirm from plans before C). Review capacity ~6 h/day → max 2 parallel.
- **A:** 02 alone (schema foundation for everything). — **done 2026-09-28** (PR #4).
- **B:** 03 alone (04 needs `document` to link files; 03 and 04 both need the schema lock). **Split 2026-09-28 (Raja):** search moved to 03b so 04 can start after 03; 03b fits later (e.g. alongside 05 or 06) — reconfirm at the next checkpoint.
- **C:** 04 ∥ 05 — merge 04 first, then 05 rebases; schema lock handed over at 04's merge. Soft overlap: 05's "map to existing" re-points `expected_doc` → 05 adds a test for it after rebase.
- **D:** 06 alone (needs 03 + 04; architecture change: email provider).
- Alternative (rejected): original 02 → 03∥04 → 05∥06 — hidden 04→03 dependency.
