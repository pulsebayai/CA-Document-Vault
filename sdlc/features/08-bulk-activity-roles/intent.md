# Intent: Bulk actions, Activity and roles
Author: Raja (drafted with Claude) · Status: draft · Date: 2026-10-02
Roadmap item: 08-bulk-activity-roles · Release: R1 · Batch E (with 05; **05 holds the schema lock**) · Moves product metric: 5 (adoption: daily work in fewer clicks), plus the audit-trail promise of principle 3 ("every document has … a history")

## Problem
Four gaps remain before the pilot:
1. **One document at a time.** Staff preparing a return or answering an auditor need all of a client's documents for a period, e.g. GST, August. Today that means one download per document. Reviewing works the same way: 07 leaves every document filed before go-live at To review (R1 checklist "review backlog"), and a month's intake for a client is clicked through one by one.
2. **The audit trail is invisible.** Every action since 01 writes an `activity` row, but no screen shows it. "Who changed the incharge?", "who dispatched Form 16, and when?" and "what did Divya do today?" can only be answered with SQL.
3. **The roles screen isn't proven.** Settings › Users (01) shows a static "What each role can do" matrix. Some rows have drifted. "Reminders, retention, storage, office: Admin only" reads as if only Admin can remind, though every role can Remind since 06. No row covers review undo or dispatch undo (Admin/Manager since 07), and no test checks the matrix against what RLS actually enforces.
4. **Activity isn't scoped for Limited users.** `activity_select` lets every staff member, Limited included, read the whole office's activity. The rows hold only IDs and field names, never PII, but an Activity screen built on it would show Limited users events for clients they can't see.

**Cost:** slow return preparation, a backlog that buries Today, an audit trail nobody can use, and a permissions promise the pilot can't verify.

## Proposed outcome
- **Bulk select** on `/documents` results and Client › Documents. Checkboxes and "select all on this page" lead to two actions:
  - **Download as zip.** The selected documents' current versions are zipped **in the browser** from short-lived signed links (see Q1). Files are named `<DOC-ID> <file name>`. A progress indicator shows; failures are listed and the rest still download.
  - **Mark reviewed.** Applies to the selected To-review, classified, unarchived documents. The others are skipped, with counts ("18 reviewed · 2 skipped: in inbox"). Each document gets its own 07 history row.
- **Activity screen** (mockup 04, new nav item):
  - everything anyone did, newest first, grouped by day;
  - one plain sentence per event ("Ravi dispatched Original Form 16 · Rajesh Traders · DOC-…"), with names resolved at read time;
  - filters Staff · Client · Action · Date, and "Load earlier" (keyset paging).
  - The **document page** and **client page** get their own activity list, built from the same rendering.
- **Users & roles:** the matrix comes from one source of truth, matches what the app does today (03–07), and every cell is proven by an RLS test with one user per role. The R1 staging check runs this matrix by hand with one real user per role.
- **Activity visibility:** Admin, Manager and Staff see all office activity (they see all clients). Limited users see events for clients they can see, plus their own actions (see Q3).

## Users & systems affected
- **All staff:** bulk download and Mark reviewed, for documents they can see (same rule as 07).
- **Activity:** all staff, scoped per Q3.
- **Users screen:** Admin only (unchanged).
- **Systems:**
  - `/documents` and Client › Documents (selection);
  - storage signing (`src/lib/documents/storage.ts`, more links per call);
  - 07's `review_document` (called per document);
  - `activity` (read, plus the visibility policy, Q3);
  - header nav;
  - Settings › Users;
  - CSP `connect-src` for Storage downloads;
  - a zip library (new dependency).

## Success metrics
1. **Effort:**
   - downloading a client's month (≤ 30 files, ≤ 100 MB) = select all + 1 click, finished in < 60 s on office broadband;
   - marking 50 documents reviewed = select all + 1 click, < 10 s.
2. **Audit answerability (pilot):** "who did X to client/document Y, and when?" is answered from the Activity screen in < 30 s without SQL. Tested in the R1 staging checklist with 3 sample questions.
3. **Permissions proven (tests):** every matrix cell has a passing RLS/e2e test. A Limited user never sees an activity row, notification, document or file of a client they can't see.
4. **No PII leak:** no file name, remark, PAN, GSTIN, email or mobile is written to `activity`. The screen shows names by joining under RLS at read time.

## Constraints
- **No document bytes through our servers** (architecture: 25 MB files, Vercel limits). The zip is built in the browser from ≤ 60 s signed links issued after an RLS lookup, the same rule as single downloads.
- **Bulk writes are chunked** like the CSV import (≤ 200 per server action, browser-driven progress), with each document validated by the database as it is now.
- **No schema lock.** 08 adds no tables or columns. It can add its **own new functions** under the additive-only exception (06), e.g. `review_documents` and an `activity_feed` read function. The `activity_select` policy change (Q3) is a change to an existing object; see Q3 for how it's allowed.
- **No PII in URLs.** Activity filters in the URL are IDs, enums and dates only.
- **Volume:** the Activity screen loads in < 1 s at pilot volume (about 1 year of activity rows for 20 staff). It is measured in the pre-pilot volume test with the others; indexes are added only if it fails.

## Behaviour that must not change
- 07's single review and dispatch rules, and 07's history (bulk = N single reviews).
- 03's file security: signed links ≤ 60 s, issued only after an RLS check, and no Storage policies for app roles.
- 03b's search contract and paging.
- 01's invite, role change and deactivation flows, and the last-admin guard.
- Limited users see only their assigned clients.

## Out of scope
- Bulk archive, bulk re-classify and bulk dispatch (07 already dispatches many originals of one client in one packet).
- Zip of a whole client or FY beyond the selection cap (Q1). Server-side zip.
- Activity export to CSV, activity retention or purge rules (Later: retention & archive rules).
- A per-user permissions editor or custom roles: the four roles are fixed (principle 5).
- Showing staff sign-ins in the Activity screen by default (see Q4).

## Decisions for you (recommendations first)
- **Q1 Zip size cap:** **Recommended: ≤ 100 files and ≤ 300 MB per zip, built in the browser.** This is safe for browser memory on office PCs; above it, staff narrow the filter. The alternative is a server-side zip (a separate worker writing to Storage), which costs a new service and isn't needed for the pilot.
- **Q2 Bulk Mark reviewed:** **Recommended: a new `review_documents(ids[])` function** (additive-only exception). It calls 07's `review_document` per document, skips with a reason instead of failing all, and returns counts: one round trip per chunk. The alternative is a server-action loop over `review_document` (no migration, but about 200 round trips per chunk from Mumbai). Either way each document keeps its own history and activity row.
- **Q3 Activity visibility for Limited:**
  - **Recommended (a):** change `activity_select` so Limited users read only events of clients they can see, plus their own. This changes an existing policy outside the schema lock, so it needs your **scoped exception**: 08 may replace only `activity_select`. 05 only inserts activity rows and never touches that policy, so the two can't collide.
  - (b) The Activity screen filters, but the table policy stays open (a raw API read still returns IDs).
  - (c) Activity is Admin/Manager only in R1.
- **Q4 Sign-ins:** **Recommended: hidden by default; shown with Action = "Sign-ins"** (likely the most frequent event and the least useful; not measured). Alternative: always shown.
- **Q5 Where bulk select appears:** **Recommended: `/documents` and Client › Documents.** Alternative: `/documents` only (smaller, but "this client's August" means building a filter first).

## Open questions
Settled at the intent gate.
