# Architecture: CA Document Vault
Status: approved · Updated: 2026-09-28 (03: document intake, via PR #7)

## Stack
- **Next.js (App Router) + TypeScript** — one codebase for UI and server actions/API routes.
- **Supabase (Postgres + Auth + Storage), region ap-south-1 (Mumbai)** — relational data, row-level security, private file storage in India.
- **Vercel, functions pinned to bom1 (Mumbai)** — preview deploys per PR; no document bytes cached (private bucket, short-lived signed URLs).
- **Email:** Supabase Auth for staff sign-in codes/invites (dev: custom SMTP via dedicated Gmail `cadocvault.dev@gmail.com`; staging/prod: SES); **client reminder emails via AWS SES ap-south-1** from the firm's domain (SPF/DKIM/DMARC required), Reply-To = assigned staff.
- **Scheduled jobs:** Supabase pg_cron for expected-doc generation and overdue/nudge calculation.
- Tailwind · Vitest + React Testing Library · Playwright · ESLint · GitHub Actions.

## Core entities — dimensional document model
Reference: sdlc/product/references/data-model-v3.md. **No folder hierarchy.** A document is one file + one metadata row; every "folder" view (by client, group, type, FY, period) is a query.

**Five dimensions (master tables; documents store IDs, never free text):** client, doc_group, doc_type, financial_year, period. GSTIN/TAN is an optional *attribute* (`registration_id`), not a dimension.
- `client` (code, name, type, PAN, email, mobile, incharge → staff_user, archived) · `client_registration` (GSTIN/TAN…, state; 1..n) · `client_contact` (reference only)
- `doc_group` (GST, TDS/TCS, Income Tax, Banking, ROC/MCA, Payroll, Audit, Accounting, Registrations, Other; sort, active)
- `doc_type` (→ doc_group, code, name, default frequency, period_kind month|quarter|year|none, status approved|proposed, proposed_by)
  - **Schedule = offsets from period end** (`ask_after_months, ask_day, overdue_after_months, overdue_day`): one rule for monthly, quarterly and yearly collection (02).
  - `source client|firm`: the catalogue is what the firm needs *from the client*; **firm records** (returns filed, acknowledgements) are `firm` — no schedule, never copied into a plan (02).
  - `aliases text[]` (old/new form names, e.g. Form 16 ↔ Form 130) · `registration_kind gstin|tan|null`: collected per registration (04 generates one expected doc per active GSTIN/TAN) (02).
- `client.code` is vault-generated (`C0001…`, per-office counter, never reused); `previous_reference` holds the firm's old code. PAN unique among non-archived clients; once a GSTIN with that PAN exists the PAN is fixed (archive + re-add) (02).
- `financial_year` (code 2026-27, start, end)
- `period` (kind month|quarter|year, code, start, end, → financial_year) — generated, never typed

**Document (the fact row)**
- `document` (DOC-ID, client_id, doc_type_id, period_id NULL-able for undated docs e.g. registration certificate, registration_id NULL-able, expected_doc_id NULL-able (04), received_as soft copy|hard copy|original, channel WhatsApp|Email|Hand delivery|Courier|Portal download|Other, received_by/on, status, remark, classified_at, archived) → `document_version` (append-only: storage path, sanitised file name, type, size, uploader; the newest is current, same DOC-ID) (03)
  - **DOC-ID = `DOC-FY26-27-00001`**: per-office counter (`doc_counter`) per FY of the date the document is **added** (IST), restarts 1 April, no gaps, never reused or edited (03).
  - **Classified** = client + type; otherwise the document is in the **Inbox**. `classified_at` is set once (metric 4) (03).
- **Derived, not stored:** doc_group (from doc_type) and FY (from period). Prevents "type in GST, group = Banking" inconsistencies and makes admin re-mapping of types safe.
- Search = filters on any combination of dimensions + facets (status, received_as, channel, received_by) + text on file name/remark (Postgres full-text + pg_trgm). Composite indexes on (client, period), (doc_type, period).

**Expectation layer (= "collection requirement" in reference doc)**
- **Master templates → client instances.** Master = `doc_group` + its `doc_type`s with default schedule (frequency, ask day, overdue day, reminders on/off). When a group is enabled for a client, its types are **copied** into `client_doc_type` rows (client × doc_type: frequency, schedule, reminders, assigned staff, active/paused, start period). The copy keeps `doc_type_id`, so the dimension stays shared for search, but the schedule is the client's own.
  - Later master edits do **not** silently change existing clients; admin can explicitly "apply to existing clients" (logged).
  - Staff+ (not Limited) can add a type to one client only (proposed type, after the closest existing types are suggested) — it becomes a `client_doc_type` immediately (as needed, no reminders); if the group isn't enabled for that client, a client group row is created holding only that type. Proposed names are unique per group per client (05 merges) (03).
  - `client_doc_type` rows *are* the client's collection plan; `expected_doc` rows are generated from them.
- `expected_doc` (client × doc_type × period [× registration]; ask/overdue dates; status pending|received|waived) — **unit of metric 1**. 1 expected_doc : n documents (e.g. many invoice PDFs for one month).
- **To-do / Today = derived view:** expected_doc with no linked document, filtered by assigned staff and dates. Not stored.

**Operational**
- `office` (one row: Kushal Associates, branch Pondicherry; name, FY start, DOC-ID prefix/counter, retention, file-size limit, reminder timings)
- `staff_user` (role admin|manager|staff|limited, active)
- `client_group` (client × group: assigned staff, active/paused + remark) · `client_group` / `client_doc_type` use a 3-state `plan_state`: active · paused (temporary stop, Admin/Manager) · removed (doesn't apply, Staff+; history kept; re-enable restores each row's previous state) (02)
- `office.is_test` marks automated-test offices; `reset_test_office` (service role only) purges them — the one exception to "no hard delete", refused for any other office (02)
- `dispatch` · `follow_up` (email|whatsapp|phone, sent_by, sent_at, delivery status) — **unit of chasing load** · `activity` (append-only audit)
- **Type governance (pilot):** staff create a new type inline while filing (similarity suggestions via pg_trgm first; never blocks upload) → `doc_type` status=proposed, usable on that client → `doc_type_proposal` (entered value, suggestions shown, user, client, status pending|approved|mapped|rejected, admin comment). Admin review queue: approve · edit & approve · map to existing (re-points all documents, client_doc_types and expected_docs; original value kept in `activity`) · reject. Proposer gets an in-app notification (`notification` table), never a blocking popup.

## Auth & permissions model
- **Staff only.** Admin creates/invites each staff user; no self sign-up. Sign-in by **email one-time code** (Supabase Auth OTP). Deactivating a user revokes access immediately.
- Roles enforced in **Postgres RLS**, not only in UI. Matrix (from mockup): Admin/Manager/Staff see all clients; Limited sees only assigned clients/groups. Manage users → Admin only. Catalogue approvals, incharge changes, pausing → Admin/Manager.
- "Delete" in the mockup = **archive** (reversible, logged). No hard delete from the app.
- **Assignment decides what Limited users see**, so assigning staff (group or type), changing the incharge, pausing/resuming and switching off a paused group are Admin/Manager only (DB triggers). A group follows the incharge: when the incharge changes, groups still assigned to the old incharge move to the new one (logged) (02).
- Settings is visible to all staff; each item is role-gated (catalogue writes Admin/Manager, users Admin) (02).
- The service role cannot write `client` rows (CHECK helpers are `authenticated`-only); tests and tools create clients as a signed-in user (02).
- **Documents (03):** visible if the user can see the client (`can_see_client`), or unclassified and (Staff+ or added it). Limited users add/edit only for clients they can see or into the Inbox. Archive/unarchive Admin/Manager (reason required); archived documents are read-only.
- **Files (03):** bucket `documents` private (25 MB, MIME allow-list), **no `storage.objects` policies for app roles**. Upload: server issues a signed upload URL for `office/<office>/doc/<document>/<version>.<ext>` (IDs only) → the browser PUTs the raw file with our canonical Content-Type → the DB registers it, **reading size and type from `storage.objects` itself** (the RPCs are callable directly). View/download: a ≤ 60 s signed URL issued server-side after an RLS lookup; only `src/lib/documents/storage.ts` signs (service role, ESLint allow-list).

## Cross-cutting rules
- **Privacy:** PAN, mobile, email are personal data (DPDP Act). No PII in URLs, logs or analytics.
- **No hard delete;** every mutation writes `activity`.
- **Uploads:** allow-list PDF, JPG/JPEG, PNG, HEIC (download-only), XLSX, XLS, CSV, DOCX, ZIP by extension (declared type checked when present); ≤ 25 MB; each extension stored as one canonical MIME type (`src/lib/validation/document.ts` = `private.mime_for_extension` = bucket allow-list); file names sanitised (no separators/control chars/leading dots, ≤ 180). No malware scan or content sniffing in v1 (accepted risk) (03).
- **Dates:** stored UTC, shown IST; periods follow Indian FY.
- **UI:** the mockup is the UI source of truth — see `references/ui-reference.md` (tokens, components, agreed deviations, screenshots). Each feature spec cites its screens.
- **Accessibility:** WCAG 2.1 AA (wins over pixel fidelity).
- **Errors:** plain user messages; server errors logged with request ID, no PII.
- **Data-access patterns (02):**
  - Multi-row/multi-table writes = **one SECURITY INVOKER SQL function per user action** (atomic, RLS applies, writes one `activity` row). Single-row edits log activity from the server action (best-effort).
  - UI aggregates and PII searches = security-invoker views/functions (e.g. `search_clients`), called from server actions (POST) so search text never reaches a URL.
  - SECURITY DEFINER only for counters/guards; every definer trigger checks the tenant (office) first; `search_path = ''` everywhere. Service-role-only helpers live in `public` with EXECUTE revoked (PostgREST can't reach `private`).
  - Transaction flags (`app.plan_bulk`, `app.purge_office`, 03: `app.doc_version`, `app.propose_type`, `app.doc_clock`) let the owning functions bypass per-row checks; nothing else sets them. `app.doc_clock` (fixed-date DOC-ID tests) is honoured only in `is_test` offices.
- **Activity:** field names and IDs only; free text (e.g. archive reason) lives on the entity. A DB trigger (`ACTIVITY_PII`) rejects PAN/GSTIN/email/mobile keys or values in `activity.data` (02).
- **Bulk work** (CSV import): the browser drives bounded chunks (≤ 200 rows per server action); the server re-validates every chunk against the DB as it is now. Server-action body limit 3 MB. CSV files we generate neutralise formula-looking cells (02).
- **Screens:** every screen has its own loading (`role="status"`) and error (alert + retry) state (`src/components/states.tsx`); dialogs use the shared native-`<dialog>` Modal; horizontal-scroll wrappers are `position: relative` (sr-only content escapes otherwise); key screens are asserted ≤ 390 px wide in e2e (02).

## External integrations
- **AWS SES (Mumbai):** client reminder emails triggered by staff "Remind". Content: which documents are pending for which period; **no attachments, no links into the app, no PAN/GSTIN in the body**. Rate-limited per client; every send logged in `follow_up` + `activity`.
- **WhatsApp (click-to-chat, no API):** "WhatsApp" button opens `https://wa.me/<client mobile>?text=<pending list>` in the staff member's browser (WhatsApp Web/app); the staff member presses Send. Same content rules as email. Logged as `follow_up` channel=whatsapp, status=opened (the vault cannot confirm delivery). Documented exception to the no-PII-in-URLs rule: the client's own mobile number is sent only to WhatsApp, by the staff member's browser, never to our servers/logs.

## Release & regression policy (every release)
Regression = the **whole** suite (unit, RLS, e2e) — tests accumulate feature by feature and are never edited to pass.
1. **Every PR:** full suite in CI against dev (`ci.yml`). Merge only when green. Each PR description carries the AC → test → result table.
2. **Nightly:** `regression.yml` runs the full suite against dev at 01:30 IST; failure emails the owner. Catches drift (settings, paused DB, expired secrets).
3. **Every release (R1, R2 …) — gate before prod:**
   a. `main` green · b. `regression.yml` (manual run) **passes against staging's deployed URL** · c. manual checklist signed off on staging (key screens vs mockup + one real end-to-end path) · d. owner approval in chat.
   Prod after deploy: **smoke only** (`smoke.spec.ts`: login page, CSP, redirects) — no data-writing tests ever run against prod.
4. **Evidence (kept):** every CI/regression run uploads machine-readable results (JUnit XML + Playwright JSON/HTML) as artifacts (90-day retention). For each release, a record `sdlc/releases/<Rn>.md` is committed with: commit SHA, environment, run URLs, pass/fail/skipped counts per suite, AC coverage, manual checklist results, sign-off (name, date) — plus the result summaries copied to `sdlc/releases/<Rn>/evidence/` so evidence outlives artifact retention.

## Environments & deploy
- Supabase projects, all org Pulsebay, ap-south-1, named `<env> - CA Document Vault`:
  - **dev** — "dev - CA Document Vault" (ref `ysddbwskljzhbjjohool`, created 2026-09-25). Synthetic test data only. **Exists now.**
  - **staging** — "staging - CA Document Vault". Created before the pilot; migrations rehearsed here first.
  - **prod** — "prod - CA Document Vault". Created before the pilot starts; the only place real client data (PAN, GSTIN, files) ever lives.
  - **Never use the older "CA Doc Vault Project" (ukbpwhxqflksmgrhrfbc)** — unrelated, owner-managed.
- Flow: `dev` (Vercel preview per PR + hosted dev DB; all automated tests run here — no local Supabase/Docker) → `staging` → `prod` (Vercel prod + prod DB, Mumbai).
- Production deploys and prod migrations only after PR merge to `main`, gated by hook + user confirmation.

## Decision log
| Date | Decision | Reason | Feature |
|---|---|---|---|
| 2026-09-25 | v1 is staff-only; no client login or upload links | Owner decision: scope v1 to the CA office | — |
| 2026-09-25 | WhatsApp reminders via click-to-chat (wa.me), not WhatsApp Business API | Zero cost/approval; staff send from own WhatsApp; API deferred | 06 |
| 2026-09-25 | Only manual reminders in v1; automatic scheduled reminders later | Avoid mass mis-sends before schedule logic is proven | 06 |
| 2026-09-25 | "Remind" sends an email to the client via SES Mumbai; replies go to assigned staff | Owner decision; matches mockup; keeps data in India | 06 |
| 2026-09-25 | Staff accounts admin-provisioned; email OTP sign-in | No self sign-up; no passwords to manage | — |
| 2026-09-25 | Single office, single tenant | Own-firm-first; avoid multi-tenancy before validation | — |
| 2026-09-25 | Data in Supabase ap-south-1; Vercel functions bom1 | India data residency | — |
| 2026-09-25 | Dimensional document model: 5 dimensions (client, group, type, FY, period); GSTIN/TAN optional attribute; no folder hierarchy; group & FY derived | Multiple views/search over one file; consistent master data | 02–03 |
| 2026-09-25 | Master templates copied into per-client instances (`client_doc_type`); no silent propagation | Each client's schedule is tracked independently; owner requirement | 02 |
| 2026-09-25 | Staff-proposed types + admin governance in pilot; similarity matching, no AI in v1 | CA expects ~60% of types to be added in use; AI deferred for cost/residency | 03, 05 |
| 2026-09-25 | Separate Supabase projects per env (dev now; staging + prod before pilot), named `<env> - CA Document Vault`; real client data only in prod; older CA Doc Vault project off-limits | Owner decision; isolation of real client data from test data | 01 |
| 2026-09-25 | No local Supabase; tests run against hosted dev with tagged data + serialised CI; staging mandatory before prod | Owner decision: avoid Docker; staging is the migration rehearsal | 01 |
| 2026-09-25 | `office_id` on every business table | Cheap now; avoids migration if multi-office/branch comes | 01 |
| 2026-09-25 | Auth: email link + code (accept 6–8 digits); per-env SMTP (dev Gmail App Password, prod SES); nonce-based CSP in proxy | Supabase default email limits; new projects use 8-digit OTP; defence against injected scripts | 01 |
| 2026-09-25 | Tests run against hosted dev with reusable fixture users on reserved `.test` domain; app never emails `.test` | Protect the email quota; keep dev DB clean | 01 |
| 2026-09-25 | Release & regression policy: full suite per PR, nightly on dev, staging gate + manual checklist per release, prod smoke-only, evidence committed per release | Owner requirement: every release regression-tested with stored evidence | — |
| 2026-09-25 | Archive instead of delete | Audit trail and record-retention obligations | — |
| 2026-09-25 | Configurable catalogue + timings; fixed status workflow | Configurability where firms differ, without a workflow builder | — |
| 2026-09-26 | Catalogue = documents the firm needs *from the client*; firm records separate (`doc_type.source`); schedules as offsets from period end; `aliases`; `registration_kind`; 3-state plan; vault-generated client code + `previous_reference` | One schedule rule for all frequencies; Income-tax Act 2025 form renumbering; per-GSTIN/TAN collection in 04 (spec 02, approved) | 02 |
| 2026-09-26 | `office.is_test` + service-role-only reset for test offices | Clients can't be deleted, but nightly tests would otherwise grow dev by ~1,000 clients/night (D2) | 02 |
| 2026-09-27 | DB-level `ACTIVITY_PII` guard; assignment is Admin/Manager only; re-enable restores previous states | Defence in depth for DPDP; assignment controls Limited visibility (S1–S3) | 02 |
| 2026-09-27 | One SECURITY INVOKER function per multi-row action; searches via server actions + security-invoker functions | Atomic writes with one audit row; RLS always applies; no PII in URLs | 02 |
| 2026-09-27 | CSV import: browser-driven ≤ 200-row chunks, server re-validates; body limit 3 MB | Small requests, progress, no long serverless calls; never trust the preview | 02 |
| 2026-09-28 | Incharge change moves groups that followed the old incharge; switching off a paused group is Admin/Manager only; plan periods must be the office's own | Pre-PR review of 02: Limited ex-incharge kept access; Staff could bypass a pause | 02 |
| 2026-09-28 | Browser uploads straight to private Storage via a server-issued signed URL (raw PUT, canonical type); the DB reads size/type from `storage.objects`; no Storage policies for app roles; ≤ 60 s signed view/download links after an RLS lookup | 25 MB files can't pass through Vercel functions; one authorisation point (RLS on `document`); RPCs are callable directly, so the DB must not trust caller-supplied file facts | 03 |
| 2026-09-28 | DOC-ID `DOC-FY26-27-NNNNN`, per office per FY of the date added, restart 1 April; no date/time in the ID | Readable by CA staff (FY, not a bare year); intake IDs (Raja) | 03 |
| 2026-09-28 | Proposed types: Staff+ create after suggestions; join the client's plan at once (client-only group row if needed); names unique per group per client; approval in 05 | ~60% of types expected to be added in use; filing never blocked; Limited can't change plans | 03 |
| 2026-09-28 | Received as = soft copy · hard copy · original; channels WhatsApp · Email · Hand delivery · Courier · Portal download · Other | Original = must be returned (07 dispatch) | 03 |
| 2026-09-28 | UI token `--warn` darkened #B0611A → #9C5717 | 4.06:1 on `--warn-soft` failed WCAG AA (axe, Hard copy badge) | 03 |

