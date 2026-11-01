# Intent: Client › All documents, with per-document activity (and the K4 fix)
Author: Sidambara (drafted with Claude) · Status: **approved** (Sidambara, 2026-11-01) · Date: 2026-11-01
Roadmap item: 15-client-all-documents · Release: **R1** (Kushal Associates, Q7) · Moves product metric: 5 (adoption) and principle 1 (staff-first speed); unblocks rollout to all clients (**K4**)
Source: Kushal review 2026-10-29 → `sdlc/feedback/2026-10-29-kushal-review-plan.md` **A11b** (+ Q6, A13), 09's known issue **K4** (`sdlc/releases/R1/evidence/volume-dev.md`).

## Problem
- **Staff can't see one client's documents as a list.** Client › Documents shows grouped cards (group → type → period, with expected items). That is right for "what is missing", but slow for "what came in for this client and what happened to it". The `/documents` table can filter by client, but nothing links to it from the client page, and it doesn't show what happened to each document.
- **What happened to a document is one page away.** Each document's history (review, custody, dispatch, edits) is only on its document page, so a staff member answering a client's call ("did you get my bank statement, and has it gone back?") opens documents one by one.
- **The history itself won't survive real volume (K4).** The document page's Activity card times out at 200k activity rows (14.1 s, 09 V9d): `activity_feed`'s document filter can't use an index. K4 blocks rollout to all clients, and a per-row activity column would multiply it.

**Cost:** slower answers to client calls; staff fall back to memory or WhatsApp threads; the document page's history breaks within months at full volume.

## Proposed outcome
1. A client tab **All documents** (after Documents; the grouped **Documents** tab keeps its name and stays the default): the `/documents` table for this one client, **current FY by default** with an FY switch, **20 per page, newest received first** (Q6). The same filters, row actions, selection and bulk actions as `/documents` where they make sense for one client.
2. A **Last activity** column: who · what · when (the sentence from 08's catalogue, e.g. "Priya · marked ready to dispatch · 2 Nov").
3. An **expandable row** with the document's **5 latest events** and **See all** → `/activity?document=<id>` (08's full feed).
4. **K4 fixed:** the document page's Activity card, the expanded row and the Last activity column each return in **< 1 s at 200k activity rows**, proven by a test that seeds that volume in its own test office.

## Users & systems affected
- **Every role** that can see the client (Limited only for their clients; activity rows follow 08's `activity_select`).
- **Systems (detailed in the spec):** the client page tabs, 03b's `search_documents` (reused for one client), 08's `activity_feed` / activity lookups (the K4 change: index and/or query rewrite), the document page's Activity card (same fix). Schema change = an index or a resolved column on `activity` → needs the **schema lock** (free).

## Success metrics
1. **K4:** document Activity card < 1 s at 200k activity rows (was 14.1 s); the All documents first page incl. Last activity < 1 s at a client with 500 documents.
2. **Answer time:** "did we get X and where is it?" answered from the client page without opening a document: timed on staging by a Staff user, ≤ 20 s (R1 checklist).
3. **Use:** in the pilot, All documents opened on ≥ 30% of client page visits (not tracked automatically: no analytics; ask the pilot staff after 2 weeks).

## Constraints
- **K4 first** (plan order): the per-row activity must not ship on an unindexed path.
- Activity stays **IDs and field names only**; sentences are built in TS (08's catalogue); Limited visibility unchanged (08).
- No PII in URLs: the FY and page may be in the URL, search text never (03b).
- Search functions are 03b's (replaced by 11 and 13 since): reuse them; any change to them needs the schema lock and must not worsen **K5** (Limited search).
- [Uncertain] ≈ 3–4 working days (review estimate), incl. the volume test.

## Behaviour that must not change
- The grouped Documents tab (default tab, expected items, Remind, paging by 20 from 12).
- `/documents` (filters, facets, bulk actions, 20 per page) and `/activity` (filters, paging, Limited visibility).
- The document page's Activity card content (only its speed changes).
- Every existing test unedited (except additive rows if any).

## Out of scope
- Saved views, column chooser, Excel export (A11: not requested).
- K3 (Clients list / Today / suggestions at volume) and K5: separate work.
- Activity for things that aren't documents on this tab (expected items, reminders, DSCs).
- Sorting by last activity (the table sorts as `/documents` does).

## Decisions (Sidambara, 2026-11-01)
- **Q1 — tab names:** "Documents" (grouped, default) + "All documents".
- **Q2 — default view:** current FY, newest received first, FY switch, 20 per page.
- **Q3 — See all:** `/activity?document=<id>` (no new screen).
- **Q4 — K4 proof:** a test seeds ≈ 200k activity rows in its own test office (09's `seed_test_activity`) and asserts < 1 s. Whether it runs on every PR or only with RUN_SLOW depends on how long the seed takes on CI's local stack (measured at plan step 1; the spec records the answer).

## Open questions (for the spec)
- K4 approach: indexes on `activity` (entity + `data->>'document_id'` + a GIN on `document_ids`) with the filter rewritten as a UNION, or a resolved `document_id` column set by a trigger. The spec compares them with numbers.
- Last activity for 20 rows: one call for the page (a set-based "latest event per document"), not 20.
- Which bulk actions show on one client's table (all of 08's and 13's, or a subset).
- **Seeding without bloating dev:** `reset_test_office` never deletes activity rows, so the K4 test must seed its office **once** and reuse it (top up only below 200k), like 09's persistent volume office; otherwise every run adds 200k rows to dev for good. On CI's local stack the database is thrown away, so a fresh seed is fine there (≈ 10 calls × ≈ 3 s).
