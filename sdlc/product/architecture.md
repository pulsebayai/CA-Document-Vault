# Architecture: CA Document Vault
Status: approved · Updated: 2026-09-25

## Stack
- **Next.js (App Router) + TypeScript** — one codebase for UI and server actions/API routes.
- **Supabase (Postgres + Auth + Storage), region ap-south-1 (Mumbai)** — relational data, row-level security, private file storage in India.
- **Vercel, functions pinned to bom1 (Mumbai)** — preview deploys per PR; no document bytes cached (private bucket, short-lived signed URLs).
- **Email:** Supabase Auth for staff sign-in codes/invites; **client reminder emails via AWS SES ap-south-1** from the firm's domain (SPF/DKIM/DMARC required), Reply-To = assigned staff.
- **Scheduled jobs:** Supabase pg_cron for expected-doc generation and overdue/nudge calculation.
- Tailwind · Vitest + React Testing Library · Playwright · ESLint · GitHub Actions.

## Core entities — dimensional document model
Reference: sdlc/product/references/data-model-v3.md. **No folder hierarchy.** A document is one file + one metadata row; every "folder" view (by client, group, type, FY, period) is a query.

**Five dimensions (master tables; documents store IDs, never free text):** client, doc_group, doc_type, financial_year, period. GSTIN/TAN is an optional *attribute* (`registration_id`), not a dimension.
- `client` (code, name, type, PAN, email, mobile, incharge → staff_user, archived) · `client_registration` (GSTIN/TAN…, state; 1..n) · `client_contact` (reference only)
- `doc_group` (GST, TDS/TCS, Income Tax, Banking, ROC/MCA, Payroll, Audit, Accounting, Registrations, Other; sort, active)
- `doc_type` (→ doc_group, code, name, default frequency, period_kind month|quarter|year|none, status approved|proposed, proposed_by)
- `financial_year` (code 2026-27, start, end)
- `period` (kind month|quarter|year, code, start, end, → financial_year) — generated, never typed

**Document (the fact row)**
- `document` (DOC-ID, client_id, doc_type_id, period_id NULL-able for undated docs e.g. registration certificate, registration_id NULL-able, expected_doc_id NULL-able, file path/name/type/size, received_as soft|hard|original, channel, received_by/on, status, remark, archived) → `document_version`
- **Derived, not stored:** doc_group (from doc_type) and FY (from period). Prevents "type in GST, group = Banking" inconsistencies and makes admin re-mapping of types safe.
- Search = filters on any combination of dimensions + facets (status, received_as, channel, received_by) + text on file name/remark (Postgres full-text + pg_trgm). Composite indexes on (client, period), (doc_type, period).

**Expectation layer (= "collection requirement" in reference doc)**
- **Master templates → client instances.** Master = `doc_group` + its `doc_type`s with default schedule (frequency, ask day, overdue day, reminders on/off). When a group is enabled for a client, its types are **copied** into `client_doc_type` rows (client × doc_type: frequency, schedule, reminders, assigned staff, active/paused, start period). The copy keeps `doc_type_id`, so the dimension stays shared for search, but the schedule is the client's own.
  - Later master edits do **not** silently change existing clients; admin can explicitly "apply to existing clients" (logged).
  - Staff can add a type to one client only (proposed type) — it becomes a `client_doc_type` immediately.
  - `client_doc_type` rows *are* the client's collection plan; `expected_doc` rows are generated from them.
- `expected_doc` (client × doc_type × period [× registration]; ask/overdue dates; status pending|received|waived) — **unit of metric 1**. 1 expected_doc : n documents (e.g. many invoice PDFs for one month).
- **To-do / Today = derived view:** expected_doc with no linked document, filtered by assigned staff and dates. Not stored.

**Operational**
- `office` (one row: name, FY start, DOC-ID prefix/counter, retention, file-size limit, reminder timings)
- `staff_user` (role admin|manager|staff|limited, active)
- `client_group` (client × group: assigned staff, active/paused + remark)
- `dispatch` · `follow_up` (email|whatsapp|phone, sent_by, sent_at, delivery status) — **unit of chasing load** · `activity` (append-only audit)
- **Type governance (pilot):** staff create a new type inline while filing (similarity suggestions via pg_trgm first; never blocks upload) → `doc_type` status=proposed, usable on that client → `doc_type_proposal` (entered value, suggestions shown, user, client, status pending|approved|mapped|rejected, admin comment). Admin review queue: approve · edit & approve · map to existing (re-points all documents, client_doc_types and expected_docs; original value kept in `activity`) · reject. Proposer gets an in-app notification (`notification` table), never a blocking popup.

