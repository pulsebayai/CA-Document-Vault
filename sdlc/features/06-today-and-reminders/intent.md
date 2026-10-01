# Intent: Today & reminders
Author: Raja (drafted with Claude) · Status: approved (Raja 2026-10-01) · Date: 2026-10-01
Roadmap item: 06-today-and-reminders · Release: R1 · Batch D (with 07; **07 merges first**, then 06 rebases) · Moves product metrics: 2 (chasing load), made measurable here; 1 (on-time completeness), via faster chasing; 5 (adoption), via a daily starting screen

## Problem
Since 04 the vault knows what each client still owes, but only **one client at a time** (Client › Expected). Two gaps remain:
- **No daily view across clients.** A staff member with 50–150 clients can't see "what needs me today" (overdue items, items due this week, documents to review or return) without opening every client. So they fall back to Excel and memory, the workaround the product exists to replace.
- **Chasing happens outside the vault.** Staff remind clients from their own email and WhatsApp, so the vault can't show what was asked, when, or how often. Metric 2 (chasing load) has no data, and a colleague covering for someone can't see the history.

**Cost:** overdue items noticed late, duplicate or forgotten reminders, no evidence of what the firm asked for, and no way to tell whether chasing is improving.

## Proposed outcome
- **Today screen (mockup 01), the landing page after sign-in:**
  - Counts: Overdue · Due this week · To review · Ready to dispatch · In inbox.
  - Client cards with the rows that need action.
  - **My clients / Everyone** toggle. "Mine" = items whose **effective assignee** is me: type-level assignee, else group assignee, else client incharge (Raja 2026-10-01). Limited users only ever see their own clients.
  - Row actions reuse what exists:
    - Upload / Mark received → Add document pre-filled (04);
    - Mark reviewed / Mark dispatched → 07's actions;
    - **Remind** and **Log call** (new).
- **Remind (one per client, Raja 2026-10-01):**
  - Remind on any row opens a preview listing **all that client's due and overdue items**, all ticked. Staff can untick items, then choose:
    - **Email**, sent from the vault via **Brevo** (decision 2026-10-01) from the firm's address, with Reply-To = the assigned staff member;
    - **WhatsApp**, which opens a pre-filled chat in the staff member's own WhatsApp (click-to-chat). The staff member presses Send.
  - Both list document type + period only: no attachments, no links into the app, no PAN/GSTIN.
