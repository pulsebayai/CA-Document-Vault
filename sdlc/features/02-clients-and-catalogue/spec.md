# Spec: Clients and document catalogue
Intent: ./intent.md · Status: draft · Date: 2026-09-26
Screens: references/mockup/03-clients.jpg, 05-settings-catalogue.jpg, 11-client-settings.jpg · Seed data: ./seed-catalogue.md

## Key definitions
- **Catalogue type = a document the firm collects or keeps** (e.g. "Sales invoices", "Bank statement", "Form 16"), not a return the firm files. Its schedule says **when the firm needs it from the client**, so the overdue day is set *before* the related statutory due date (see seed-catalogue.md).
- **Schedule offsets** are counted from the **end of the period**: `ask = +A months, day a` and `overdue = +O months, day o` (day clamped to month end). The same offsets work whether a client collects monthly, quarterly or yearly. 04 turns them into dates; 02 only stores them.
- **Period kinds:** month, quarter (FY quarters: Q1 = Apr–Jun), year (FY). Frequency options: monthly · quarterly · yearly · as needed (no expected docs).

## User stories & acceptance criteria
**Catalogue (Settings › Document catalogue; Admin + Manager)**
- AC-1 Given a fresh office, the catalogue shows the seeded groups (GST, TDS/TCS, Income Tax, Banking, ROC/MCA, Payroll, Audit, Accounting, Registrations, Other) and types from seed-catalogue.md, each with frequency, ask/overdue offsets and reminders on/off.
- AC-2 Admin/Manager can add a type to a group, rename it, change its default frequency/schedule/reminders, set aliases, and deactivate/reactivate it; names are unique per group (case-insensitive). Deactivated types are not offered for new plans but stay on existing clients.
- AC-3 Admin/Manager can add, rename, reorder and deactivate groups, and toggle **"Enabled for new clients"** per group (mockup 05).
- AC-4 Changing a master type's default schedule **does not** change any existing client's `client_doc_type` (verified by test); the screen says so ("Existing clients keep their own schedule").
- AC-5 FY 2025-26 and 2026-27 exist with their 12 months, 4 FY quarters and 1 year each. Admin can "Add next financial year", which generates the next FY and its periods; a duplicate FY is rejected.
- AC-6 Staff and Limited see the catalogue read-only; server actions and RLS reject their writes.

**Clients (list, add, edit, archive)**
- AC-7 `/clients` lists active clients (mockup 03): name; line 2 = type · PAN · Incharge · enabled groups; "N clients" count. Search matches name, code, PAN, GSTIN, previous reference (case-insensitive, partial). Filters: Type, Incharge, "Show archived". **Search text and filter values are never put in the URL.** "Has overdue" and the right-hand overdue text are hidden until 04.
- AC-8 Staff+ can add a client: name*, client type* (11 values), PAN (optional; format `AAAAA9999A`; unique per office among non-archived clients), previous reference (optional, free text ≤ 60, not unique), email, mobile (10-digit Indian), incharge* (active staff), 0..n registrations (GSTIN or TAN + state), and groups to enable (pre-ticked from "Enabled for new clients"). The vault assigns the next code (`C0001`, `C0002` …, per office, never reused, not editable).
- AC-9 Validation: PAN's 4th letter must match the client type (P Individual/Proprietorship, H HUF, F Partnership/LLP, C Private/Public Ltd, T Trust, A AOP/BOI/Society/Co-operative — society/co-op warn only); GSTIN is 15 chars, state code from the first 2 digits, and chars 3–12 must equal the client's PAN; TAN format `AAAA99999A`. Errors are inline and announced to screen readers.
- AC-10 Staff+ can edit client details and registrations. Changing incharge is Admin/Manager only (field disabled for others; server rejects).
- AC-11 Admin/Manager can archive and unarchive a client (confirm dialog, reason optional). Archived clients leave the default list and keep all data. PAN uniqueness applies to non-archived clients; unarchiving is blocked (clear message) if another active client now has the same PAN. No delete anywhere; DB rejects DELETE.
- AC-12 Limited users see only clients where they are incharge or assigned to an enabled group; direct URL to another client shows Not Found; RLS returns 0 rows.

