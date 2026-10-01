# Intent: Document search
Author: Raja (drafted with Claude) · Status: approved (Raja 2026-09-29 21:54) · Date: 2026-09-29
Roadmap item: 03b-document-search (split out of 03 on 2026-09-28) · Release: R1 · Moves product metric: 3 (catalogue convergence, indirectly: types become filters people rely on); supports principle "found in seconds" (vision)

## Problem
Since 03, every received document is filed once with its client, type, period, registration, how it arrived and who received it. The only ways to find one are to open the client's Documents tab and scroll, or to know the DOC-ID and edit a URL. Questions staff ask every day have no answer in the vault:
- "Where is DOC-FY26-27-00123?"
- "Which originals are we holding?"
- "What came in by courier this week?"
- "Which files did Priya receive in August?"
- "The file called *ledger* for Sankar"

When the vault can't answer, staff go back to WhatsApp, email search and memory. That undermines "if it isn't in the vault, it wasn't received".

**Cost:** time lost hunting, repeat requests to clients for documents already received, and low trust in the vault during the pilot.

## Proposed outcome
Staff can find any document they are allowed to see **in seconds**, from anywhere in the app:
- **Header search box** (mockup header: "Search clients, documents, DOC id…", `/` to focus):
  - As you type, a short dropdown lists matching **clients** (name, code, PAN, GSTIN, previous reference; 02's search) and **documents** (DOC-ID, file name, remark).
  - An exact DOC-ID jumps straight to the document.
  - Enter or "See all results" opens the results page. (Raja 2026-09-29, Q1)
- **Results page `/documents`**, reached from the header search. There is no new top-nav item; the nav stays as in the mockup (Q2).
  - It filters on every dimension: client, group, type, FY, period, GSTIN/TAN.
  - It also filters on these facets: status, received as, channel, received by, date received, classified or in Inbox.
  - Facets show counts. Results are sorted newest first and paged, and each row opens the document.
- **Archived documents** are hidden by default. Anyone can include them with a toggle, for documents they can already see, and each result carries an "Archived" badge (Q3).
- **No export** in 03b. Bulk zip download stays in 08 (Q4).

## Users & systems affected
- All staff roles. Results follow the existing visibility rules exactly: Limited users see only their clients' documents and their own Inbox items (RLS, 03 AC-12).
- Systems: new read-only SQL search function(s) over `document`; the app header; a new `/documents` route. Possibly search indexes (trigram on file name/remark, composite on dimensions). These come as the **last step, after 04 merges, and only if the volume test needs them** (Batch C rule).

## Success metrics
1. **Find time:** a staff member finds a named document from a verbal description (client + type/period, or a file-name fragment, or a DOC-ID) in **≤ 10 s median**, starting from any page. This is a timed manual check on 5 lookups by a Staff-role user, recorded in the PR and re-run on staging for R1.
2. **Speed at volume:** header suggestions return in < 300 ms, and the results page in < 1 s server time, with **100k documents** in one office (volume test, RUN_SLOW). Assumption: 1,000 clients × ~15 scheduled types × 12 periods plus ad-hoc files ≈ 50–100k documents a year.
3. **Zero leaks:** search never returns a document, client or count the user couldn't open directly. This is tested across the 4 roles, including facet counts and the dropdown.

## Constraints
- **No search text in URLs, logs or analytics.** Typed text may be a client name or PAN (architecture: PII searches go through server actions, not the URL). Filter values that are IDs (UUIDs, enum values) may sit in the URL so Back and refresh keep the filters.
- **Read-only.** 03b changes no data and adds no tables. A migration is needed only for search functions/indexes, **after 04 merges** (04 holds the schema lock).
- Results use the existing RLS. No SECURITY DEFINER search, and facet counts are computed under RLS as well.
- The mockup is the UI source (header, 03's list styling). WCAG 2.1 AA: the dropdown is a keyboard-operable combobox, and the `/` shortcut doesn't fire while the user is typing in a field.
- Must stay fast on the Mumbai DB from Vercel bom1.

## Behaviour that must not change
- 03's Inbox, Client › Documents, document page and filing flow.
- 02's Clients list search. The header box reuses its matching rules but doesn't replace the Clients page search.
- Limited users' visibility.

## Out of scope
- Export (CSV) and bulk download (08).
- Full-text search *inside* files (OCR/content). Only metadata, file name and remark are searched.
- Saved searches.
- Expected-document facets ("pending/overdue"). These live in 04's screens, and 06 Today.
- A "Documents" top-nav item. Activity search (08).

## Decisions (Raja 2026-09-29)
- Q1: the header box finds clients and documents; an exact DOC-ID jumps straight to the document.
- Q2: `/documents` is a results page with no nav item.
- Q3: archived documents are hidden, with an opt-in toggle.
- Q4: no export.
- The "Received by" facet lists everyone who appears on a visible document, with deactivated staff marked.
- Results show 50 per page, newest received first, with a sort switch (date received / date added / DOC-ID).

## Open questions
None. All were settled at the intent gate on 2026-09-29.
