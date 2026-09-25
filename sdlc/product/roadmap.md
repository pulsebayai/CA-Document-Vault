# Roadmap: CA Document Vault
Updated: 2026-09-25 · Architecture lock: none · Schema lock: none

| # | Feature slug | One-line intent | Product metric | Depends on | Touches (entities / screens / shared code) | Arch change? | Batch | Status |
|---|---|---|---|---|---|---|---|---|
| 01 | walking-skeleton | Admin-provisioned staff login (email OTP), office + roles, empty Clients screen, CI, deployed to Mumbai | 5 | — | auth, office, staff_user, layout, CI | yes | — | planned |
| 02 | clients-and-catalogue | Masters (groups, types with default schedules, FY/period); add/edit/archive clients + CSV import; enabling a group copies its types into client instances with own schedule | enabler | 01 | client*, doc_group, doc_type, financial_year, period, client_doc_type; Clients, Add client, Client›Settings, Settings›Catalogue | schema | — | planned |
| 03 | document-intake-and-search | Add document with dimensions from context, DOC-IDs, Inbox, inline "new type" (proposed, client-only); Documents screen filtering on every dimension + facets + text | 1, 3 | 02 | document, document_version, storage; Inbox, Add document, Client›Documents, Documents/Search | schema | — | planned |
| 04 | expected-docs-schedule | Generate expected docs from client instances; due/overdue; link files to expected docs; metric 1 measurable | 1 | 02 | expected_doc, pg_cron; Client›Expected | schema | — | planned |
| 05 | type-governance | Admin review queue for proposed types: approve / edit / map to existing (re-points documents) / reject; audit; in-app notifications | 3 | 03 | doc_type_proposal, notification; Settings›Catalogue, notification centre | schema | — | planned |
| 06 | today-and-reminders | Per-staff Today (overdue, due this week, to review, inbox); "Remind" emails client (SES); "WhatsApp" opens pre-filled chat; both logged | 1, 2 | 03, 04 | follow_up, email; Today, Client›Documents | yes (email provider) | — | planned |
| 07 | review-and-dispatch | Received → reviewed → ready to dispatch → dispatched for originals; history | 1 | 03 | document status, dispatch; drawer | schema | — | planned |
| 08 | bulk-activity-roles | Bulk zip download / bulk mark reviewed, Activity log screen, Users & roles screen with full RLS matrix | 5 | 03 | activity, RLS; Activity, Settings›Users | no | — | planned |

Later: client portal / upload links · automatic scheduled client reminders · AI type suggestions · receipt & dispatch acknowledgement emails · staff nudge emails · retention & archive rules · pause/resume groups · storage quota view · WhatsApp Business intake · multi-office.

## Releases
- **R1 — Pilot (target: as early as possible):** 01–06, used by 2–3 staff on a 20–30 client subset for the monthly GST cycle, then all clients.
- **R2 — Full v1:** 07–08.

## Batches
(filled in by the Parallel planning checkpoint)
