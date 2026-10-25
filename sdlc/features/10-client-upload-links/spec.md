# Spec: Client upload links
Intent: ./intent.md · Status: draft · Date: 2026-10-25
Screens:
- No mockup exists for the client page or the request flow. The new screens follow `references/ui-reference.md` tokens and components; an agreed deviation row is added there.
- Staff screens extended: `01-today.jpg` (Today rows), `10-client-documents.jpg` (Remind on expected rows), Client › Expected / new **Requested** tab.

## Key definitions
- **Request** = one `upload_request` for one client: a set of **items**, one link, one expiry. Created by one staff member (the **requester**).
- **Item** (`upload_request_item`):
  - **scheduled:** points at one pending `expected_doc` of that client;
  - **ad-hoc:** a document type (required), optional period, optional **needed-by** date, a public **note** (≤ 200 characters).
- **Link** = `https://<vault>/u#<token>`. The token is 32 random bytes (base64url), shown once, stored only as a SHA-256 hash. **It sits after `#`**, so browsers never send it to the server, Vercel logs or a WhatsApp link preview. The page reads it in the browser and sends it in POST bodies only.
- **Link states:** Active · Expired (past `expires_at`) · Revoked · Closed (every item is closed: received, waived, cancelled). Only Active links accept uploads.
- **Link upload** = a document created through a link. Its channel is the new value **`upload_link`**, and it is **owned by the requester** (`received_by`, `uploaded_by`, `created_by`; see decision D1). It starts at 07's **To review**, like every new document, which is the mandatory review.
- **Ad-hoc item state** (derived, like 04's): Open · Overdue (open and past needed-by, IST) · Received (≥ 1 linked document that counts as received under 07's rule: not archived, not Needs correction) · Cancelled (staff, with reason).

## User stories & acceptance criteria
**Building and sending a request (staff)**
- AC-1 The **Remind dialog** (06) gains **"Include upload link"** (off by default). When it's ticked:
  - the ticked expected items become the request's scheduled items;
  - **"+ Request another document"** adds ad-hoc items: type picker (the client's plan types, all approved client-source types, or 03's inline proposed type for Staff+), optional period, optional needed-by date (today or later), note;
  - the preview shows the link line ("Upload here: <link>") exactly as it will be sent.
- AC-2 **Send email / Open WhatsApp** with the link ticked creates, in one call:
  1. the request and its items;
  2. 06's follow-up for the scheduled items (so metric 2 and the per-day email cap apply unchanged).

  The token is shown only in that message. Email uses 06's two-phase send. If the email fails, the request is created but marked **not sent**, and Retry re-sends the same link.
