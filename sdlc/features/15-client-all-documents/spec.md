# Spec: Client › All documents, with per-document activity (and the K4 fix)
Intent: ./intent.md (approved 2026-11-01, Q1–Q4) · Status: draft · Date: 2026-11-01
Screens: no mockup screen (new tab). Client page tabs (mockups 10–11), `/documents` table (03b, agreed deviation in `ui-reference.md`), Activity rows (mockup 04); `ui-reference.md` tokens.

## Measured before this spec (dev, 2026-11-01, `explain analyze`, the 09 volume office: 201,624 activity rows)
| Call | Staff/Admin | Limited |
|---|---|---|
| Document Activity card (`activity_feed` with `document_id`, 20 rows), busy document | 540 ms | — |
| Same, a document with no events (the worst case: the whole office is read) | 525 ms | **19,773 ms** |

- 09's 14.1 s (Staff, 7 Oct) dropped to ≈ 0.5 s after the chore index `activity_entity_idx (entity_id, id)` (PR #11, 25 Oct). **K4 was never re-measured, so the roadmap still lists it as blocking.**
- It is still a scan: `activity_feed` ORs the entity match with two `data` matches (`data->'document_ids' ? id` for `dispatch.created`, `data->>'document_id' = id` for `dispatch.item_removed` and `upload_request_item.filed`), so no index serves the filter and the cost grows with the office's activity, not the document's. For **Limited**, 08's `activity_select` runs its per-row helper on every row first: 19.8 s, over the 8 s statement limit (an error on screen).

