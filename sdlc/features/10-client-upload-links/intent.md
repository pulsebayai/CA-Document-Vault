# Intent: Client upload links (email / WhatsApp)
Author: Raja (drafted with Claude) · Status: **approved (Raja, with Kushal Associates, 2026-10-25)** · Date: 2026-10-25
Roadmap item: 10-client-upload-links · Release: **R1, single release** · Moves product metric: 1 (on-time completeness), 2 (chasing load), 4 (inbox age)

> **Reverses a logged decision.** product.md, architecture.md and CLAUDE.md said v1 has no client upload links (2026-09-25). All three are updated in the same PR as this intent, and architecture.md logs the reversal.

## R1 impact (recorded 2026-10-25)
- R1 was fully built (01–08 + 03b; 09 volume test done), and staging/prod come next. Adding 10 means a new feature loop: intent, spec, plan, build, security tests, review. It needs the schema and architecture locks.
- [Likely] This takes about 3 weeks including review, plus the full Regression on top. It is built as **10a then 10b** (see Size).
- **Decided: a single R1.** Staging/prod and the pilot wait until 10 ships, and there is one release gate.
- **Accepted cost:** [Likely] the pilot slips at least one GST intake cycle. Re-check the pilot start against the GST cycle once 10's plan has an estimate.

## Problem
Clients send documents over WhatsApp and email. Staff then download each file, re-upload it to the vault and classify it by hand (client, type, period). The 06 reminder already tells the client *what* is missing, but gives no place to send it. Many requests are one-offs that no schedule covers, such as a rent agreement, a loan sanction letter, or a bank statement for a notice. Those are chased entirely by memory today.

**Cost:** staff time spent re-filing; files lost in chats; slower inbox age (metric 4); more chasing (metric 2), because "I sent it on WhatsApp last week" can't be checked; no record that an ad-hoc document was ever asked for.

## Proposed outcome
- Staff build a **request** for one client and send it as an **upload link** by email (vault-sent via Brevo) or WhatsApp (click-to-chat, as in 06). A request holds one or more **request items** of two kinds:
  - **Scheduled:** a pending expected item (04), chosen from the client's pending list.
  - **Ad-hoc:** staff choose four things. This covers "as needed" types and one-off requests.
    - a document **type** (required): any approved type, including "as needed" types, or a new type proposed through the 03 inline flow;
    - an optional **period**;
    - an optional **needed-by date**;
    - a short **note** shown to the client (e.g. "for the new office lease").
- **One link per request.** The link lists exactly those items and expires. Each request is the record of what was asked and when (feeds metric 2).
- The client opens the link on a phone without logging in, sees the listed items (with needed-by dates where set), and taps **Upload** on an item. Several files per item are allowed.
- **The item is identified by the button the client tapped.** The server checks that the item belongs to this link. The document is filed already classified: client, type and period [+ GSTIN/TAN] come from the item. There are no folders; "the folder" is the request item.
- **Received straight away, flagged "to review"; staff review is mandatory.**
  - A scheduled item becomes received at once (existing 04 linking).
  - An ad-hoc item becomes "received".
  - Every link upload is marked "from client link — to review". If staff reject or move it and nothing else remains, the item reopens.
