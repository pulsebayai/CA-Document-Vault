# Spec: Today & reminders
Intent: ./intent.md · Status: approved (Raja 2026-10-01) · Date: 2026-10-01
Screens:
- `references/mockup/01-today.jpg`: Today, counts, client cards, rows, My clients / Everyone.
- `10-client-documents.jpg`: Remind on expected rows.

Settings › Reminders (`07-settings-reminders.jpg`) is **not** built: automatic asks, nudges, repeats and acknowledgements are on the Later list, and the sender is configured per environment.

## Key definitions
- **Effective assignee** of an expected item (or a classified document): the client's plan row for that type (`client_doc_type.assigned_staff_id`), else its group's (`client_group.assigned_staff_id`), else the client's **incharge**. It uses the same columns that decide Limited visibility (`can_see_client`).
- **Mine** = items and documents whose effective assignee is the signed-in user. **Everyone** = everything the user can see (RLS). Limited users see only their clients either way.
- **Today rows:**
  - expected items that are **Overdue**, **Due today** or **Due this week** (overdue date within the next 7 days, IST, not yet overdue; Raja Q5), not On hold;
  - classified documents **To review** and originals **Ready to dispatch**, using 07's `documentState()` (built after 07 merges).
- **In inbox** = the Inbox count already in the header (03).
- **Reminder** = one `follow_up` for one client, covering ≥ 1 of its open expected items, on one channel:
  - **email**: sent by the vault via Brevo;
  - **whatsapp**: a pre-filled chat opened in the staff member's own WhatsApp;
  - **phone**: logged by staff.
- **Follow-up status:** email `pending` → `sent` | `failed`, or `suppressed` (non-production, recipient not allow-listed); whatsapp `opened`; phone `logged`. **Counts as a reminder** (row history, metric 2, cap) = sent, suppressed, opened or logged.

## User stories & acceptance criteria
**Today**
- AC-1 After sign-in, `/` and the header logo go to **Today** (`/today`). Nav order: Today · Inbox · Clients · Settings (Activity arrives with 08).
- AC-2 **Counts row** (mockup 01): Overdue · Due this week · To review · Ready to dispatch · In inbox, for the current scope. Clicking a count filters the cards to that kind, and clicking it again clears the filter. The filter and scope are enums in the URL (`?scope=everyone&show=overdue`). No text goes in the URL.
- AC-3 **Scope toggle** "My clients / Everyone", default **My clients** for every role.
- AC-4 **Client cards**:
  - **Header:** initials, client name (a link to the client), incharge plus group assignees ("Incharge Ravi · GST Priya"), and a badge ("N overdue", else "Due this week").
  - **Row order:** Overdue (most days late first), Due today, Due this week, To review, Ready to dispatch.
  - **Card order:** most overdue first, then by name. 30 cards per page, then "Show more".
  - **Empty state:** "Nothing needs you today" (Mine) or "Nothing outstanding" (Everyone).
- AC-5 **Row content** (mockup 01):
  - expected rows: "Group · Type · Period", "Not received · N days late · reminded twice" (or "reminders off" / "hard copy expected"), and actions **Remind** · **Upload** (Add document pre-filled, 04) · **Mark received** for hard copy;
  - document rows: "Group · Type · Period · DOC-ID [Original]", "Received <date> · waiting for review", and **Mark reviewed** / **Mark dispatched**, reusing 07's actions.
- AC-6 Today loads in ≤ 1 s server time for a user with ~150 clients (volume test).

**Remind**
- AC-7 **Remind** on any expected row (Today, Client › Documents, Client › Expected) opens the **Remind dialog** for that client:
  - It lists **all the client's open items (Overdue, Due today, Due)**, each with "reminded N times · last <date>".
  - All are ticked **except items whose plan row has reminders off**, which are shown "reminders off" and unticked (Raja Q2).
  - A **preview** shows exactly the text that will be sent.
  - Two buttons: **Send email** and **Open WhatsApp**.
- AC-8 **Send email:**
  - **Disabled when** the client has no email ("No email on file — add one in Settings") or was already emailed today, IST ("Emailed today at 11:20 by Priya. One email per client per day"). The cap is enforced by the database, not just the UI.
  - **On send:** a `follow_up` is recorded **before** the provider is called. Then Brevo is called. The result is **Sent**, or **Failed** with a plain reason and Retry; a retry may use the day's one email because the failed one doesn't count.
  - **Message:**
    - From: the firm's Brevo sender (per environment);
    - Reply-To: **the staff member who sends it** (see decision 1);
    - To: the client's main email (Raja Q3).