## Decisions taken into this spec (confirm at this gate)
| # | Question | Answer in this spec |
|---|---|---|
| U1 | K4 approach | **Index each branch, not a new column.** Two small partial indexes on the `data` references (`(data->>'document_id') where data ? 'document_id'` and a GIN on `data->'document_ids' where data ? 'document_ids'`; ≈ 3k of 480k rows on dev) beside the existing `activity_entity_idx`. `activity_feed`'s document filter becomes a UNION of the three indexed lookups, so only the document's own rows reach `activity_select`. Same signature and output, so 08's callers and tests are unchanged. *Rejected:* a resolved `document_id` column set by a trigger: a write-path change on every activity insert, a backfill of 480k rows, and `dispatch.created` names several documents, so one column can't hold it. |
| U2 | Last activity for a page of 20 | One new invoker call per page, `document_last_activity(p_ids uuid[])` (≤ 50 IDs): the latest event **the viewer may see** per document, via the same three indexed lookups (`LATERAL … LIMIT 1`). Returns IDs, action, actor name, time and `data`; the sentence is built in TS from 08's catalogue. |
| U3 | Expanded row | Fetched on expand (not with the page): `activity_feed` with `document_id`, `limit: 5`, through a server action. "See all" → `/activity?document=<id>` (Q3). |
| U4 | The table | 03b's `SearchView` with a **client scope**: client filter fixed and hidden, URL on the client page (`/clients/<id>?tab=all&fy=…&page=…`), search text in the tab's `sessionStorage` (03b). Same filters, facets, row actions and 08/13 bulk actions as `/documents` (U5). `search_documents` is **unchanged** (it already filters by client and FY). |
| U5 | Bulk actions | All of `/documents`' (zip, Mark reviewed, Mark in office, Ready to dispatch): they're per document and RLS-checked, and staff asked for one place per client. |
| U6 | K4 proof (Q4) | A db test seeds **200k activity rows once** in its own persistent test office (09's `seed_test_activity`, 20k per call; top up only below 200k, never reset), then times the card, the expanded row and Last activity **as Staff and as Limited**. On CI's throwaway local stack it seeds fresh (≈ 10 × 3 s). Runs on every PR. |

## User stories & acceptance criteria

### A. The tab
- **AC-1** The client page gets an **All documents** tab after Documents (Documents · All documents · Expected · Requested · DSC · Settings), `?tab=all`, with the client's document count. Every role that can see the client sees it. Documents stays the default tab (Q1).
- **AC-2** It shows the `/documents` table for this client only: **current FY by default** (office date), an FY select ("All years" included), **20 per page, newest received first** (Q2). The client filter is not shown and can't be changed; every other `/documents` filter, facet and chip works, and the URL keeps them (IDs, enums, dates; never search text).
- **AC-3** Row content and actions are `/documents`' (DOC-ID, type, period, received, state badges, View / Download, Edit, review and custody buttons), and selection + bulk actions work on the selected rows (U5). An Untagged document of this client (no type) shows too, as on `/documents` with a client filter.
- **AC-4** Empty states: "No documents for <FY> yet" with a link to All years; a filtered empty state with "Clear filters". Loading and error states as every screen (02 rule).

### B. Last activity
- **AC-5** A **Last activity** column: the latest event the viewer may see for that document, as "<who> · <sentence> · <when>" (08's catalogue; "Vault" for system rows; relative within 7 days, then a date). A document with no visible event shows "—".
- **AC-6** Loaded for the whole page in **one call** (U2); a failure leaves the column at "—" with no error banner (the table still works).

### C. Expanded row
- **AC-7** Each row has a "Show activity" toggle (a button with `aria-expanded`, keyboard reachable). Expanding loads the document's **5 latest** visible events (08's sentences, actor, time) and a **See all** link to `/activity?document=<id>`. Collapsing and re-expanding re-uses the loaded events. A loading line and an inline error with Retry.

### D. K4
- **AC-8** `activity_feed` with a `document_id` returns exactly what it returns today (same rows, order and fields) for every role, but reads only that document's rows: the document page's Activity card, the expanded row and `/activity?document=` are each **< 1 s at 200k activity rows, for Staff and for Limited** (U6). 08's tests stay unedited.
- **AC-9** `document_last_activity` for 20 documents **< 1 s** at the same volume, Staff and Limited, and never returns an event the viewer can't see in `activity_feed` (same `activity_select`).
- **AC-10** The All documents first page incl. Last activity: **< 1 s** for a client with 500 documents (round trip, median of 5 warm calls, like 02's `clients-list`).

### E. Unchanged
- **AC-11** The grouped Documents tab, `/documents`, `/activity`, the document page, Today and every existing test (no existing test edited; additive rows only if a matrix or catalogue test needs them: none expected).

## Functional requirements
- Migration A (schema lock): the two partial indexes; `activity_feed` replaced (same signature), document branch as a UNION of three lookups; new `document_last_activity(p_ids uuid[]) returns jsonb` (invoker, ≤ 50 IDs, office first).
- `SearchView` gains an optional `scope: { clientId; basePath }`; without it, `/documents` behaves exactly as today.
- Server actions: `lastActivityFor(ids)`, `documentEvents(id)` (limit 5), errors logged as code + request ID.

## Non-functional requirements
- **Performance:** AC-8 – AC-10.
- **Security / privacy:** every read is SECURITY INVOKER under the viewer's RLS (`activity_select`, `document_select`); no new definer function; activity stays IDs and field names; nothing new in URLs but the FY, filters and page (already allowed).
- **Accessibility:** WCAG 2.1 AA; the expand toggle and its region labelled by the DOC-ID; axe on the tab, an expanded row and 390 px (the table scrolls inside its wrapper).

## Data model changes (schema lock)
- `create index activity_doc_ref_idx on activity ((data->>'document_id')) where data ? 'document_id'`
- `create index activity_doc_ids_idx on activity using gin ((data->'document_ids')) where data ? 'document_ids'`
- No table or column change; no data step.

## Existing code affected
- `clients/[id]/page.tsx` (tab), new `clients/[id]/all-documents-view.tsx` (wraps `SearchView` with the scope + the two columns), `documents/(search)/search-view.tsx` (optional scope; Last activity column and expand slot behind the scope or a flag), `lib/search/*` (scoped URL builder), `lib/activity-feed/queries.ts` (+ last activity, events).
- Migration: `activity_feed` replaced. Its callers (Activity page, document card, filtered feed) are unchanged.

## Backward compatibility & migration
- The indexes are plain `create index` in the migration (`concurrently` can't run inside a migration's transaction). They are partial (≈ 3k rows on dev), so the build takes [Likely] well under a second; measured at plan step 1. Replay on staging/prod from the file.
- Rollback: drop the two indexes and restore 08's `activity_feed` body (kept in the migration comment).

## Test strategy
| AC | Unit | RLS (db) | e2e |
|---|---|---|---|
| 1–4 | scope URL builder; empty-state text | — | `all-documents.spec.ts` (tab, FY default + switch, filter, page 2, bulk zip on 2 rows, axe, 390 px) |
| 5–7 | Last-activity line (sentence, "Vault", relative/absolute time) | `document-last-activity.test.ts` (latest per doc, Limited sees only visible events, dispatch / requested refs) | expand → 5 events → See all link |
| 8–10 | — | `activity-doc-filter.test.ts`: **equality** of old vs new `activity_feed` results for a set of documents (entity rows, dispatch packet, item removed, requested item), all roles; `k4-volume.test.ts` (U6 seed, Staff + Limited timings) | — |
| 11 | full unit suite | full RLS suite | full e2e suite |

**Existing tests that change:** none. **RUN_SLOW:** not needed (no 02/03 write path); the K4 seed runs in normal runs (U6).

## Proposed architecture changes
1. **Activity lookups by document are indexed per reference kind** (entity, `data->>'document_id'`, `data->'document_ids'`), and every "activity of a document" query is a UNION of those lookups, never an OR — the rule for any future per-entity activity read (K4).
2. Client page tab **All documents** = 03b's table with a client scope (one table component, two places).
3. Roadmap/09: K4 re-measured and fixed (Staff 0.5 s → target < 100 ms; Limited 19.8 s → < 1 s); rollout still waits for K3.

## Risks & areas of concern
- **Equality of the rewritten `activity_feed`.** The UNION must return the same rows as the OR, in the same order, with the same paging cursor. Mitigation: the equality test compares old (kept as a test-only copy in the test's transaction) vs new over every document reference kind and role.
- **New `data` references later.** A future action that stores a document ID under another key wouldn't show in a document's history. Mitigation: the architecture rule above, plus a unit test that lists the actions whose `data` carries `document_id(s)` (found from `src/` and the migrations, like 08's catalogue test) and fails on a new one.
- **Seeding on shared dev:** 200k rows once in one persistent test office (≈ +40% on dev's activity table); never re-seeded. Recorded in plan.md.
- **Today (K3) is untouched**; the client page gets one more count query (the tab count, cheap).

## Out of scope
Saved views, column chooser, export · sorting by last activity · activity for non-document entities on this tab · K3, K5 beyond what U1 gives for free.
