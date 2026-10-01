# Spec: Expected documents & schedule
Intent: ./intent.md · Status: approved (Raja 2026-09-29) · Date: 2026-09-29
Screens: references/mockup/10-client-documents.jpg (due/overdue rows, "Expected N" tab), 03-clients.jpg ("Has overdue", right-hand overdue text), 01-today.jpg (row wording only; the Today screen itself is 06). Remind / Mark reviewed / Mark dispatched stay hidden (06/07).

## Key definitions
- **Plan row** = a `client_doc_type` (02) that is **scheduled**: frequency monthly/quarterly/yearly, `source = client`, with offsets. "As needed" rows, firm records and proposed types (as needed) never produce expected documents.
- **Expected document** = one plan row × one period of the row's frequency (month/quarter/FY) [× one registration, when the type's `registration_kind` is gstin/tan]. It is the **unit of metric 1**.
- **Ask date** = period end + `ask_after_months` months, on `ask_day` (clamped to that month's last day). **Overdue from** = the same with `overdue_after_months`/`overdue_day`. **Due by** = the day before *overdue from*. All dates are IST calendar dates. Example: Sales invoices, +1/1 and +1/5, period Sep 2026 → ask 1 Oct, due by 4 Oct, overdue from 5 Oct.
- **Stored status:** `pending` · `received` · `waived`. **Shown state** (derived, never stored): *Due* (pending, today < overdue from) · *Overdue* (pending, today ≥ overdue from) · *On hold* (pending, plan row paused) · *Received* · *Not needed* (waived).
- **Generated** = an expected document exists once its **ask date has arrived** (today IST ≥ ask date) and its period is on or after the row's **start period**. Nothing exists for future asks (no "upcoming" rows — see Proposed architecture changes 4).
- **Linked document** = a classified, non-archived document with the same client + type + period (+ registration). A document with **no** registration for a per-registration type links to the item of the client's registration of that kind **only when the client has exactly one active one**; with two or more it does not link (Raja 2026-09-30, option b). **Received** = at least one linked document; **received on** = the *received on* date of the document that completed it.
- **On time** (metric 1) = received on < overdue from. Denominator: expected documents whose *overdue from* date has passed, excluding waived, on-hold and archived-client items.
- **Earliest still-open period** (intent Q1) = the earliest period of the row's frequency whose *overdue from* is after today, among the periods the office has.

## User stories & acceptance criteria
**Generation**
- AC-1 A daily job (00:15 IST) creates every missing expected document for every office: for each active scheduled plan row, each period from the row's start period whose ask date ≤ today [× each active registration of the type's kind]. Re-running creates nothing new (unique client × type × period × registration). No rows for paused/removed plan rows, as-needed/firm/proposed types or archived clients.
- AC-2 Plan changes take effect **immediately** (same transaction, no waiting for the job): enabling a group/type, resuming, changing a start period, adding/reactivating a registration. Schedule edits (offsets) recompute ask/overdue dates of that row's **pending** items; received/waived items keep theirs.
- AC-3 **Start period default** (Q1): when a group is enabled or a type is added to a client, the row's start period = the earliest still-open period for its frequency (was: the current period). Example on 29 Sep 2026: Sales invoices → Sep 2026; a yearly type with overdue from 31 Oct → FY 2025-26. Staff+ can still edit it (02 AC-21).
- AC-4 On generation, existing matching documents (e.g. filed before 04, or sent early) are linked, and the item starts as received.
- AC-5 Per-registration types generate one item per **active** GSTIN/TAN. If the client has none, nothing is generated and the plan row shows "No active GSTIN — nothing expected" (or TAN).