- AC-9 **Open WhatsApp:** disabled with the reason when the client has no mobile. Otherwise it opens `https://wa.me/91<mobile>?text=<message>` in a new tab, from the click itself so popup blockers allow it, and records a follow-up with status `opened`. Not capped.
- AC-10 **Message content:**
  - Greeting with the client's name, then one line per ticked item: "GST · Sales invoices · August 2026 — overdue since 5 Sep" / "— due by 4 Oct".
  - Per-registration items name the registration's **state** ("Tamil Nadu GSTIN"), never the number.
  - Sign-off with the sender's name and the firm name.
  - **Never:** PAN, GSTIN/TAN numbers, links, attachments, DOC-IDs or internal remarks.
  - The same text is used for email (plain text + simple HTML) and WhatsApp. English only.
- AC-11 **Log call** (Raja 2026-10-01) on the same rows: a dialog with the client's open items (ticked as in AC-7), date (default today, not future) and an optional note (≤ 300 characters). Saving records a `phone` follow-up (`logged`).
- AC-12 **History:**
  - every expected row shows "reminded N times · last <date> by <name> (<channel>)";
  - the client page gets a **Reminders** list (newest first: date, channel, who, items, status, call note) under the Expected tab.

**Safety**
- AC-13 **No real email outside production, except to allow-listed addresses:**
  - when `APP_ENV` isn't `production`, a recipient not on `EMAIL_ALLOWLIST` gets status `suppressed` and nothing leaves the vault;
  - in every environment, an address ending `.test` is always suppressed;
  - **CI and tests use the `test` transport, which never makes a network call.** Proven by unit tests on the transport choice and an RLS/e2e test that every test-run follow-up is `suppressed`.
- AC-14 **Quota safety:** the cap (1 email per client per day) plus a per-office daily ceiling (`EMAIL_DAILY_MAX`, default 200) keep reminders from using up the Brevo quota sign-in codes need. At the ceiling, Send email is disabled: "Daily email limit reached — use WhatsApp or try tomorrow."

**Metric 2**
- AC-15 **Settings › Collection** (Admin/Manager) adds **chasing load** for the last 30 days:
  - reminders per expected item received in the window, counting reminders (any channel) recorded before it was received;
  - the share of received items that needed ≥ 1 reminder;
  - a per-channel split.

  A note states the definition.

**Access & audit**
- AC-16 RLS: a follow-up is visible iff the user can see its client. Writes go only through 06's functions; there are no app write policies. Remind and Log call are allowed for anyone who can see the client, including Limited.
- AC-17 Activity, one row per follow-up: `reminder.email` (with status), `reminder.whatsapp`, `reminder.call`. The data holds IDs, channel, status and item count only. **No email address, mobile, message text or call note** (the `ACTIVITY_PII` guard plus an explicit test).

## Functional requirements
- **Today data:** one SECURITY INVOKER function `today_items(p_scope 'mine'|'everyone', p_show text)` returns the cards' rows and the counts in one call: set-based, effective assignee resolved in SQL, RLS applies.
  - 06's first migration covers expected items.
  - After 07 merges, 06 rebases, and a second migration of **06's own function** adds the To review / Ready to dispatch documents using 07's status and dispatch tables.
- **Sending (two-phase, no double sends):**
  1. `begin_email_reminder(p_client, p_items)` (invoker) checks visibility, that items are open and belong to the client, the daily cap and the office ceiling, and inserts the follow-up as `pending`;
  2. the server action calls the mailer;
  3. `finish_email_reminder(p_id, p_status, p_provider_id, p_error_code)` records the result.

  A `pending` row older than 10 minutes counts as `failed` for display and cap purposes.
- **Mailer interface** `src/lib/mail/` with `send(message) → { status, providerId, errorCode }`:
  - **Transports:** `brevo` (HTTP API, `BREVO_API_KEY` server-only), `test` (records nothing externally, returns `suppressed`), chosen by `MAIL_TRANSPORT`.
  - The allow-list rule (AC-13) runs inside `send`, before any transport.
  - Only `src/lib/mail/` may read the Brevo key (ESLint allow-list, like `storage.ts`).
- **WhatsApp and calls:** `record_follow_up(p_client, p_items, p_channel 'whatsapp'|'phone', p_on date, p_note)` (invoker).
- **Metric 2:** `chasing_metric(p_from, p_to)` (invoker; Admin/Manager), next to 04's `collection_metric`.
- **Message builder** `src/lib/reminders/message.ts`: pure, unit-tested for every AC-10 rule.

