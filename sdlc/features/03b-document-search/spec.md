# Spec: Document search
Intent: ./intent.md · Status: approved (Raja 2026-09-29 22:52) · Date: 2026-09-29
Screens: mockup header (references/mockup/01-today.jpg: "Search clients, documents, DOC id…" with the "/" hint). The results page `/documents` is **not in the mockup**. It uses 03's list styling (Inbox rows, mockup 02) and the Clients filter chips (mockup 03); this is recorded as an agreed deviation in ui-reference.md.

## Key definitions
- **Searchable text** = a document's DOC-ID, its current file name, and its remark. Clients are searched as in 02: name, code, PAN, GSTIN and previous reference, through `search_clients`.
- **Visible** = the user can open it directly, under 03's AC-12 rule (RLS). Search never shows more.
- **Filters** = dimension and facet choices. They are all IDs or enum values, so they may sit in the URL.
- **Search text** = whatever the user typed. It is never put in a URL, log or analytics event.

## User stories & acceptance criteria
**Header search (every page)**
- AC-1 The header has a search box, "Search clients, documents, DOC id…".
  - Pressing `/` focuses it, unless focus is already in an input, textarea, select or editable element.
  - The box is a keyboard-operable **combobox** (ARIA 1.2): arrow keys move through options, Enter opens the highlighted one, and Esc closes the list.
  - Below 640 px it collapses to a search button that opens a full-width search field, so the header still fits 390 px.
- AC-2 After 2+ characters, with a 250 ms pause, a dropdown shows up to 5 **Clients** and up to 5 **Documents**.
  - Client entries show name · code, using 02's matching.
  - Document entries show DOC-ID · type · period · client (or "Inbox") · file name.
  - The last entry is **"See all results for '…'"**.
  - Loading and empty states are announced to screen readers.
- AC-3 Typing a complete DOC-ID (for example `doc-fy26-27-00123`, any case, surrounding spaces ignored) and pressing Enter opens that document directly, if the user can see it. Otherwise the user sees "No document DOC-FY26-27-00123 that you can open".
- AC-4 "See all results", or Enter without a highlighted option, opens `/documents` with the text carried over. The text is handed over **in the browser tab's session storage, not the URL**.

**Results page `/documents`**
- AC-5 The page lists visible documents matching the text (if any) and the filters, 50 per page.
  - Default sort: newest received first.
  - A sort switch offers: Date received (newest) · Date added (newest) · DOC-ID (newest).
  - Each row shows DOC-ID, type · period, client (or "Inbox"), group, received on + by, received as (Hard copy / Original badges), channel, the current file name (or "Hard copy — no file"), and an Archived badge when relevant.
  - A row opens `/documents/[id]`. The page shows the total, "N documents".