## Auth & permissions model
- **Staff only.** Admin creates/invites each staff user; no self sign-up. Sign-in by **email one-time code** (Supabase Auth OTP). Deactivating a user revokes access immediately.
- Roles enforced in **Postgres RLS**, not only in UI. Matrix (from mockup): Admin/Manager/Staff see all clients; Limited sees only assigned clients/groups. Manage users → Admin only. Catalogue approvals, incharge changes, pausing → Admin/Manager.
- "Delete" in the mockup = **archive** (reversible, logged). No hard delete from the app.
- Storage bucket private; files served via short-lived signed URLs after an RLS-checked lookup.

## Cross-cutting rules
- **Privacy:** PAN, mobile, email are personal data (DPDP Act). No PII in URLs, logs or analytics.
- **No hard delete;** every mutation writes `activity`.
- **Uploads:** allow-list PDF, JPG, PNG, XLSX, DOCX, ZIP; size limit from settings; filenames sanitised.
- **Dates:** stored UTC, shown IST; periods follow Indian FY.
- **Accessibility:** WCAG 2.1 AA.
- **Errors:** plain user messages; server errors logged with request ID, no PII.

## External integrations
- **AWS SES (Mumbai):** client reminder emails triggered by staff "Remind". Content: which documents are pending for which period; **no attachments, no links into the app, no PAN/GSTIN in the body**. Rate-limited per client; every send logged in `follow_up` + `activity`.
- **WhatsApp (click-to-chat, no API):** "WhatsApp" button opens `https://wa.me/<client mobile>?text=<pending list>` in the staff member's browser (WhatsApp Web/app); the staff member presses Send. Same content rules as email. Logged as `follow_up` channel=whatsapp, status=opened (the vault cannot confirm delivery). Documented exception to the no-PII-in-URLs rule: the client's own mobile number is sent only to WhatsApp, by the staff member's browser, never to our servers/logs.

## Environments & deploy
- `local` (Supabase CLI) → `preview` (Vercel per PR + Supabase staging project, Mumbai) → `production` (Vercel prod + Supabase prod, Mumbai).
- Production deploys and prod migrations only after PR merge to `main`, gated by hook + user confirmation.

## Decision log
| Date | Decision | Reason | Feature |
|---|---|---|---|
| 2026-09-25 | v1 is staff-only; no client login or upload links | Owner decision: scope v1 to the CA office | — |
| 2026-09-25 | WhatsApp reminders via click-to-chat (wa.me), not WhatsApp Business API | Zero cost/approval; staff send from own WhatsApp; API deferred | 05 |
| 2026-09-25 | Only manual reminders in v1; automatic scheduled reminders later | Avoid mass mis-sends before schedule logic is proven | 05 |
| 2026-09-25 | "Remind" sends an email to the client via SES Mumbai; replies go to assigned staff | Owner decision; matches mockup; keeps data in India | 05 |
| 2026-09-25 | Staff accounts admin-provisioned; email OTP sign-in | No self sign-up; no passwords to manage | — |
| 2026-09-25 | Single office, single tenant | Own-firm-first; avoid multi-tenancy before validation | — |
| 2026-09-25 | Data in Supabase ap-south-1; Vercel functions bom1 | India data residency | — |
| 2026-09-25 | Dimensional document model: 5 dimensions (client, group, type, FY, period); GSTIN/TAN optional attribute; no folder hierarchy; group & FY derived | Multiple views/search over one file; consistent master data | 02–03 |
| 2026-09-25 | Master templates copied into per-client instances (`client_doc_type`); no silent propagation | Each client's schedule is tracked independently; owner requirement | 02 |
| 2026-09-25 | Staff-proposed types + admin governance in pilot; similarity matching, no AI in v1 | CA expects ~60% of types to be added in use; AI deferred for cost/residency | 03, 05 |
| 2026-09-25 | Archive instead of delete | Audit trail and record-retention obligations | — |
| 2026-09-25 | Configurable catalogue + timings; fixed status workflow | Configurability where firms differ, without a workflow builder | — |