**Linking (changes to 03's flows)**
- AC-6 Saving/classifying/editing a document so that it matches a pending expected document links it and marks it received, with no extra fields, clicks or prompts (03 AC-5 unchanged). Documents that match nothing file exactly as today.
- AC-7 Re-classifying a document away from an expected document, or archiving it, unlinks it; if no linked document remains, the item returns to pending (and to Due/Overdue by its dates). Unarchiving links it again. A received item's *received on* is recomputed from its remaining linked documents.
- AC-8 Add document from an expected row ("Upload") opens Add document with client, type, period and registration pre-filled (0 dimension choices); saving links it.

**Staff actions**
- AC-9 **Waive** ("Not needed this period"): Admin, Manager, Staff on a pending item, with a reason (1–500 characters, required). Limited cannot. Waived items leave Due/Overdue and metric 1 and show "Not needed · <reason> · <who, when>".
- AC-10 **Undo waive**: Admin/Manager only → back to pending (or received if a linked document exists).
- AC-11 **Reopen** ("Still waiting for more"): anyone who can see the client, on a received item → pending; its linked documents stay linked. A newly linked document marks it received again with that document's date.
- AC-12 **Plan-change effects:** pausing a row → its pending items show *On hold* and are excluded from Due/Overdue and metric 1; periods whose ask date falls while paused are never generated (resume continues from the earliest still-open period). Removing a row or a group, deactivating a registration, or moving a start period later → pending items before/for it are **waived automatically** with a system reason ("Removed from plan", "Registration inactive", "Before start period").

**Screens**
- AC-13 **Client › Expected tab** (count = Due + Overdue): items grouped by group → type, newest period first; each row: type · period [· the full GSTIN/TAN, only when the client has more than one active registration of that kind (Raja 2026-09-29)], state text (Overdue · N days late / Due <date> / Due today / On hold / Received <date> · DOC-ID / Not needed · reason), assigned staff, and actions (Upload · Waive · Reopen · Undo). Filters: FY (default current), group, status (Open [default] · Received · Not needed · All). Empty state: "Nothing outstanding for FY 2026-27".
- AC-14 **Client › Documents cards** (mockup 10): each group card lists its **Overdue and Due** items first (e.g. "Invoices · August 2026 / Not received · 13 days late", red "Overdue", **Upload**), then received documents as in 03. A card with nothing open and no documents shows "All caught up for FY 2026-27". **Documents** becomes the default client tab.
- AC-15 **Clients list** (mockup 03): right-hand text "N overdue · N due today" (hidden when both 0); **Has overdue** filter chip. The filter value is never put in the URL (02 AC-7 rule).
- AC-16 **Settings › Collection** (new item; Admin/Manager only): metric 1 for the last 30 days — on-time %, with counts (due in window, received on time, received late, still missing) and a per-group table; plus "Overdue now" total. A note states the definition. Staff/Limited don't see the item (server-side check, like Users).

**Access & audit**
- AC-17 RLS: an expected document is visible iff the user can see its client (`can_see_client`). Nobody can INSERT/UPDATE/DELETE `expected_doc` directly; only the owning functions write (like 03's `begin_doc_write`). No hard delete.
- AC-18 Waive, undo waive, reopen and system auto-waives write one `activity` row each (IDs, status, reason **code** only — the free-text reason lives on the row, never in activity). Each job run writes one `activity` row per office (`expected.generated`, counts; actor = null/system). Generation and linking during a document save add no extra activity rows (03's row covers the save).

## Functional requirements
- Date maths lives in one SQL function `private.schedule_dates(period_end, ask_after, ask_day, overdue_after, overdue_day)` → (ask_on, overdue_from), mirrored by a TS helper for display/tests; unit-tested at month ends (31 → 30/28/29), FY and quarter boundaries.
- Generation function `private.generate_expected(p_office uuid, p_client uuid null, p_today date)`: set-based INSERT … ON CONFLICT DO NOTHING, then link matching documents; called by the job (all offices), by plan/registration functions (one client) and by the migration back-fill (all offices).
- Linking: an AFTER trigger on `document` (insert/update of client, type, period, registration, archived_at) maintains `document.expected_doc_id` and the expected item's status/received_on. Matching requires the period's kind = the plan row's frequency kind; a monthly plan row does not match a quarter/year document (see Risks).
- **FY roll-over:** from 1 February (IST), the job creates the next financial year and its periods if missing (system activity row), so April asks never find missing periods. Admin's manual "Add next financial year" (02 AC-5) stays.
- Test clock: `public.run_expected_generation(p_as_of date)` — Admin in an **`is_test` office only** (like 03's `app.doc_clock`) — runs generation for the caller's office as of a fixed date. Real offices only ever use today.
- Metric 1: security-invoker view/function `collection_metric(p_from date, p_to date)` returning totals and per-group rows; Admin/Manager only.

## Non-functional requirements
- **Performance (volume test, RUN_SLOW):** 1,000 clients × 15 scheduled rows × 12 months (~180k items): the daily job < 60 s; Clients list with overdue counts < 1 s server time; Client › Expected and Documents < 1 s; Collection metric < 2 s; a document save adds < 50 ms.
- **Security/privacy:** RLS default-deny; `office_id` on every row; tenant-first checks in definer triggers; `search_path = ''`; no PII in URLs/logs/activity; GSTIN/TAN shown to staff on screen only (never in URLs, logs, activity or client-facing text).
- **Accessibility:** WCAG 2.1 AA; state is text, not colour alone ("Overdue", "Due today"); waive dialog is the shared Modal with a labelled, required reason; ≤ 390 px for Expected tab and Clients list (asserted).
- **Reliability:** a job failure is visible — the nightly regression includes a check that today's `expected.generated` activity row exists on dev; job failures are logged by pg_cron (`cron.job_run_details`).

## Data model changes (schema lock: 04)
- Extension `pg_cron` (available on the project, not yet installed); job `expected-docs-daily` at 18:45 UTC.
- Enum `expected_status` (pending, received, waived).
- `expected_doc` (id, office_id, client_id, client_doc_type_id, doc_type_id, period_id, registration_id null, ask_on date, overdue_from date, status, received_on date null, completed_by_document_id null, waived_reason text ≤ 500 null, waived_code text null (manual · removed_from_plan · registration_inactive · before_start), waived_by null, waived_at null, reopened_at null, created_at, updated_at). Unique (client_doc_type_id, period_id, registration_id) with NULLS NOT DISTINCT. Checks: status = waived ⇔ waived_code not null; status = received ⇔ received_on not null. Indexes: (office_id, status, overdue_from), (client_id, status), (period_id); FKs indexed.
- `document.expected_doc_id uuid null` → expected_doc (maintained by trigger only; not in column grants).
- RLS: select via `can_see_client`; no insert/update/delete policies for app roles (functions only, begin-write flag); DELETE forbidden except `reset_test_office` purge.
- `reset_test_office` extended to expected_doc; the enable/add-type functions (02) change the default start period (AC-3).
- Functions: `waive_expected(id, reason)`, `undo_waive_expected(id)`, `reopen_expected(id)` (SECURITY INVOKER + role checks), `private.generate_expected`, `private.schedule_dates`, `private.earliest_open_period`, `run_expected_generation` (test offices), `collection_metric`.

## Existing code affected
- 02: `enable_group_core`, `add_client_doc_type` (start default), plan edit/pause/resume/remove paths and registration edits (call generation / auto-waive); Client › Settings plan row note (AC-5); Clients list + `search_clients` (overdue counts, filter).
- 03: `document` triggers (linking), Client › Documents view (open rows; default tab), Add document pre-fill from an expected row (period/registration params — UUIDs only).
- Settings nav (new Collection item), `reset_test_office`, test helpers (`tests/support/*`).
- Coverage today: all of these have RLS + e2e tests from 02/03; they stay unchanged and must pass.

## Backward compatibility & data migration
Dev only (no staging/prod yet). Migration back-fills expected documents for all offices as of the migration date and links documents filed in 03. Existing plan rows keep their stored start period (AC-3 changes only the default for new rows). `document.expected_doc_id` nullable.

## API / interfaces
- Routes: client page `?tab=expected` / `?tab=documents` (default documents); `/documents/new?client=&type=&period=&registration=&from=` (UUIDs only); `/settings/collection`.
- Server actions: `waiveExpected`, `undoWaiveExpected`, `reopenExpected`, `getCollectionMetric`; clients list action gains `hasOverdue`.
- Queries: `listClientExpected(clientId, fy)`, open items for the Documents cards, overdue counts per client.

## UX flows & screens
- **Expected tab:** filter bar (FY · group · status) → group cards → rows with state text right-aligned (colour tokens `--bad` overdue, `--warn` due today/this week, `--ink-3` on hold/not needed, `--good` received) and buttons. Waive → Modal "Not needed for <type · period>?" + reason (required) → Save. Reopen → inline confirm. Every action shows a toast and re-renders.
- **Documents tab:** open items on top of each group card (as mockup 10), received documents below (03).
- **Clients list:** overdue text + "Has overdue" chip, as mockup 03.
- **Settings › Collection:** stat tiles (On-time % · Received on time · Received late · Still missing · Overdue now) + per-group table + definition note. Empty state before any item has passed its overdue date: "Nothing has fallen due yet — the figure appears after the first overdue date."
- Every screen: loading (`role="status"`), error (alert + retry), empty states (02's `states.tsx`).

## Test strategy
| AC | Test | Suite |
|---|---|---|
| defs, 3 | `schedule_dates` / TS helper: month ends, leap Feb, quarter + FY ends, offset 0; earliest still-open period | unit + RLS/DB |
| 1, 4, 5 | generation as of fixed dates: counts per frequency, idempotent re-run, excluded rows (paused/removed/as-needed/firm/proposed/archived client), per-registration fan-out, none without registration, back-link of earlier documents | RLS/DB |
| 2, 12 | plan changes: enable → immediate items; offset edit recomputes pending only; pause → on hold, no generation while paused, resume from still-open; remove/registration inactive/start later → auto-waived with codes | RLS/DB |
| 6, 7 | save/classify/edit/archive/unarchive link and unlink; received_on recomputed; non-matching kinds don't link | RLS/DB |
| 8 | Upload from Expected row pre-fills and links | e2e |
| 9–11 | waive roles (Limited denied), reason required, undo A/M only, reopen incl. Limited on visible client | RLS/DB + e2e |
| 13–15 | Expected tab states/filters; Documents cards open rows + "All caught up"; Documents default tab; Clients "Has overdue" + text; not in URL | e2e + unit |
| 16 | metric maths on a fixture set (on time / late / missing / waived / on hold excluded); Staff/Limited can't reach page or function | RLS/DB + e2e |
| 17, 18 | visibility matrix (4 roles × assigned/unassigned); direct writes rejected; activity rows, no free text/PII | RLS/DB |
| NFR | volume (RUN_SLOW): job time + screen query times at ~180k items; axe on Expected tab, Collection; ≤ 390 px | RLS/DB + e2e |
| job | pg_cron job registered with the expected schedule; nightly regression asserts today's `expected.generated` row on dev | RLS/DB (regression) |
- All new tests join the regression suite. **Smoke-safe for prod:** none added.
- Generation tests use `run_expected_generation(p_as_of)` in `is_test` offices only; they never depend on the real date.

## Proposed architecture changes (approved Raja 2026-09-29; architecture lock → 04)
1. **pg_cron system job** writes data with no signed-in user (definer function, tenant-scoped per office, actor = system in activity). First non-user writer in the product.
2. **Auto-create next FY** from 1 February (system), alongside Admin's manual button — so generation never stalls at the FY boundary.
3. **Default start period = earliest still-open period** (changes 02's default; intent Q1).
4. **Expected items exist from their ask date** (no stored "upcoming" items). Keeps volume and noise down; early documents are linked when the item is generated. Deviation from intent wording "upcoming → due → overdue": upcoming is not shown in 04 (Today/06 can preview from the schedule if wanted).
5. **Metric 1 on a new Settings › Collection page**, not "Settings › Office" as the intent said — there is no Office page yet (mockup 09 is unbuilt), and building it just to host one card is out of scope.

## Risks & areas of concern
- **Wrong period kind at filing:** a client sends one quarterly bundle for a monthly row → the document won't link; the three months stay overdue. Mitigation: Add document pre-fills the plan's period kind (03 AC-3 already does); staff can waive with a reason. [Likely] occasional; revisit after the pilot.
- **received on is staff-entered** and can be backdated → metric 1 can be inflated (accepted at intent gate). Mitigation: activity keeps the edit trail; review in pilot.
- **Job silently not running** (pg_cron disabled, project paused) → no new items → metric looks good. Mitigation: nightly regression assertion + Collection page shows "Last generated <time>".
- **Linking trigger on the hot document path** — must stay cheap (index on the unique key) and inside 03's write guard; volume test covers it.
- **Scope at the 2-week edge** [Likely]: first cut if the plan is too large = AC-14's open rows in the Documents cards (Expected tab alone meets the goal; 06's Today shows the same rows).
- **Concurrency with 03b:** 04 changes `src/lib/documents/queries.ts` and client page tabs; 03b reads documents. Merge 04 first (batch decision).

## Out of scope
Today screen, Remind (email/WhatsApp), follow-up log, chasing-load metric (06) · type merge re-pointing expected docs (05) · review/dispatch (07) · Documents/Search (03b) · automatic reminders, staff nudges · "upcoming" items and a forward calendar · partial-receipt counts · a metric report screen, per-staff metric · mapping one quarterly document onto three monthly items · "apply master schedule to existing clients".

## Decisions (Raja 2026-09-29)
Architecture changes 1–5 approved (incl. no stored "upcoming" items; metric 1 on Settings › Collection) · next FY auto-created by the job from 1 February · Expected rows show the full GSTIN/TAN when the client has several. **2026-09-30:** a document without a GSTIN/TAN links when the client has exactly one active registration of that kind (option b).

## Open questions
None — settled at the spec gate 2026-09-29.