**CSV import (Clients › Import CSV; Staff+)**
- AC-13 "Download template" gives a CSV with header: `name,client_type,pan,previous_reference,email,mobile,incharge_email,gstins,tans,groups` (multi-values separated by `;`) and one synthetic example row.
- AC-14 Uploading a file (≤ 1 MB, ≤ 2,000 rows, UTF-8, header must match) shows a **preview**: total / valid / error / duplicate counts and a per-row table with each error in plain words (row number, column, problem). Nothing is written yet.
- AC-15 Rows whose PAN matches an existing non-archived client, or a PAN earlier in the same file, are marked **Duplicate — skipped**. Rows without PAN but with the same name as an existing client are **warnings** (importable).
- AC-16 "Import N valid rows" creates those clients, their registrations and enabled groups (with type instances, AC-19) in one transaction per 200 rows, assigns codes in file order, and shows a result summary with "Download error rows" (CSV of rejected rows + reason). Re-uploading the corrected error file works.
- AC-17 Import of 1,000 rows completes in < 60 s on dev.

**Client collection plan (Client › Settings; mockup 11)**
- AC-18 `/clients/[id]` shows the client header (name, type, PAN, GSTIN count, incharge, email, mobile), a client card with Edit, and tabs; in 02 only **Settings** is active (Documents/Expected/Activity appear with 03/04/08).
- AC-19 Enabling a group for a client copies every **active** master type in that group into `client_doc_type` rows with the master's frequency, offsets and reminders, start period = the current period for that frequency, assigned staff = the group's assignee (default: incharge).
- AC-20 Per group: assign staff, and **pause/resume** with a remark (Admin/Manager only). Per type: change frequency, reminders on/off, assigned staff override, start period; **remove** (doesn't apply) or restore (Staff+); **pause/resume** (Admin/Manager). "+ Add type to <group>" offers active master types of that group not yet on the client.
- AC-21 Disabling a group sets it and its types to removed (history kept); re-enabling restores the previous rows rather than creating duplicates, and adds any master types added since.
- AC-22 Setting up one client's plan (enable 3 groups, remove 4 types, change 1 frequency) takes ≤ 2 minutes for a staff member (timed manual check, recorded in the PR).

**Audit**
- AC-23 Every create/update/archive/unarchive/import/enable/disable/pause/resume on clients, registrations, groups, types, FYs and plans writes an `activity` row (actor, action, entity, changed fields). Activity data **never contains PAN, email, mobile or GSTIN values** — only field names and IDs.

## Functional requirements
- Server actions validate with zod (shared schemas for form + CSV); DB constraints and RLS enforce the same rules.
- Client code: `office.client_code_counter`, incremented in a `security definer` function inside the insert transaction (no gaps from concurrent inserts matter; never reused).
- CSV parsed in the browser (Papa Parse) for preview; the server re-validates every row before insert (never trust the preview). File content is not stored.
- GSTIN state list (37 codes) is a static TS map; state is derived, not typed.
- "Enabled for new clients" only affects the Add client/Import defaults.

## Non-functional requirements
- **Security/privacy:** RLS default-deny on every new table; `office_id` on each; no PII in URLs, logs, analytics, activity data or error messages sent to the browser for other rows; fixtures use synthetic PANs (`AAAPZ9999Z`-style patterns reserved for tests) and `.test` emails.
- **Performance:** `/clients` with 1,000 clients renders first page < 1 s server time; list paginated (50) with search via trigram index.
- **Accessibility:** WCAG 2.1 AA; toggles are real switches with labels; preview table has headers and row numbers; errors linked via `aria-describedby`.

## Data model changes (schema lock: 02)
New enums: `client_type` (11 values), `frequency` (monthly, quarterly, yearly, as_needed), `period_kind` (month, quarter, year, none), `plan_state` (active, paused, removed), `registration_kind` (gstin, tan).
- `office` + `client_code_counter int not null default 0`.
- `client` (id, office_id, code unique per office, name, client_type, pan null, previous_reference null, email null, mobile null, incharge_id → staff_user, archived_at null, archived_by, created_by/at, updated_at). Partial unique `(office_id, pan) where archived_at is null`. Trigram indexes on name, previous_reference.
- `client_registration` (id, office_id, client_id, kind, number, state_code, active). Unique `(office_id, number)`.
- `client_contact` (id, office_id, client_id, name, role, email, mobile) — reference only, not in UI yet.
- `doc_group` (id, office_id, code, name, sort, active, enabled_for_new_clients).
- `doc_type` (id, office_id, doc_group_id, code, name, aliases text[], period_kind, default_frequency, ask_after_months 0–12, ask_day 1–31, overdue_after_months 0–12, overdue_day 1–31, registration_kind null|gstin|tan, reminders bool, status approved|proposed (only approved in 02), proposed_by null, active). Unique `(doc_group_id, lower(name))`. Check: overdue ≥ ask.
- `financial_year` (id, office_id, code `2026-27`, start_date, end_date). Unique `(office_id, code)`.
- `period` (id, office_id, financial_year_id, kind, code `2026-06` / `2026-27-Q1` / `2026-27`, label, start_date, end_date). Unique `(office_id, kind, code)`.
- `client_group` (id, office_id, client_id, doc_group_id, assigned_staff_id, state, remark, paused_at). Unique `(client_id, doc_group_id)`.
- `client_doc_type` (id, office_id, client_id, doc_type_id, client_group_id, frequency, ask/overdue offsets, reminders, assigned_staff_id null, start_period_id, state, remark, paused_at). Unique `(client_id, doc_type_id)`.
- Helper `private.can_see_client(client_id)`: active staff of office AND (role ≠ limited OR incharge OR assigned on an active client_group/client_doc_type).
- RLS: masters — select all active staff; write Admin/Manager. client/* — select via `can_see_client`; insert/update Staff+ (not Limited); incharge/archived/paused columns Admin/Manager (column grants + trigger check). DELETE: no policy + `forbid_delete` trigger on all new tables.
- Seed migration: groups, types (seed-catalogue.md), FY 2025-26 + 2026-27 with periods, for the existing office. Test offices get the same seed via a function `private.seed_catalogue(office_id)`.

## Existing code affected
- `src/app/(app)/clients/page.tsx` (empty state → list) and `tests/unit/clients-page.test.tsx` (the empty-state test **stays**; it still applies with 0 clients).
- App nav/Settings sub-nav: add "Document catalogue". Test data helpers: add client/catalogue fixtures.

## Backward compatibility & data migration
Only the dev DB exists; no real data. Migrations are additive. The office row gains a counter column with default 0.

## API / interfaces
- Routes: `/clients`, `/clients/new`, `/clients/[id]` (Settings tab), `/clients/import`, `/settings/catalogue`.
- Server actions: `createClient`, `updateClient`, `archiveClient`, `unarchiveClient`, `previewImport` (validation only), `importClients`, `enableGroup`, `disableGroup`, `updateClientGroup`, `updateClientDocType`, `addClientDocType`, `upsertDocGroup`, `upsertDocType`, `addFinancialYear`.

## UX flows & screens
- Clients list per mockup 03 (Import CSV, Add client; **Export hidden** — deferred to 08). Empty state keeps "No clients yet" with Add/Import buttons.
- Add client: single page form, groups as checkboxes at the bottom; on save → `/clients/[id]` Settings.
- Import: 3 steps — upload → preview (counts + table, filter "errors only") → result.
- Client › Settings per mockup 11, minus "Send upload link" (deviation already agreed) and "History" links (activity viewer = 08). Client reminders card shows the toggle read-only text "Reminders arrive with feature 06".
- Catalogue per mockup 05 minus the "Proposed by staff" panel (05). "Used by N clients" = count of active client_doc_types.
- Every screen: empty, loading (skeleton), error (banner + retry) states.

## Test strategy
| AC | Test | Suite |
|---|---|---|
| 1, 5 | seed present; periods count 2×17; add-FY; duplicate rejected | RLS/DB |
| 2, 3, 6 | catalogue writes by admin/manager OK; staff/limited rejected | RLS/DB + e2e (admin edits a type) |
| 4 | edit master schedule → client_doc_type unchanged | RLS/DB |
| 7 | list, search by PAN/GSTIN/prev ref; URL contains no query text | e2e |
| 8, 9 | zod schemas: PAN/GSTIN/TAN/mobile/type-letter rules; code sequence | unit + e2e add client |
| 10, 11 | incharge change & archive role rules; DELETE rejected | RLS/DB |
| 12 | limited sees only assigned; Not Found on direct URL | RLS/DB + e2e |
| 13–16 | CSV parser/validator (dupes in file, dupes in DB, bad header, size/rows limits) | unit + e2e import happy path + error file |
| 17 | 1,000-row synthetic import timing | DB (tagged, cleaned up) |
| 18–21 | enable copies active types; disable/re-enable no duplicates; pause role rules | RLS/DB + e2e enable group |
| 22 | timed manual check | manual (PR) |
| 23 | activity rows written; no PII values in `data` | RLS/DB |
- All new tests join the regression suite. **Smoke-safe for prod:** none added (all write data); smoke stays read-only.
- Fixtures: reusable "e2e office" gets catalogue via `seed_catalogue`; clients created per run tagged by RUN_TAG in `previous_reference` and purged at run start.

## Proposed architecture changes
1. `doc_type` schedule = month/day **offsets from period end** (`ask_after_months, ask_day, overdue_after_months, overdue_day`) instead of a single "ask day / overdue day". Reason: one rule for monthly, quarterly and yearly types.
2. `doc_type.aliases text[]` — old and new form names (Income-tax Act 2025 renumbered TDS forms from 1 Apr 2026, e.g. Form 16 → Form 130, 24Q → 138) so 03's type search finds either.
3. `client_group` / `client_doc_type` use a 3-state `plan_state` (active / paused / removed): "removed" = doesn't apply (Staff), "paused" = temporary stop (Admin/Manager, per architecture).
4. Client code vault-generated; `previous_reference` attribute (intent decisions 2, 6).
5. `doc_type.registration_kind` (gstin | tan | null): marks types collected **per registration** (GST types → per GSTIN, TDS types → per TAN), so 04 generates one expected doc per active registration, as architecture's `expected_doc [× registration]` already implies. Seeded for GST and TDS/TCS types.
(Architecture lock is not held by anyone; 02 takes it for these five lines, applied at merge.)

## Risks & areas of concern
- **Seed schedules are generic** [Likely wrong for some clients] — e.g. QRMP clients file GSTR-1 by the 13th, not 11th. Mitigation: offsets are per client; CA reviews the seed table before build (see gate question).
- **PAN–type letter check may block edge cases** (e.g. government bodies, "G"/"L"/"J") → those map to warn-only, never block.
- **CSV import writes lots of rows to the shared dev DB in tests** → tagged + purged; 1,000-row test runs only in nightly, not every PR (flagged in plan).
- **Scope is at the 2-week edge** (intent decision 6) — plan will show day estimates; if > 10 days, CSV error-file download and aliases are the first to defer.

## Out of scope
Documents/uploads (03) · expected-doc generation, due/overdue, "Has overdue" filter (04) · proposed types + review queue (05) · reminders and client reminder toggle behaviour (06) · client export, activity viewer, History links (08) · "apply master change to existing clients" (later; decided at spec — manual per client for now) · client contacts UI · flexible CSV column mapping.