- AC-6 **Filters** can be combined:
  - client (picker using 02's search);
  - group → type (types of the chosen group); FY → period (periods of the chosen FY and kind);
  - GSTIN/TAN (only when a client is chosen);
  - received as, channel, received by, received from/to dates, status, and Classified / Inbox;
  - **Include archived**, off by default (Q3).
  - Filters appear as chips with ✕ to clear each one, plus "Clear all".
  - Filters live in the URL, so Back, refresh and a shared link work. The text doesn't: after a refresh it is restored from session storage in the same tab only.
- AC-7 **Facet counts:** group, received as, channel, received by and status show how many *visible* documents match the current text and the other filters. For example, "Courier (12)".
  - "Received by" lists everyone who received a visible matching document. Deactivated staff are marked "(inactive)".
  - A value with 0 results is not listed.
- AC-8 Text matching is case-insensitive and partial on the file name and remark, with prefix/exact matching on the DOC-ID. Two or more words must all match, in any of the three fields (AND across words, OR across fields). Characters like `%`, `_` and `\` are treated as plain text.
- AC-9 **Empty states:**
  - With no text and no filters, the page shows the newest documents.
  - With no match, it says "No documents match" and offers "Clear filters".
  - Loading and error states follow 02's `states.tsx`.

**Access & privacy**
- AC-10 Results, totals, facet counts and dropdown entries **never include anything the user couldn't open directly**. This is proven with the 4 roles × assigned/unassigned client × classified/Inbox × own/others' documents, as in 03 AC-12.
- AC-11 **Search text never leaves the server action.**
  - It is not in any URL (page, `router.push`, links), log line (server errors log only a code and a request ID), activity row or analytics event. An e2e test checks every navigation URL during a search flow.
  - Search is read-only and writes no activity.

**Performance (volume test, RUN_SLOW)**
- AC-12 These targets apply with **100k documents** in one test office, from the Vercel region (bom1) to the Mumbai DB:
  - Header suggestions: < 300 ms server time.
  - Results page (first page, with facets): < 1 s.
  - A Limited user's search: < 1 s. That user sees about 5% of clients, so RLS filters most rows.
  - Indexes are added only if these targets fail without them (roadmap rule).
- AC-13 **Find-time check (success metric 1):** a Staff-role user finds 5 described documents in ≤ 10 s median, starting from any page. This is a timed manual check recorded in the PR, and re-run on staging for R1.

## Functional requirements
- **Suggestions:** one server action returns clients (via `search_clients`, limit 5) and documents (via `search_documents`, limit 5) in parallel, plus an exact DOC-ID hit if there is one.
- **Search:** `search_documents(p jsonb)` is SECURITY INVOKER, so RLS applies.
  - It returns one page of rows plus the total. Inputs: text, filters, sort, page and include_archived.
  - The text is split into up to 5 words of ≤ 50 characters each; longer input is cut.
  - Matching uses `ILIKE` with escaped wildcards on `document.remark` and on the current version's `file_name`, plus a prefix match on `doc_code`.
- **Facets:** `search_document_facets(p jsonb)` is SECURITY INVOKER. It takes the same inputs and returns rows of (facet, value, label, n) under RLS, for group, received_as, channel, received_by and status.
- **Faster Limited searches:** both functions add `client_id = any(<clients the user can see>)` for Limited users *in addition to* RLS. This lets the planner use indexes instead of evaluating `can_see_client` on every row. RLS remains the enforcement.
- The DOC-ID jump goes through a single `document` select by `doc_code` under RLS; no function is needed.
- `/documents` is a server page that validates the URL filters (UUIDs/enums/dates via zod) and renders a client component. The component calls the search actions with POST, so the text is never in the URL.

## Non-functional requirements
- **Security/privacy:**
  - Security-invoker functions with `search_path = ''`; no SECURITY DEFINER.
  - Parameters are bound, and the text is escaped for `ILIKE`.
  - No PII or search text in URLs or logs (AC-11).
  - `staff_user` names come from the existing `staff_select` policy.
- **Accessibility:** WCAG 2.1 AA; the combobox pattern; filter chips are buttons with names ("Remove filter Channel: Courier"); axe on the header dropdown and `/documents`; ≤ 390 px asserted.
- **Performance:** AC-12. The client-side debounce is 250 ms; an old request whose answer arrives after a newer one is ignored.

## Data model changes (needs a migration — see Proposed architecture changes 1)
- **No new tables or columns, and no changes to existing policies.**
- New SECURITY INVOKER functions: `public.search_documents(jsonb)` and `public.search_document_facets(jsonb)`. EXECUTE goes to `authenticated`, revoked from `anon`.
- **Indexes, only if AC-12 fails without them** (the last build step):
  - trigram GIN on `document.remark` and `document_version.file_name` (pg_trgm already exists);
  - `(office_id, received_on desc)` and `(office_id, created_at desc)` on `document`.

## Existing code affected
- `src/components/app-header.tsx`: the search box/combobox and the mobile search button. Unit tests cover the header today; they stay unchanged and must pass.
- New files:
  - `src/app/(app)/documents/page.tsx` + `search-view.tsx` + loading/error;
  - `src/lib/search/{queries,actions}.ts`;
  - `src/lib/validation/document-search.ts`.
- **Not touched:** `src/lib/documents/queries.ts`, the client page, and the Add document form. This avoids 04's files.
- `sdlc/product/references/ui-reference.md` gets the new screen and the mobile search button as agreed deviations.

## Backward compatibility & data migration
Additive only: two new functions, plus possibly indexes. No data changes. Dev first; staging and prod at R1.

## API / interfaces
- Route: `/documents?client=&group=&type=&fy=&period=&registration=&as=&channel=&by=&from=&to=&status=&state=classified|inbox&archived=1&sort=received|added|docid&page=` (IDs, enums and dates only).
- Server actions: `suggest(text)`, `searchDocuments({ text, filters, sort, page })`, `documentFacets({ text, filters })`, `openDocId(text)`.
- SQL: `search_documents(jsonb)` and `search_document_facets(jsonb)`.

## UX flows & screens
- **Header:** the search field sits between the nav and "+ Add document", with the `/` hint. The dropdown is a panel with two labelled groups (Clients, Documents) and "See all results".
- **`/documents`:**
  - Title "Documents", with "N documents" underneath.
  - A search field pre-filled with the text.
  - A filter row of chip buttons (Client · Group · Type · FY · Period · Received as · Channel · Received by · Dates · More: Status, Inbox/Classified, Include archived). Each opens a small popover listing values with facet counts.
  - Active filter chips, then the result rows (03 Inbox row style), then pagination: "Previous / Next", page N of M.
- On phones, filters open in a full-screen sheet.

## Test strategy
| AC | Test | Suite |
|---|---|---|
| 1–4 | combobox keyboard flow, `/` shortcut rules, suggestions (clients + documents), DOC-ID jump (visible and not visible), "See all" carries the text without a URL | e2e + unit |
| 5, 6, 9 | results rendering, each filter alone and combined, chips, clear, URL round-trip (Back/refresh), sort options, paging, empty and error states | e2e + unit (filter ↔ URL mapping) |
| 7 | facet counts match the result set; zero-count values hidden; inactive staff marked | RLS/DB + e2e |
| 8 | word-AND/field-OR matching; escaping `%`, `_`, `\`; DOC-ID prefix; long-input cut | RLS/DB + unit |
| 10 | visibility matrix across the 4 roles on results, totals, facets and suggestions | RLS/DB |
| 11 | no search text in any URL during the flows (Playwright request/URL listener); no activity rows written | e2e + RLS/DB |
| 12 | 100k-document test office: timing of suggestions, first page + facets, and a Limited search (RUN_SLOW) | RLS/DB (slow) |
| 13 | timed manual check, Staff role, 5 lookups | manual (PR; R1 staging) |
| NFR | axe on the header dropdown and `/documents`; ≤ 390 px | e2e |
- All new tests join the regression suite. **Smoke-safe for prod:** none. Every test needs sign-in.
- The volume test data is generated in its own lane-suffixed test office, reset each run, as 03's documents-perf does.

## Proposed architecture changes
1. **Lock exception: 03b's migration is read-only (approved, Raja 2026-09-29, option A).**
   - 03b needs two new SECURITY INVOKER functions. Its migration adds only these functions, and possibly indexes. It creates or alters no table, column, policy, trigger or existing function.
   - It could then be applied to dev while **04 holds the schema lock**, keeping 04's merge-first order.
   - Without the exception, 03b cannot run any DB or e2e test until 04 merges. Batch C would be mostly sequential.
2. **Search text is handed to `/documents` through session storage, never the URL.** This applies the existing no-PII-in-URLs rule to a new case.
3. **A new screen outside the mockup** (`/documents`) and a mobile search button, recorded in ui-reference.md.

## Risks & areas of concern
- **RLS cost for Limited users at 100k rows.** `can_see_client` runs per row → mitigated by the explicit visible-clients filter (see Functional requirements) and measured in AC-12.
- **`ILIKE '%…%'` without an index** on 100k rows. Probably tens of milliseconds, but unmeasured → volume test; trigram indexes only if needed.
- **A facet query per search doubles the DB work** → run it in parallel with the results; if it's too slow, compute facets only when a filter popover opens.
- **`search_clients` will be changed by 04** (overdue counts, `p_has_overdue`) → 03b only calls it, with defaults. Its existing parameters must keep working; 04's plan already keeps them. Verified at rebase.
- **Scope ≈ 1.5 weeks [Likely].** First cut if it slips: facet counts (plain filters without counts). Second cut: the mobile search sheet (a plain search link to `/documents` instead).

## Out of scope
Export and bulk download (08) · searching inside file contents (OCR) · saved searches · expected-document facets (04/06) · a "Documents" nav item · activity search (08) · spelling tolerance / fuzzy matching beyond partial matches.

## Decisions (Raja 2026-09-29)
- **Option A approved:** 03b may apply its own migration while 04 holds the schema lock. That migration may only add the two new SECURITY INVOKER search functions (and, if the volume test needs them, indexes on `document`/`document_version`). It creates or alters no table, column, policy, trigger or existing function.
- Spec approved as drafted.

## Open questions
None.