## Non-functional requirements
- **Performance:**
  - Today ≤ 1 s and the Remind dialog ≤ 500 ms server time; "Everyone" is paged;
  - email send ≤ 3 s, with a 10 s provider timeout, after which the follow-up is Failed;
  - Today timings join the deferred volume test.
- **Security/privacy:**
  - RLS default-deny on the new tables; `office_id` everywhere; `search_path = ''`;
  - the Brevo key is server-only;
  - the recipient address is snapshotted on the follow-up row (decision 2): on screen only, never in activity, logs or URLs;
  - the WhatsApp URL is built in the browser (the documented exception);
  - server errors log a code + request ID only.
- **Accessibility:**
  - counts are buttons with pressed state; state is text, not colour alone;
  - the Remind and Log call dialogs use the shared Modal; the preview is in a labelled region;
  - Today and both dialogs work at ≤ 390 px (asserted), with axe on Today and the Remind dialog.
- **Reliability:** a Brevo outage shows Failed + Retry and never blocks WhatsApp, calls or sign-in.

## Data model changes (additive-only exception; schema lock: 07)
- **Enums:** `follow_up_channel` (email, whatsapp, phone), `follow_up_status` (pending, sent, failed, suppressed, opened, logged).
- **`follow_up`:**
  - `id`, `office_id`, `client_id`, `channel`, `status`, `sent_by`, `sent_at`;
  - `sent_on` (IST date, for the cap);
  - `recipient` (email or mobile snapshot; email/whatsapp only);
  - `provider_message_id`, `error_code`, `note` (phone, ≤ 300), `finished_at`.
  - **Unique (client_id, sent_on) where channel = 'email' and status in ('pending', 'sent', 'suppressed')**: the cap, in the database.
- **`follow_up_item`:** `id`, `office_id`, `follow_up_id`, `expected_doc_id`; unique (follow_up_id, expected_doc_id).
- **No update/delete** except the `finish` transition (trigger). Foreign keys to `client` / `expected_doc` are `on delete cascade` **only** so 02's `reset_test_office` purge of test offices works without changing that function (the exception allows no change to existing functions). Real offices never delete clients or items.
- **Indexes:** `follow_up (client_id, sent_at desc)`, `follow_up_item (expected_doc_id)`, FK indexes.
- **New functions only:** `today_items`, `begin_email_reminder`, `finish_email_reminder`, `record_follow_up`, `chasing_metric`. **No existing table, policy, trigger or function changes.**

## Existing code affected
- `src/app/page.tsx` (redirect → `/today`);
- `src/components/app-header.tsx` (nav: Today first; logo link);
- `src/app/(app)/clients/[id]/documents-view.tsx` and `expected-view.tsx` (Remind / Log call / history; 07 also edits documents-view, so **07 merges first** and 06 rebases);
- `src/app/(app)/settings/collection/page.tsx` (metric 2);
- `src/lib/env.ts` stays public-only; server secrets are read in `src/lib/mail/`;
- `eslint.config` (the allow-list for the Brevo key);
- new `src/app/(app)/today/`, `src/lib/mail/`, `src/lib/reminders/`.

## Backward compatibility & data migration
No data to migrate. Bookmarks to `/clients` keep working; only `/` and the logo change. Sign-in emails keep going through Supabase's SMTP setting on the same Brevo account, untouched by 06.

## API / interfaces
- Server actions (POST): `todayData(scope, show, page)`, `remindDialog(clientId)`, `sendEmailReminder(clientId, itemIds)`, `recordWhatsApp(clientId, itemIds)`, `logCall(clientId, itemIds, on, note)`, `clientReminders(clientId)`.
- **New environment variables:**
  - `MAIL_TRANSPORT` (`brevo` | `test`), `BREVO_API_KEY`;
  - `MAIL_FROM_EMAIL`, `MAIL_FROM_NAME`;
  - `APP_ENV`, `EMAIL_ALLOWLIST`, `EMAIL_DAILY_MAX`.

  Documented in `.env.example` and the README.

## UX flows & screens
- **Today** (mockup 01): title + date + "N clients need something"; counts row; scope toggle at top right; two-column cards on desktop, one column ≤ 768 px.
- **Remind dialog:** client name; the items list with checkboxes and history; the preview; buttons Send email / Open WhatsApp, each with its disabled reason shown under it; result inline ("Sent to a…@…, 11:20"). On a phone the dialog is full-width.
- **Log call dialog:** items, date, note, Save.
- **States:** shared loading/error per screen; a provider error shows inline with Retry; a stale dialog (someone else emailed meanwhile) shows the cap message on Send.