- **Listed items only:** the client cannot upload anything that is not on the link.
- **Staff track ad-hoc requests** in two places:
  - **Client page:** a **Requested** list next to Expected, showing open / overdue (past needed-by) / received, with the request and send history.
  - **Today (06):** open ad-hoc items show on the Today of **the staff member who created the request**. They appear under overdue once past the needed-by date, or due this week when the date falls within it. Link uploads waiting for review show under "to review" (06's existing rule).

## Users & systems affected
- **New: an unauthenticated external uploader** (the client, or anyone holding the link). This is the first public write path into the vault.
- **Staff, all roles.** They build requests, send links, review uploads and see the Requested list and Today. Limited users can do this only for clients they can see; the roles are the same as Remind in 06.
- **Admin/Manager:** revoke links, settings.
- Systems:
  - new `upload_request` + `upload_request_item` (kind scheduled | ad-hoc; token hash, client, expiry, revoked, use counts; ad-hoc: type, period, needed-by, note, status);
  - upload route outside staff auth;
  - Storage signed uploads;
  - 03 `create_document` and inline proposed types;
  - 04 linking;
  - 06 Remind messages/`follow_up` and `today_items`;
  - 07 review status (to confirm in spec);
  - client page tabs;
  - `activity`, rate limiting.

## Success metrics
1. **Share of documents received through links:** ≥ 40 % of documents for pilot clients who were sent links, in the first month after launch. [Uncertain] This target is a placeholder; set the real one after 2 weeks of baseline.
2. **Inbox age (metric 4):** median time from receipt to classification for link uploads < 4 h (classification is automatic; review time only).
3. **Chasing load (metric 2):** reminders per requested item fall for link clients compared with non-link clients over the same cycle.
4. **Zero cross-client exposure:** no link ever shows or accepts anything outside its own client and listed items (security tests + review).
5. **Review accuracy:** share of link uploads that staff reject or move. Tracked, not targeted; high values mean metric 1 is being inflated by wrong uploads.
6. **Ad-hoc turnaround:** median days from request to received, and the share received by the needed-by date, for ad-hoc items. Baseline only.

## Constraints
- **Security (non-negotiable):**
  - **Link alone, no one-time code.** This is accepted because staff review is mandatory and because of the rules below.
  - The token is ≥ 128-bit random, stored **hashed**, and never logged.
  - Links expire (default 14 days, set in the spec), can be revoked, and cap the number and total size of uploads.
  - **Upload-only:** the page never shows existing documents, file names, PAN, full GSTIN or contact details. It shows the firm name, item names, ad-hoc notes and needed-by dates, and a masked registration label for per-GSTIN/TAN items.
  - **Ad-hoc notes are shown publicly (accepted):**
    - short (≤ 200 chars);
    - staff see a "no PAN / GSTIN / account numbers" hint;
    - the server rejects notes that match PAN/GSTIN/email/mobile patterns (same idea as `ACTIVITY_PII`).
  - Rate-limited per link and per IP; bot protection on the public route.
  - The allow-list, 25 MB limit and file-name rules from 03 still apply.
- **Metric 1 stays clean:** ad-hoc items are **not** expected documents. They never create `expected_doc` rows and never count in metric 1, which keeps its current definition. A passed needed-by date shows "overdue" on the Requested list and Today only.
- **Today:**
  - Ad-hoc items join 06's existing Today sections; there is no new screen.
  - Their owner is the request creator. This is a deliberate exception to 06's effective assignee (type → group → incharge), which still decides "Mine" for expected items.
  - Today's existing results for expected items must not change (06 tests stay green unedited).
  - If the creator is deactivated, the item falls back to the client's effective assignee (confirm in the spec).
- **Volume:** Today and the Clients list are already part of known issue **K3** (09: Today 14–20 s at 1,000 clients; it blocks rollout to all clients, not the pilot). The ad-hoc addition must be office-first and must not make K3 worse; re-time it.
- **Malware:** 03 accepted "no scan" because only staff uploaded. Files from outsiders change that risk. Decide in the spec: a scan, or "never preview inline, download-only until reviewed".
- **DPDP:** the upload page carries a short notice (who is collecting, why, contact).
- **Data residency:** files still go straight to the Mumbai bucket via signed upload URLs. The link text in a reminder passes through Brevo, as reminder content already does (06 accepted trade-off).
- **Architecture changes:** the direction is recorded in architecture.md on 2026-10-25; the details need the locks.
  - 06's rule "no links into the app" in reminder content;
  - a public route outside the staff-only auth model;
  - a new definer path for link uploads;
  - a new request-item entity alongside `expected_doc`;
  - the Today owner exception.
- **Release gate:** this is the first internet-facing write path. Before real client data is loaded, the release gate on staging adds a security check of the public route: token guessing, expired or revoked links, cross-client attempts, item IDs not on the link, oversize and disallowed files, rate limits.
- WhatsApp stays click-to-chat (no Business API).
- **Size:** about 3 weeks; built in two steps, both inside R1:
  - **10a:** request + scheduled items, public upload, review flag, send by WhatsApp/email.
  - **10b:** ad-hoc items, the Requested list, Today, revoke screen, metrics 5–6.

## Behaviour that must not change
- Staff-only login; Limited users still see only assigned clients and can only request for them.
- 03 filing, DOC-IDs, Inbox, versions, archive rules; 04 generation, linking and metric 1 definition; 06 Remind for clients who get no link; 06 Today for expected items.
- Private bucket with no app-role Storage policies; no PII in URLs or logs.

## Out of scope
- Client login / portal, client viewing or downloading anything.
- Uploads not tied to a listed item ("Other").
- Free-text ad-hoc items with no type.
- Ad-hoc items on the Clients list (overdue counts and the "Has overdue" filter stay expected-only).
- Ad-hoc items turning into recurring schedules (staff add a plan row in Settings as today).
- WhatsApp Business API intake (files sent to a WhatsApp number).
- Automatic scheduled link sending or automatic reminders for ad-hoc items (stays manual, like 06).
- OCR or auto-classification of what the client uploaded.

## Decisions (Raja + Kushal Associates, 2026-10-25)
- Release: single R1, including 10. Go-ahead for planning and repo work through deployment.
- Q2: one link per request, with a fixed list of items selected by staff and an expiry.
- Q3: received straight away, flagged "to review"; staff review is mandatory; reject/move reopens.
- Q4: link alone, no one-time code.
- Q5: listed items only.
- Q6: links also cover "as needed" types and ad-hoc document requests; ad-hoc items never count in metric 1; notes are shown publicly.
- Q7: optional needed-by date on ad-hoc items, shown as overdue on the client page and Today.
- Q8: a document type is required for every ad-hoc item.
- Q9: staff track ad-hoc requests on the client page (Requested list) and on Today.
- Q10: the same roles as Remind; Limited users only for clients they can see.
- Q11: an ad-hoc item shows on the Today of the staff member who created the request.

## Open questions
None at intent level. For the spec: expiry length, upload caps, malware approach, uploads against an item that was waived or received after the link was sent, reuse of 07's "to review" status, and the Today fallback for a deactivated creator.
