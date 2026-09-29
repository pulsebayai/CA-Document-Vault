# Intent: Expected documents & schedule
Author: Raja (drafted with Claude) · Status: draft · Date: 2026-09-29
Roadmap item: 04-expected-docs-schedule · Release: R1 · Moves product metric: 1 (on-time completeness), made measurable here; enables 2 (chasing load, 06)

## Problem
Since 02, each client has a **collection plan** (`client_doc_type`: which document types, how often, when to ask, when it is overdue). Since 03, received documents are filed against client, type and period. Nothing yet compares the two, so the vault still can't answer the firm's daily question: **"what is missing, for whom, and how late is it?"** Staff answer it today from Excel trackers and memory. Items are missed until a return's due date forces a scramble. The firm also can't measure on-time collection (product metric 1 has no baseline).

**Cost:** late GST/TDS/ITR inputs, repeated ad-hoc chasing, no view of workload per staff member, no evidence of what was asked and when.

## Proposed outcome
For every client, the vault **knows what it expects** and shows what is still outstanding:
- The plan generates one **expected document** per client × type × period, and × GSTIN/TAN for per-registration types. Each has an **ask date** and an **overdue date** from the client's own schedule. Its state is *upcoming → due → overdue*, and it ends as *received* or *waived*.
- Filing a document for the same client + type + period (+ registration) **links it automatically** and marks the expected document received, with no extra clicks. Staff can reopen it ("still waiting for more").
- Staff can mark an expected document **not needed this period** (waive) with a reason, for example a nil month or a closed account.
- Staff see this on the client page (**Expected** tab, plus due/overdue rows in the Documents group cards as in mockup 10). The Clients list gets the "Has overdue" filter and overdue text that 02 deferred.
- Admin/Manager see **metric 1**: the share of expected documents received on or before their overdue date.

## Users & systems affected
- Staff (all roles): see expected/overdue items for the clients they can see. Upload from an expected row pre-fills Add document.
- Staff+ (not Limited): waive with a reason. Admin/Manager: undo a waive.
- Admin/Manager: metric 1 figure.
- Systems: new `expected_doc` table and `document.expected_doc_id`; a daily **pg_cron** job plus immediate generation when a plan changes; 03's `create_document` / classify / edit / archive flows (linking); 02's enable-group default start period; Clients list; Client › Documents; `activity`.

## Success metrics
1. **Metric 1 measurable:** on-time completeness (%) is available from day 1 of the pilot. The baseline is recorded after the first 2 pilot weeks. There is no target until the baseline exists.
2. **Plan fidelity:** for 5 pilot clients, the vault's list of expected/outstanding items for the month matches the staff's own tracker for ≥ 95 % of items. This is a manual check on staging/pilot, and every mismatch is explained or fixed.
3. **Generation correctness (tests):** every active, scheduled plan row has exactly one expected document per period (× active registration) from its start period up to the current one. There are no duplicates when the job re-runs, and nothing is generated for paused/removed rows, "as needed" types or firm records.
4. **No added filing effort:** filing a document that matches an open expected item takes the same clicks as in 03 (≤ 3 after choosing the file). Upload from an expected row needs 0 dimension choices.

## Constraints
- **Start period (Raja 2026-09-29, Q1):** when a group or type is enabled, the default start is the **earliest period whose overdue date has not yet passed**. For example, FY 2025-26 yearly documents still needed for ITRs are included, and past months are not flooded in as overdue. The start stays editable per plan row.
- **Received (Q2):** received automatically on the first linked, non-archived document. The received date is the earliest linked document's *received on* date. Archiving the last linked document reopens the expected document. Staff can reopen a received item.
- **Waive (Q3):** Admin, Manager and Staff can waive, with a reason of 500 characters or less. Admin/Manager can undo a waive. Limited cannot waive. Waived items are excluded from metric 1.
- **Metric 1 (Q4):** a DB view plus a small figure for Admin/Manager on Settings › Office (last 30 days, with counts and a per-group split). A full report and the Today dashboard are out of scope (06).
- **Dates:** ask/overdue = period end + offset months, on the given day, clamped to the month end, in IST. They are **recomputed for open items** when the client's schedule changes. Received/waived items keep their dates.
- **Plan changes (Claude default; confirm at gate):**
  - Pausing a row stops new periods. Its open items are put on hold: hidden from due/overdue and excluded from metric 1. Resuming continues from the current open period and does not back-fill the paused months.
  - Removing a row waives its open items automatically ("removed from plan").
  - A new active GSTIN/TAN starts generating from its own current open period. A deactivated one waives its open items.
- **Generation:** a daily pg_cron job (IST), idempotent. Plan edits generate immediately so staff never wait a day. Test offices can run it for a fixed date (like 03's `app.doc_clock`, `is_test` only).
- **Nothing is sent to clients in 04.** Remind (email/WhatsApp) is 06.
- RLS: expected documents follow client visibility (`can_see_client`). There is no hard delete. Every waive/reopen/undo writes `activity` with IDs only.
- Volume: up to 1,000 clients × ~15 scheduled types × 12 periods is about 180k rows a year. Screens and the job must stay fast at that size (volume test).
- **Schema lock → 04** from plan approval. **Build waits for the `test-isolation` chore.**

## Behaviour that must not change
- 03 filing speed, DOC-IDs, the Inbox, versions and archive rules.
- 02 plans, pause/remove rules, and the Admin/Manager-only assignment.
- Limited users see only their assigned clients.
- Documents without a matching expected item (as-needed types, undated documents, proposed types) file exactly as today.

## Out of scope
- Today screen, "Remind" email/WhatsApp, follow-up log, chasing-load metric → **06**.
- Proposed-type review and re-pointing expected docs on a type merge → **05**.
- Review/dispatch statuses ("To review", "Mark dispatched") → **07**.
- Documents/Search → **03b**.
- Automatic reminders, staff nudge emails, a metric report screen, and "apply master schedule change to existing clients".
- Partial-receipt tracking (counts of expected files per period). Reopen covers it for now.

## Open questions
1. Do the plan-change defaults above (pause = on hold with no back-fill, remove = auto-waive) match how the firm works?
2. Should Limited staff be able to **reopen** a received item for their own clients? Draft: yes, because reopening only makes an item more visible.
