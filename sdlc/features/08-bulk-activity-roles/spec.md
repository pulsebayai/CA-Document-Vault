# Spec: Bulk actions, Activity and roles
Intent: ./intent.md · Status: draft · Date: 2026-10-02
Screens: mockup 04 (Activity), 06 (Settings › Users and roles), 10 (Client › Documents, selection: no mockup), `/documents` (03b, no mockup).

## Where we start (verified in code, 2026-10-02)
- **Downloads** go through `getFileLink(versionId, mode)`: an RLS lookup as the user, then a ≤ 60 s signed link from `src/lib/documents/storage.ts` (the only signer). **Downloads write no activity** today. CSP `connect-src` already allows the Supabase origin.
- **Review:** 07's `review_document(id, 'reviewed')` per document (history row + activity row). `src/lib/review/actions.ts` wraps it.
- **Activity:**
  - `activity` is append-only, with index `(office_id, created_at desc)`.
  - `activity_select` = whole office for every role.
  - Rows carry IDs and field names only. about 45 distinct actions exist today (01–07; exact list built in AC-6's test); 05 adds 4.
  - The client is in `data.client_id` for most rows, but not all (e.g. `document.version_added`, `expected.*`).
- **Users & roles (01):** list, invite, role change, deactivate, last-admin guard, and a static 7-row matrix in `settings/users/page.tsx`.

## User stories & acceptance criteria
**Bulk select**
- **AC-1 Select.**
  - On `/documents` results and on Client › Documents (received-document rows; expected rows aren't selectable), each row has a checkbox, and the list header has "Select all on this page".
  - A sticky bar appears: "N selected · **Download zip** · **Mark reviewed** · Clear".
  - Selection is per page and cleared when filters, page or tab change. Checkboxes are labelled with the DOC-ID.
- **AC-2 Download zip.**
  - Allowed for **≤ 100 documents and ≤ 300 MB** in total (current versions' stored sizes, intent Q1). Above that the button is disabled with the reason: "Up to 100 files / 300 MB per zip; narrow the filter".
  - The browser asks the server for signed links in batches of ≤ 10 just before fetching them (each link lives ≤ 60 s and is issued only after an RLS lookup, like single downloads), fetches each file and streams it into a zip.
  - Entry name = `<DOC-ID> <stored file name>`. Zip name = `vault-documents-<YYYY-MM-DD>.zip` (no client names).
  - A progress dialog shows "Downloading 12 of 30…" with **Cancel**.
  - Files that fail (not visible any more, no file, network) are left out. The dialog then lists their DOC-IDs with "Retry failed"; the rest still save.
  - Archived and Inbox documents may be included when the user can see them (same as single download).
  - No activity row (same as single download).
- **AC-3 Mark reviewed.**
  - A confirm dialog: "Mark 48 documents reviewed? 2 will be skipped (in inbox)."
  - Eligible = visible, classified, not archived, status To review.
  - The browser sends chunks of ≤ 200 to one function call each, with progress. Each eligible document gets exactly what a single "Mark reviewed" gives: status, reviewer, a 07 history row and a `document.reviewed` activity row. Others are skipped with a reason (already reviewed · needs correction · in inbox · archived · not found).
  - Result: "46 reviewed · 2 skipped" with the skipped DOC-IDs and reasons.
  - Linked expected items behave as for single reviews (07/04 triggers).
- **AC-4 Who.** Anyone who can see the documents (07's rule, Limited included for their clients). A Limited user's selection can only contain visible rows, and the server re-checks every ID.

**Activity screen (mockup 04)**
- **AC-5 Feed.**
  - New nav item **Activity** for all staff; the page is `/activity`, in a centred column.
  - Title "Activity", subtitle "Everything anyone did, newest first" (Limited: "Your actions and your clients, newest first").
  - Rows are grouped by IST day ("Today, 2 October" / "Monday, 28 September"). Each row: time (HH:MM), a sentence ("Ravi dispatched Original Form 16") and a detail line ("Rajesh Traders · ROC · DOC-FY26-27-00111").
  - 50 rows per page, **Load earlier** (keyset on created_at, id). Empty and error states.
- **AC-6 Every action has a sentence.** One TS catalogue maps every known action to a sentence and detail. A unit test fails if an action string written anywhere in `src/` or `supabase/migrations/` has no entry. An unknown action still renders ("Ravi · doc_type.something").
  - Names (staff, client, type, group, DOC-ID) are resolved at read time with the viewer's RLS.
  - System rows (`actor_id` null) read "Vault" ("Vault generated 120 expected items").
- **AC-7 Filters.**
  - **Staff** (select).
  - **Client** (combobox using 02's `search_clients`; the client ID goes in the URL).
  - **Action** (categories: Documents · Review & dispatch · Expected · Reminders · Clients & plans · Catalogue · Users · Sign-ins).
  - **Date** (from–to, IST).

  The URL holds IDs, enums and dates only; search text never. Chips are removable, plus "Clear all" (03b pattern).
- **AC-8 Sign-ins hidden by default** (intent Q4). `auth.signed_in` rows show only with Action = Sign-ins.
- **AC-9 Links.** A row links to its document (DOC-ID), client or settings page when the viewer can see it.
- **AC-10 Document and client history.**
  - The document page gets an **Activity** card: that document's events, newest first, 20, then "See all in Activity" → `/activity?document=<id>`.
  - Client pages get an "Activity" link → `/activity?client=<id>`.
- **AC-11 Visibility (intent Q3a).**
  - Admin, Manager and Staff read every activity row of the office.
  - **Limited** read a row only if they are its actor, or its client is one they can see (`can_see_client`). The client is resolved from the row: `data.client_id`; or the entity (client → itself; document → `document.client_id`; expected item, follow-up, dispatch → their client; plan rows → their client). Rows with no client (catalogue, users, sign-ins, system generation) are visible to Limited only when they are the actor.
  - **Enforced in the `activity_select` policy** (RLS), not only on screen. Tested by reading the table directly.

**Users & roles**
- **AC-12 One matrix.** The "What each role can do" table comes from one source, `src/lib/auth/permissions.ts`, rewritten to match the app as built (01–08 and 05's approvals):

  | Can | Admin | Manager | Staff | Limited |
  |---|---|---|---|---|
  | See clients and their documents | All | All | All | Assigned |
  | Add documents and file the Inbox | Yes | Yes | Yes | Assigned + own Inbox |
  | Propose a new type while filing | Yes | Yes | Yes | No |
  | Review, mark needs correction, dispatch originals | Yes | Yes | Yes | Assigned |
  | Undo a review or a dispatch | Yes | Yes | No | No |
  | Archive or unarchive documents and clients | Yes | Yes | No | No |
  | Waive an expected document · Reopen | Yes · Yes | Yes · Yes | Yes · Yes | No · Assigned |
  | Undo a waive | Yes | Yes | No | No |
  | Remind clients (email, WhatsApp) and log calls | Yes | Yes | Yes | Assigned |
  | Change collection plans (add, remove types/groups) | Yes | Yes | Yes | No |
  | Assign incharge and group staff, pause and resume | Yes | Yes | No | No |
  | Manage catalogue, approve proposed types, Settings › Collection | Yes | Yes | No | No |
  | See Activity | All | All | All | Own + assigned clients |
  | Manage users and roles | Yes | No | No | No |

  Each value is checked against the code during build. Any cell that turns out different is corrected to what the code does and reported at the plan gate, never silently.
- **AC-13 Every cell proven.** `tests/rls/role-matrix.test.ts` imports the same matrix. For each row × role it runs that row's probe as the role's fixture user:
  - "Yes / All" → allowed;
  - "No" → refused;
  - "Assigned" → allowed on an assigned client and refused on another.

  The test fails if a row has no probe, so the screen can't drift from what is tested.
- **AC-14 Staging check.** Already listed in R1's checklist (one real user per role on staging, before real data). 08 adds the step list to `sdlc/releases/README.md`'s manual checklist.

**Speed**
- **AC-15**
  - Mark reviewed on 200 documents < 5 s per chunk (dev).
  - The first Activity page < 1 s on dev today. The pilot-volume timing (≈ 1 year: assume 200k rows) joins the pre-pilot volume test; indexes only if it fails (03b precedent).
  - A 30-file / 100 MB zip completes in < 60 s on office broadband (manual, staging).

## Functional requirements
- Bulk link issuing re-uses `getFileLink`'s rules in a batch action `getFileLinks(versionIds[])` (≤ 10). It returns per-ID link or error. Only `storage.ts` signs.
- **Zip library:** `client-zip` (streaming, store-only, ~3 kB, MIT). Files are already compressed (PDF/JPG), so no deflate. The zip is collected as a Blob (fits the 300 MB cap) and saved through an object URL.
- `review_documents(p_ids uuid[])` loops 07's `review_document` per ID inside its own sub-transaction (exception block), so one bad ID never undoes the others. It returns `[{id, result, reason}]`. ≤ 200 IDs per call.
- `activity_feed(p jsonb)` (SECURITY INVOKER read function) returns the page with display fields joined (actor, client, document code, type and group names) under the caller's RLS, plus the keyset cursor. Filters as AC-7, document filter as AC-10.

## Non-functional requirements
- **Security:**
  - No document bytes through our servers.
  - Links ≤ 60 s, issued after an RLS lookup.
  - The server re-validates every selected ID.
  - The Activity function is SECURITY INVOKER (RLS applies).
  - `activity_select` uses a SECURITY DEFINER helper `private.activity_client(entity_type, entity_id, data)` (tenant-first, `search_path = ''`) to find a row's client; for Admin/Manager/Staff the policy short-circuits before calling it.
- **Privacy:** no PII in activity (unchanged guard), URLs or zip names. Client names appear on screen only via RLS.
- **Accessibility:** WCAG 2.1 AA.
  - Checkboxes are labelled.
  - The selection bar is announced (`role="status"`).
  - The progress dialog has live counts.
  - The feed is a list with day headings.
  - Axe-clean; 390 px.

## Data model changes
**No schema lock.** 08 adds only its own objects, plus one approved policy replacement:
- New functions: `review_documents`, `activity_feed`, `private.activity_client` (additive-only exception, 06).
- **Replaced policy:** `activity_select` (intent Q3a, scoped exception, Raja 2026-10-02). 05 doesn't touch `activity`'s policies.
- No tables, columns or indexes.

## API / interfaces
- Server actions:
  - `src/lib/bulk/actions.ts`: `getFileLinks`, `markReviewedBulk` (chunk);
  - `src/lib/activity/` (`queries.ts`, `catalogue.ts` = action → sentence, `actions.ts` = load page).
- Matrix: `src/lib/auth/permissions.ts` (rows, values, probe IDs).
- Components:
  - `src/components/selection-bar.tsx`;
  - `src/components/zip-download.tsx` (client);
  - `/activity` page and filters;
  - the document page's activity card.

## UX flows & screens
- **Selection:** row checkboxes sit left of the DOC-ID. On phones the bar is fixed at the bottom with icon + label buttons.
- **Zip dialog** (shared Modal): progress bar, "N of M", Cancel; on finish "Saved 28 files · 2 failed" with the list and "Retry failed".
- **Mark reviewed:** confirm dialog → progress → result summary. The list refreshes.
- **Activity:** mockup 04 layout and copy. Filter chips styled as 03b's native-select chips.
- **Users page:** the matrix table from `permissions.ts` (same visual as today).
- **Every screen and dialog** has loading, error (retry) and empty states.

## Test strategy
| AC | Test | Lane |
|---|---|---|
| 1 | select/clear/per-page; labels | e2e `bulk.spec.ts` + unit |
| 2 | links only for visible docs, ≤ 60 s, ≤ 10 per call; cap enforced server-side too; zip contains the right entries and names (unzip in test); failed files listed | RLS `bulk.test.ts` + e2e (download event) |
| 3 | each eligible doc: status, history row, activity row; skips with reasons; partial failures don't roll back others; chunk > 200 refused; expected items re-link as single reviews | RLS |
| 4 | Limited: IDs of invisible docs return "not found", nothing changes | RLS |
| 5, 7–9 | feed order, day groups (IST), keyset paging, filters, sign-ins hidden by default, links | RLS `activity-feed.test.ts` + e2e `activity.spec.ts` |
| 6 | every action string has a sentence | unit `activity-catalogue.test.ts` |
| 10 | document card and client link | e2e |
| 11 | Limited reading `activity` directly sees only own + visible-client rows, across every entity kind; Staff+ see all | RLS |
| 12–13 | every matrix cell probed per role | RLS `role-matrix.test.ts` |
| 15 | 200-doc bulk review < 5 s per chunk; first feed page < 1 s | RLS (RUN_SLOW) |
| all screens | axe, 390 px | e2e |

- All new tests join the regression suite.
- Smoke-safe for prod: none (data-writing or test fixtures).
- **RUN_SLOW:** not required by CLAUDE.md (08 changes no 02/03 write path; the policy affects reads only). The AC-15 timings are RUN_SLOW tests and run in the nightly.

## Proposed architecture changes
1. **Activity visibility:** Staff+ read all office activity; Limited read own actions plus events of clients they can see (client resolved from the row's entity). This replaces "activity readable by all staff".
2. **Bulk pattern for files:** browser-side zip from just-in-time ≤ 60 s signed links; caps 100 files / 300 MB; no bytes through our servers.
3. **The permissions matrix is code** (`permissions.ts`), shown on Settings › Users and probed cell by cell in RLS tests.

The architecture lock goes to 05. 08's three items are flagged in its session log and applied on main at its merge.

## Spec decisions for you (recommendations first)
- **D1 Mark reviewed asks for confirmation** ("Mark 48 documents reviewed?"). *Recommended*: undo is Admin/Manager only and per document, so a mis-click on 200 rows is expensive. Cost: one extra click.
- **D2 Selection is per page** (cleared on page or filter change). *Recommended*: what you see is what you act on. The alternative, selection kept across pages, is easy to forget and riskier.
- **D3 Zip without compression** (store only). *Recommended*: PDFs/JPGs don't shrink, and it's faster and lighter on old PCs.
- **D4 Matrix corrections at the plan gate:** if a cell in AC-12 differs from what the code does, I report it and we decide per cell: fix the code (a new small task) or fix the matrix. *Recommended*: never silently.

## Risks & areas of concern
- **Policy change on `activity`:** a wrong rule could hide rows from Admin, or show Limited too much. Mitigation: AC-11 tests read the table directly for each role and each entity kind.
- **Browser memory at the 300 MB cap** on older office PCs. Mitigation: cap and store-only; measured on staging.
- **Supabase Storage CORS for `fetch`** (single downloads use navigation, not fetch). Verified in step 1 of the plan before building the zip; if blocked, fall back to the server issuing links with `download` and no zip (raise at once).
- **Header and Client › Documents overlap with 05**: header bell (05) vs Activity nav (08). 05 doesn't touch Client › Documents.
- **Activity volume:** the Limited policy calls a helper per row. Measured in the volume test.

## Out of scope
As in the intent. Also: bulk "Needs correction", download of older versions, activity CSV export.