## Test strategy
| AC | Test | Suite |
|---|---|---|
| 1–6 | landing redirect; nav; counts = rows per scope and role; effective assignee (type → group → incharge); due-this-week boundary (IST); card order; paging; filters in the URL as enums only; ≤ 390 px; axe | e2e + RLS/DB + unit |
| 7–12 | dialog ticks (reminders-off unticked); cap enforced in the DB (second insert refused, failed doesn't count, pending > 10 min ignored); items must be the client's and open; WhatsApp URL; log call; history counts | RLS/DB + unit + e2e |
| 10 | message builder: no PAN/GSTIN/TAN/links/DOC-ID/remark; state name for registrations; wording per state | unit |
| 13–14 | transport choice by env; `.test` always suppressed; allow-list; office ceiling; **CI makes zero network calls** (fetch spy) | unit + RLS/DB |
| 15 | chasing metric definition on fixtures (reminders before receipt only; per channel) | RLS/DB |
| 16–17 | Limited only on own clients; no app write path; activity carries no address/text | RLS/DB |
| 2 (07 part) | To review / Ready to dispatch rows and counts (after the rebase on 07) | RLS/DB + e2e |
| timed | Staff role: sign-in → find overdue → remind one client ≤ 30 s (intent metric 2) | manual (PR; R1 staging) |

All new tests join the regression suite. Smoke-safe for prod: none.

## Proposed architecture changes (architecture lock: 06; written to architecture.md in 06's PR)
1. **Mailer pattern:**
   - one server-only interface, with transports `brevo` and `test`, an allow-list outside production, and `.test` addresses never sent;
   - two-phase send (a database row before the provider call), with the cap enforced by a unique index;
   - the Brevo API key is ESLint-allow-listed to `src/lib/mail/` only.
2. **Effective assignee** (type → group → incharge) as the shared definition of "mine", in SQL and TS.
3. **Additive-only exception:** a feature without the schema lock may add its own tables and functions. Cascading foreign keys from its tables to existing ones are allowed **only** so the test-office purge works.
4. **PII snapshot on an entity:** a follow-up stores the address it went to (the audit "did we send it?"), RLS-protected, never in activity, logs or URLs.
5. Update the Brevo line: no webhook in the pilot (Sent/Failed only), and Reply-To = the sending staff member.

## Risks & areas of concern
- **07 dependency:** document rows and both 07 actions arrive only after 07 merges. Mitigation: built last, behind the rebase; the rest of 06 is independent.
- **Brevo quota shared with sign-in** (dev free plan, 300/day). Mitigation: CI never sends, there's an allow-list outside production, the daily cap and the office ceiling, and a paid plan in production.
- **WhatsApp "opened" ≠ sent:** metric 2 may count a chat the staff member never sent. Accepted for the pilot (architecture); the dialog says "Press Send in WhatsApp".
- **Bounces are invisible in the vault** (Raja Q4). The weekly Brevo-dashboard check is on the pilot checklist.
- **Today performance** across 1,000 clients is unknown until the volume test.

## Out of scope
Automatic or scheduled reminders, nudges, upload links, acknowledgements, templates, Settings › Reminders, bulk reminders, the WhatsApp Business API, the Brevo webhook, CC to contacts, other languages, the Activity screen (08).

## Decisions (Raja 2026-10-01: all six approved as recommended)
1. **Reply-To = the staff member who presses Send**, not each item's assignee: one email can cover items with different assignees, and the sender is the one following up. Recommend **yes** (updates the architecture line "Reply-To = assigned staff").
2. **Store the recipient address on the follow-up row** (a snapshot), so "we emailed a…@… on 3 Oct" survives a later change to the client's email. Recommend **yes** (RLS-protected, never in activity or logs).
3. **Brevo HTTP API, not SMTP, for reminders.** It gives a message ID and clear errors, and works from Vercel functions. Sign-in keeps using Supabase's SMTP setting. Recommend **yes**.
4. **Office daily ceiling `EMAIL_DAILY_MAX`** (default 200) on top of the per-client cap, to protect sign-in codes. Recommend **yes**; you can set the number per environment.
5. **Test-purge cascades** (cascading foreign keys only so the test-office reset keeps working without touching 02/03 functions). Recommend **yes**.
6. **Today counts act as filters**, with scope and filter as enums in the URL. Recommend **yes** (shareable, refresh-safe, no text).