- AC-3 A request needs ≥ 1 item. Scheduled items must be pending and belong to the client. Ad-hoc type must be usable for the client. A client with no email can still use WhatsApp, and vice versa (06's rules).
- AC-4 **Notes are checked:** ≤ 200 characters; the server rejects text matching PAN, GSTIN/TAN, email, mobile or 9+ digit account-number patterns ("Notes are shown to anyone with the link — remove numbers and IDs"). The same check runs in TS for an inline message and in SQL as the guard.
- AC-5 **Roles:** anyone who can Remind the client (06: all roles, Limited for their clients only) can send a request with scheduled items. **Ad-hoc items with a new proposed type need Staff+** (03's rule). Permission-matrix rows are added: "Send upload links" and "Revoke upload links" (every cell probed, 08).

**The client page (public)**
- AC-6 Opening the link on a phone (≤ 390 px) shows:
  - the firm name;
  - "Requested by <staff first name> on <date> · open until <date>";
  - one card per item: "GST · Purchase invoices · September 2026" (per-registration items name the state, never the GSTIN), the needed-by date, the note, the files uploaded **in this browser session**, and an **Upload** button (multiple files);
  - a short DPDP notice (who collects, why, contact = the firm's email from settings);
  - no other data: no PAN, GSTIN, client code, existing documents, file names from other uploads, staff emails or mobiles.
- AC-7 **Upload:** for each file the browser asks the server for a ticket, PUTs the file straight to storage (03's signed-upload path), then asks the server to register it. Before issuing a ticket, the server checks:
  - the token hash matches an Active link;
  - the item belongs to that link and is still open for uploads (D4);
  - 03's file rules (extension allow-list **minus ZIP**, D3; ≤ 25 MB; sanitised name);
  - the link's caps (≤ 30 files, ≤ 300 MB total; D5).

  Each registered file becomes **one document** classified by the item (client, type, period [+ registration]). Its DOC-ID follows 03's rules, `received_on` = upload date (IST), `received_as` = soft copy, and its remark is empty.
- AC-8 **Errors are plain and leak nothing:** an unknown, expired or revoked token shows the same page ("This link is no longer active. Please ask <firm> for a new one."), never which case it is. A file over the limit or of the wrong type is refused before upload with the rule shown. A cap reached shows "This link has received the maximum number of files."
- AC-9 **Rate limits** (database-backed, per office):
  - ≤ 20 failed token lookups per IP per 10 minutes, then the "not active" page for that IP for 10 minutes;
  - ≤ 60 upload tickets per link per hour.

  Throttled requests are refused before any storage call. The IP is stored hashed, kept 7 days, and never written to activity.
- AC-10 The page sends `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, `Cache-Control: no-store` and the existing CSP. Signed-out staff routes still redirect to /login; only `/u` and its server actions are public.

**Staff side after upload**
- AC-11 A scheduled item's expected document links through 04's trigger (client + type + period + registration), so it becomes **Received** at once (intent Q3).
- AC-12 An ad-hoc item links through the document's `upload_request_item_id` and becomes Received. If staff mark that document **Needs correction** or archive it, and no other counting document remains, the item goes back to Open (mirrors 07).
- AC-13 Link uploads appear in 06's **To review** rows and counts **on the requester's Today** (D1 makes the requester the owner). They carry a **"From client link"** badge everywhere documents are listed (Client › Documents, `/documents`, document page). The channel facet shows "Upload link".
- AC-14 **Malware stance (D3):** link uploads are **download-only until reviewed**. The inline "View" is hidden for a link upload in To review; after Mark reviewed it behaves like any document. ZIP is refused for links.
- AC-15 **Notification (D6):** the requester gets one in-app bell notification per link per day when files arrive ("3 files arrived for <client>'s request"), IDs only, using 05's `notification` table with a new kind.

**Tracking ad-hoc requests**
- AC-16 **Client › Requested** tab (count of open ad-hoc items in the tab label): ad-hoc items newest first, with type, period, note, needed-by, state, requester, link state, and "N files". Actions:
  - **Upload** (staff file it themselves; Add document pre-filled and linked to the item);
  - **Cancel** (reason ≤ 300);
  - **Reopen** a received item (as 04's Reopen).

  Below the items: the client's **requests** (date, requester, channel, items, link state) with **Revoke** and **Send again**.
- AC-17 **Today:**
  - open ad-hoc items appear on the **requester's** Today (Mine) and in Everyone, as rows "Requested · Group · Type [· Period]";
  - Overdue when past needed-by, Due this week when needed-by is within 7 days;
  - items with no needed-by date appear only in a "Requested" count, not as rows (D7).

  Counts gain **Requested**. Expected rows, counts and order for expected items are unchanged (06 tests unedited).
- AC-18 **Revoke:** the requester or Admin/Manager. It takes effect immediately and can't be undone; the client sees the "not active" page. **Send again** creates a new request with the still-open items and a new token; the old link is revoked in the same call.
- AC-19 **Expiry:** default **14 days** from creation (D2). Items stay tracked after expiry; only the link stops working.

**Integrity, audit, metrics**
- AC-20 **No cross-client exposure:**
  - a token maps to exactly one client and office;
  - an item ID from another link or client is refused (`ITEM_NOT_ON_LINK`);
  - the registration function derives client, type, period and registration from the item, never from the browser.

  RLS-tested with two clients, two offices and a forged item ID.
- AC-21 **Activity** (IDs only, no note text, no IP): `upload_request.created`, `upload_request.revoked`, `upload_request.sent` (via 06's reminder rows), `upload_request_item.cancelled`, `upload_request_item.reopened`, and `document.created` with `data.via = 'upload_link'` and the request ID. **Actor = null** (the client) for link uploads. 08's feed gets a sentence for each, e.g. "Client uploaded DOC-FY26-27-00123 via link from Priya's request".
- AC-22 **Metric 1 unchanged:** ad-hoc items never touch `expected_doc` or `collection_metric` (test: metric identical before and after ad-hoc activity).
- AC-23 **Settings › Collection** (Admin/Manager) adds, for the last 30 days:
  - share of documents received through links (intent metric 1);
  - median hours from upload to review for link uploads (metric 2);
  - share of link uploads marked Needs correction or re-filed (metric 5);
  - ad-hoc turnaround: median days request → received, and the share received by needed-by (metric 6).

## Functional requirements
- **Token handling** `src/lib/upload-links/token.ts`: generate (32 bytes, `crypto.randomBytes`), hash (SHA-256 hex), and build the link with `#`. The raw token exists only in the server action's return value and the message; never logged (unit test with a logger spy).
- **Staff functions** (SECURITY INVOKER, one per action, RLS applies, one activity row):
  - `create_upload_request(p jsonb)`: client, items, channel; returns the request ID. The token hash is passed in from the server action, which keeps the raw token.
  - `revoke_upload_request(p_id)`, `cancel_request_item(p_id, p_reason)`, `reopen_request_item(p_id)`, `resend_upload_request(p_id, p_token_hash)`.
  - **06's send functions** take an optional request ID so the follow-up and request are created together (`begin_email_reminder`, `record_follow_up`).
- **Public functions** (SECURITY DEFINER, **service-role only**, called only from `src/lib/upload-links/public.ts` on the server):
  - `link_open(p_token_hash, p_ip_hash)` → page data or `NOT_ACTIVE`;
  - `link_ticket(p_token_hash, p_item_id, p_file jsonb, p_ip_hash)` → ticket data;
  - `link_register(p_token_hash, p_item_id, p_ticket jsonb)` → reads the stored object from `storage.objects` (03's rule) and creates the document.

  Each checks token → office (tenant first) → link state → item → caps → rate limits, in that order.
- **Document creation for link uploads:** a private core shared with `create_document`, so DOC-ID, versions, 03's triggers, 04's linking and 07's status stay one code path. It sets the transaction flag `app.link_upload` = item ID, which lets 03's trigger accept the requester as `created_by`/`uploaded_by` with no signed-in staff (D1).
- **Today:** `today_items` (06) gains ad-hoc rows and the Requested count; the existing expected-item query is untouched. It is office-first, and its timing is re-measured against K3.
- **Message builder** (06's `src/lib/reminders/message.ts`): adds the link line and ad-hoc lines ("Rent agreement — for the new office lease — by 5 Nov"). Its unit tests still forbid PAN/GSTIN/DOC-ID/remarks; the link is the only URL allowed.

## Non-functional requirements
- **Security:**
  - token ≥ 256 bits, hash only, constant-time compare (lookup by hash);
  - the token never in a URL path or query, so never in server logs, referrers or link previews (AC-10);
  - generic errors (AC-8);
  - public functions are service-role-only, with EXECUTE revoked from anon and authenticated;
  - the service-role key stays in server-only modules (ESLint fence extended to `src/lib/upload-links/public.ts`);
  - no Storage policies (03's rule kept).
- **Privacy (DPDP):** the page shows only AC-6 data. The IP is hashed with a server secret (`LINK_IP_SALT`), kept 7 days (purged by the daily job), and never in activity. Notes pass the PII guard.
- **Performance:** page open ≤ 500 ms server time; ticket and register ≤ 1 s each; Today with ad-hoc rows within its existing budget (re-timed at volume; K3 must not get worse).
- **Accessibility:** WCAG 2.1 AA on the public page (axe), ≤ 390 px, large touch targets, upload progress announced (`aria-live`), and file errors next to the item.
- **Reliability:** a failed upload can be retried from the same page. A registered file is never lost if the page closes after the PUT, because register is idempotent per ticket. An orphan object with no registration is handled like 03's orphans.

## Data model changes (schema lock: 10)
- **Enums:**
  - `doc_channel` + `upload_link`;
  - `notification_kind` + `link_upload`;
  - new `upload_item_kind` (scheduled, ad_hoc) and `upload_item_status` (open, received, cancelled).
- **`upload_request`:** `id`, `office_id`, `client_id`, `token_hash` (unique), `created_by`, `created_at`, `expires_at`, `revoked_at`/`revoked_by`, `max_files` (30), `max_bytes` (300 MB), `files_count`, `bytes_total`, `replaced_by` (send again), `follow_up_id` (nullable, 06).
- **`upload_request_item`:**
  - `id`, `office_id`, `request_id`, `kind`, `expected_doc_id` (scheduled);
  - `doc_type_id`, `period_id`, `registration_id`, `needed_by`, `note` (ad-hoc);
  - `status`, `received_on`, `cancel_reason`, `cancelled_by/at`.

  Checks: the scheduled kind has `expected_doc_id`, and the ad-hoc kind has `doc_type_id`.
- **`document.upload_request_item_id`** (nullable FK, indexed): the item a link upload or Requested-row filing belongs to.
- **`link_attempt`:** `office_id`, `ip_hash`, `request_id` nullable, `kind` (lookup_failed | ticket), `at`. Indexed (ip_hash, at) and (request_id, at). Purged after 7 days.
- **RLS:** requests, items and attempts are visible iff the user can see the client (attempts are never visible to app roles). No app write policies; functions only (04's pattern). The new tables cascade on test-office purge, and `reset_test_office` is updated to include them (10 holds the lock).
- **Triggers:**
  - 03's `document_before_write` accepts `app.link_upload` (the requester as owner, no signed-in staff);
  - an AFTER trigger on `document` maintains ad-hoc item status, the same pattern as 04's and with the same WHEN-on-status trigger as 07.

## Existing code affected
- **06:**
  - Remind dialog (`src/app/(app)/clients/[id]/remind-dialog.tsx` or equivalent);
  - message builder;
  - `begin_email_reminder` / `record_follow_up`;
  - `today_items` and the Today page;
  - Settings › Collection.
- **03:** `create_document` (extract the core), `document_before_write`, the storage-core ticket/verify helpers (reused, not changed).
- **04:** none, since linking already matches.
- **05:** `notification` kind and bell text.
- **07:** the document row badge; View hidden for unreviewed link uploads.
- **08:** activity sentences, the permissions matrix and probes, `/documents` channel facet.
- **Shared:** `src/lib/supabase/proxy.ts` (`/u` public), CSP headers for `/u`, the client page tabs.
- **New:** `src/app/u/` (public page, outside the `(app)` group), `src/lib/upload-links/`.
- **Characterization:** 03's `create_document` and 06's `today_items` are covered by existing tests, which must stay green unedited after the extraction.

## Backward compatibility & data migration
- No data migration. Existing documents get `upload_request_item_id = null`.
- Existing reminders keep working: "Include upload link" is off by default.
- The new enum values are additive.
- `reset_test_office` change: test offices only, covered by its existing test.

## API / interfaces
- **Staff server actions (POST):** `sendRemindWithLink(...)` (extends 06's send actions), `revokeRequest(id)`, `resendRequest(id)`, `cancelItem(id, reason)`, `reopenItem(id)`, `clientRequests(clientId)`.
- **Public server actions** (POST, no session; token in body): `openLink(token)`, `startLinkUpload(token, itemId, file)`, `finishLinkUpload(token, itemId, ticket)`.
- **New env vars:** `APP_PUBLIC_URL` (the link base per environment), `LINK_IP_SALT` (server-only). Both go in `.env.example` and the R1 env checklist.

## UX flows & screens
- **Remind dialog:**
  - an "Include upload link" toggle;
  - an ad-hoc item row editor;
  - a preview with the link line;
  - after send: "Link sent · open until 8 Nov · Revoke".
- **Public page:**
  - a single column: firm header, request line, item cards, DPDP footer;
  - per-file progress and "Uploaded ✓";
  - states: loading, not active, cap reached, offline/error with Retry.
- **Client › Requested:** a list, as above.
- **Today:** "Requested" rows and count.
- **Document rows:** the "From client link" badge.

## Test strategy
| AC | Test | Suite |
|---|---|---|
| 1–5 | request creation with follow-up in one call; email failure → not sent + Retry with the same link; item validation; note PII guard (TS + SQL, each pattern); role matrix rows probed | RLS/DB + unit + e2e |
| 6–10 | page shows only allowed fields (snapshot of the data payload: no PAN/GSTIN/code/emails); upload happy path; ZIP and oversize refused; caps; the same response for unknown/expired/revoked; IP and link throttles; headers; `/u` public while staff routes still redirect; ≤ 390 px; axe | e2e + RLS/DB |
| 7, 20 | forged item ID, item from another link, another client, another office, expired, revoked, after cap → all refused; client/type/period derived from the item | RLS/DB |
| 11–12 | scheduled item received via 04 linking; ad-hoc received; Needs correction / archive reopens; a second document keeps it received | RLS/DB |
| 13–15 | To review on the requester's Today; badge; View hidden until reviewed; one notification per link per day | RLS/DB + e2e |
| 16–19 | Requested tab actions; revoke and send again (old link dead, new link works); expiry boundary (IST); today rows/counts; **06's existing Today tests unchanged** | RLS/DB + e2e |
| 21–23 | activity rows IDs only, actor null, no note/IP; feed sentences (coverage test); metric 1 unchanged; Collection figures on fixtures | RLS/DB + unit |
| token | generation length/entropy; hash; never logged (logger spy); link built with `#` | unit |
| timed | Today and page timings at volume (K3 not worse) | volume (before R1 rollout) |

All new tests join the regression suite. **Smoke-safe for prod:** one read-only check that `/u` with no fragment renders the "not active" page with the right headers.

## Proposed architecture changes (architecture lock: 10; written to architecture.md in 10's PR)
1. **Public route pattern:**
   - token in the URL fragment;
   - service-role-only definer functions behind server-only modules;
   - tenant → link → item → caps → throttle order;
   - generic errors;
   - hashed-IP throttling table with 7-day retention.
2. **Link uploads are owned by the requester** (`app.link_upload` flag in 03's trigger); activity actor null with `via = 'upload_link'`.
3. **Malware stance for client uploads:** ZIP refused; download-only until reviewed; no scanner in R1 (accepted risk, revisit after the pilot).
4. **Ad-hoc items** as a second expectation kind outside metric 1, with their own linking trigger. `document.upload_request_item_id` is the link.
5. `reset_test_office` covers 10's tables. New enum values: `doc_channel.upload_link`, `notification_kind.link_upload`.

## Risks & areas of concern
- **Biggest change since 01:** the first unauthenticated write path. Mitigation: AC-20 tests, the R1 security checklist, and the sdlc-reviewer's security pass. [Likely] A second reviewer pass on `link_*` functions is worth the time.
- **03 core extraction** touches the filing path used by everything. Mitigation: characterization by the existing 03/04/07 suites, RUN_SLOW before merge (02/03 write path rule).
- **Today is in K3** (14–20 s at 1,000 clients). Adding rows could make it worse. Mitigation: a separate office-first branch of the query, re-timed; pilot volume (30 clients) is unaffected.
- **Forwarded links:** anyone holding one can upload until expiry. Accepted (intent Q4). Mitigations: mandatory review, download-only until reviewed, caps, revoke.
- **WhatsApp:** the link is in the chat text the staff member sends; the fragment keeps the token out of WhatsApp's link-preview fetch. [Uncertain] Whether every WhatsApp client preserves the `#` fragment when the link is tapped needs a manual check on Android and iOS (step 1 spike).
- **Size:** [Likely] ≈ 3 weeks. Split as 10a (AC-1–14, 20–22) and 10b (AC-15–19, 23), both before the R1 gate.

## Out of scope
Client login or portal; clients viewing or downloading; "Other" uploads; automatic or scheduled link sends; reminders for ad-hoc items; a malware scanner; CAPTCHA; the WhatsApp Business API; links covering more than one client; multi-language pages.

## Decisions for Raja (recommendation first)
- **D1. Who owns a link upload?** The **requester** becomes `received_by` / `uploaded_by` and gets it on Today (recommended: the schema needs a staff owner, and the requester chases it). Alternative: the client's incharge.
- **D2. Link expiry:** **14 days** (recommended) · 7 · 30.
- **D3. Malware stance:** **no scanner in R1; ZIP refused for links; link uploads download-only until reviewed** (recommended). [Likely] An India-resident scanning service would add a new provider and cost. Alternative: also refuse XLS/DOCX (macros). That's safer, but clients often send Excel.
- **D4. Item already received or waived after the link was sent:** received → **still accepts more files** ("add more"); waived/cancelled → **hidden and refused** (recommended).
- **D5. Caps per link:** **30 files / 300 MB** (recommended; mirrors 08's bulk sizes) · or 50 / 500 MB.
- **D6. Bell notification to the requester when files arrive** (one per link per day): **yes** (recommended). Today's To review also shows the files.
- **D7. Ad-hoc items with no needed-by date:** shown only in the **Requested** count on Today, not as rows (recommended, keeps Today short). Alternative: always rows.
- **D8. Bot protection:** **no CAPTCHA**; a 256-bit token plus IP and link throttles (recommended). A CAPTCHA would add a third-party script to a page clients open on phones, and a new CSP origin.