- **Log call:** records a phone reminder (date, optional short note) against the client's items, so metric 2 counts all chasing (Raja 2026-10-01).
- **Follow-up history:** every reminder (email, WhatsApp, call) is recorded with who, when, channel and which items. Rows show it ("reminded twice", "last reminded 3 days ago"). Email rows show **Sent** (Brevo accepted it) or **Failed** (Brevo refused it at send time). No delivery or bounce tracking in the pilot (Raja 2026-10-01).
- **Metric 2 figure:** reminders per expected item before it was received, for Admin/Manager next to metric 1 on Settings › Collection (04's page).

## Users & systems affected
- **All staff:** Today, for the clients they can see; Remind and Log call on those clients' items.
- **Admin/Manager:** the metric 2 figure.
- **Clients (recipients, not users):** receive staff-triggered emails, or WhatsApp messages the staff member sends.
- **Systems:**
  - new follow-up tables (additive only);
  - Brevo through one mailer interface, with a test transport in CI;
  - the landing redirect (`/` → Today instead of Clients);
  - the header nav (Today first);
  - Client › Documents / Expected rows (Remind buttons, reminder history);
  - Settings › Collection;
  - `activity`.

## Success metrics
1. **Metric 2 measurable:** chasing load (reminders per expected item before receipt, across all three channels) is available from pilot day 1. The baseline is recorded after 2 pilot weeks; target: trending down month on month.
2. **Daily view works (timed, Staff role, staging):** from sign-in, a staff member identifies their overdue items and sends one client a reminder covering all its overdue items in **≤ 30 s**.
3. **Correctness (tests):**
   - Today's counts equal the rows behind them for every role.
   - Limited users never see another client's items.
   - The cap is enforced in the database, not just the UI.
   - **No email is ever sent to a `.test` address or, outside production, to anyone not on an allow-list.**
4. **Sending works (staging/pilot):** ≥ 95 % of reminder emails are accepted by Brevo at send time; every refusal shows as Failed on the item with a plain message. *Known gap:* bounces after acceptance are visible only in the Brevo dashboard. An Admin checks it weekly during the pilot, and a bounced reminder still counts in metric 2.

## Constraints
- **Cap (Raja 2026-10-01):** at most **1 reminder email per client per day** (IST). A second attempt is blocked with a clear message. WhatsApp and calls aren't capped (a person sends or makes them).
- **Brevo (architecture, 2026-10-01):**
  - one account per environment; production uses the firm's authenticated domain and a paid plan;
  - reminders must never use up the sign-in quota;
  - **outside production, real sends go only to an allow-list** of staff addresses; everything else is logged as "suppressed (test)";
  - CI never calls Brevo.
- **Content rules (architecture):**
  - no attachments, no app links, no PAN/GSTIN;
  - client email and mobile are never written to `activity`, URLs or logs, except that the WhatsApp link carries the client's own mobile, built in the staff member's browser (the documented exception).
- **Missing contact details:** if the client has no email (or mobile), that channel is disabled with the reason shown, never hidden.
- **No automatic sends.** Every message starts with a staff click (v1 rule). The mockup's automatic "ask", "nudge" and weekly repeat stay on the Later list. Settings › Reminders from mockup 07 isn't built in 06; the sender is configured per environment.
- **Locks:**
  - **architecture lock → 06** (Brevo integration, follow-up model, delivery events);
  - **schema: additive-only exception.** 06 may add its own tables and functions, but may not change existing tables, policies, triggers or functions. 07 holds the schema lock.
- **Depends on 07:** the To review / Ready to dispatch counts and actions use 07's statuses. 06 builds those parts last, after 07 merges, and rebases.
- **Performance:**
  - Today ≤ 1 s for a staff member with ~150 clients;
  - "Everyone" paged at 1,000 clients;
  - covered by the deferred volume test.

## Behaviour that must not change
- 04's expected items, dates, waive/reopen rules and the metric 1 definition. Reminding doesn't change an item's state.
- 07's review/dispatch rules. 06 only calls them.
- Sign-in emails keep working on the same Brevo account; reminders can't break login.
- Limited users see only their assigned clients.
- Client › Documents and the 03b search behave as today, plus Remind buttons and reminder history on expected rows.

## Out of scope
- Automatic or scheduled reminders, the weekly repeat, staff nudge emails, upload links, acknowledgement emails → **Later** (v1 rule).
- WhatsApp Business API (sending from the firm's number, delivery status, replies into the Inbox) → **Later**; decide with pilot data.
- Email delivery/bounce tracking (Brevo webhook, the vault's first inbound endpoint) → **Later**; decide after the pilot.
- Editable email templates and a Settings › Reminders page; multiple recipients or CC to client contacts; languages other than English.
- Bulk reminders across many clients in one click.
- An Activity screen → **08**.

## Decisions (Raja 2026-10-01)
- Effective assignee for "My clients" (type → group → incharge); one Remind per client covering all due and overdue items; **1 email per client per day**; **Log call** included.
- **Q1** Today is the landing page (`/` → Today).
- **Q2** Items with reminders off are listed in the Remind preview but **not ticked**.
- **Q3** Recipients: the client's main email and mobile only.
- **Q4** Email status: **Sent / Failed (at send time) only** for the pilot; **no webhook**. Bounces go to the Later list.
- **Q5** Due this week = overdue date within the next 7 days (IST), not yet overdue.

## Open questions
None. Settled at the intent gate 2026-10-01.
