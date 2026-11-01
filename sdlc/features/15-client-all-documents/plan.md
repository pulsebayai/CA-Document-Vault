# Plan: Client › All documents, with per-document activity (and the K4 fix)
Spec: ./spec.md (approved 2026-11-01, U1–U6) · Status: **approved (Sidambara, 2026-11-01; roadmap PR at step 0 approved)** · Date: 2026-11-01
Branch: `feat/15-client-all-documents` · Locks: **schema → 15** (free since 13's merge; taken at plan approval, roadmap PR at step 0) · architecture: none (15's items are written in its PR, as 14 did) · RUN_SLOW: not needed (no 02/03 write path)

## Files that change
**Migration (new, one file):** `…_doc_activity.sql`
- `activity_doc_ref_idx` (partial btree on `data->>'document_id'`), `activity_doc_ids_idx` (partial GIN on `data->'document_ids'`);
- `activity_feed(p jsonb)` replaced: same signature and output; the document filter becomes a UNION of three indexed lookups (entity / `document_id` / `document_ids`), every other branch byte-for-byte as 08's body;
- new `document_last_activity(p_ids uuid[]) returns jsonb` (invoker, ≤ 50 IDs, office first, latest visible event per document).
- The previous `activity_feed` body is kept in a comment for rollback.

**Lib:** `lib/activity-feed/queries.ts` (+ `lastActivityAs(ids)`, `documentEventsAs(id)`), `lib/activity-feed/last-activity.ts` (pure: the "who · sentence · when" line), `lib/search/scope.ts` (pure: scoped URL builder, default FY), `lib/activity-feed/actions.ts` (server actions for the page's Last activity and the expanded row).

**Screens:** `clients/[id]/page.tsx` (tab + count), new `clients/[id]/all-documents-view.tsx`, `documents/(search)/search-view.tsx` (optional `scope` prop; Last activity column and expand slot only when scoped; `/documents` unchanged), new `components/document-activity-row.tsx` (expand toggle + 5 events).

**Docs:** architecture.md (rule 1 of the spec's proposed changes, the client tab, decision row: in the PR), ui-reference.md (2 rows), `sdlc/releases/R1/evidence/volume-dev.md` (K4 re-measured; addendum, not a rewrite).

## Migrations
One (A). Applied on dev at step 3; md5 of `activity_feed` and `document_last_activity` = file; Regression `only` = 15's RLS files before merge (migration rule).

## New tests (failing first)
- unit: `scope-url.test.ts`, `last-activity-line.test.ts`, `document-refs.test.ts` (lists every action whose activity `data` carries `document_id` / `document_ids`, from `src/` and the migrations; fails on a new one — spec risk 2), `all-documents-view.test.tsx` (expand toggle, aria, See all link, empty states).
- RLS: `activity-doc-filter.test.ts` (**equality**: today's `activity_feed` results, captured as the test's expectations at step 2 (no copy of the old function in the database, see Risks), must equal the new function's, for entity rows, a dispatch packet, an item removed, a requested item filed; Admin / Staff / Limited; the paging cursor), `document-last-activity.test.ts`, `k4-volume.test.ts` (U6).
- e2e: `all-documents.spec.ts`.

**Existing tests that change:** none.

## Steps
- [x] 0. **Setup:** commit this plan; roadmap PR on main (15 in progress, schema lock → 15, nightly status noted). — proof: roadmap PR merged
- [x] 1. **Failing tests first** + **measure the seed** (200k rows on dev into the K4 office, timed; and on a local stack in CI at step 9). Record the seed time and decide nothing new (U6 stands unless the seed takes > 2 min). — proof: tests fail for the expected reason; seed time in the session log
- [x] 2. **Equality harness:** capture 08's current `activity_feed` results for the reference set as a fixture inside the test (no temp function in a shared DB). — proof: harness green against today's function
- [ ] 3. **Migration A** (indexes, `activity_feed` UNION, `document_last_activity`). — proof: equality + last-activity + K4 RLS green on dev (Staff and Limited < 1 s); md5 = file
- [ ] 4. **Lib layer** (scope URL, last-activity line, queries, actions). — proof: unit green
- [ ] 5. **SearchView scope + All documents tab** (FY default, client locked, URL on the client page, bulk bar). — proof: unit + e2e part; `/documents` e2e unchanged
- [ ] 6. **Last activity column + expanded row.** — proof: unit + e2e part; axe; 390 px
- [ ] 7. **Docs** (ui-reference, architecture items drafted in plan, K4 addendum in 09's evidence file). — proof: review
- [ ] 8. **Pre-PR review** (`sdlc-reviewer`; the `activity_feed` rewrite gets a second, focused look at RLS: the UNION must not let a Limited user see a row `activity_select` hides). Fix findings failing-first. — proof: no open Important finding
- [ ] 9. **Full verification:** lint, typecheck, unit, full RLS on dev, `all-documents.spec` + `activity` e2e locally; push → PR CI; Regression `only` = 15's RLS files (asked first) → PR with the AC table. — proof: CI green + AC table

## Risks
- **The rewrite changes what someone sees.** `activity_feed` is the one read behind `/activity`, the document card and (now) the expanded row. Mitigation: only the document branch changes; the rest of the body is copied verbatim and diffed in review; the equality test compares results against a fixture captured from today's function (step 2) for every role; RLS (`activity_select`) still filters every row the UNION returns.
- **Equality fixture vs a shared database:** creating a temp copy of the old function on dev would be an object other sessions could call. Instead step 2 captures today's output into the test's expectations (deterministic test office, fixed events), so no extra database object exists.
- **Dev growth from the K4 seed:** +200k activity rows once, in a persistent test office (`e2e office k4`, never reset; top up only). Its rows also make dev's activity table ≈ 680k, which every activity read already filters by office first (index `activity_office_created_idx`).
- **SearchView is shared:** the scope prop must leave `/documents` identical. Mitigation: all existing search unit tests and `search.spec` / `bulk.spec` e2e unedited and green; the new columns render only when scoped.
- **The nightly is red** (4 nights at the RLS step, cause unread from the session: logs blocked). It must be read before 15 merges, or 15's Regression proof can't be told apart from it. Owner to paste the failing test names, or reconnect Chrome.

## Estimate
[Uncertain] 3–4 working days (intent estimate holds: the K4 part is smaller than assumed, the equality harness adds about half a day).

## Deviations from plan
- **D-1 (step 2): the equality test computes its expected rows instead of capturing a fixture.** For each role it reads the raw rows that reference the document (entity, `data.document_id`, `data.document_ids`) as the service role, keeps those the role can read through the table's own RLS, and orders them by (created_at, id) desc; `activity_feed` must return exactly that, in one page and paged by 2. Simpler than a fixture, and it doesn't go stale. Green 9/9 against 08's function.
- **D-2 (step 1): the K4 office is seeded in 5k-row calls**, not 20k: `seed_test_activity` re-reads the whole office each call, and at ≈ 165k rows calls of 20k and 10k hit dev's 8 s statement limit. Top-up from 165k to 200k: 7 calls, 38.5 s. A fresh seed on CI's local stack is ≈ 40 calls (measured at step 9).
- **D-3 (step 1): the K4 office has ≈ 5,000 varied source rows** before seeding, so the 200k copies spread at ≈ 40 per entity instead of piling onto the few real documents (realistic histories for the measured documents).
- **D-4 (step 1): `all-documents-view.test.tsx` is written at step 5**, failing first, just before the component, once its props are settled.

## Session log
### 2026-11-01
- Intent approved (Q1–Q4). Spec approved (U1–U6). K4 re-measured on dev before the spec: Staff 525–540 ms, **Limited 19.8 s** (the volume office's 201,624 rows); 09's 14.1 s predates the chore index of 25 Oct.
- Nightly Regression red 30 Oct – 1 Nov at the RLS step; failing tests not readable from the session (GitHub logs/artifacts on a blocked host; Chrome not connected). Flagged as a merge blocker for 15.
- **Build started (Sidambara approved the plan, 09:37).** Step 0: roadmap PR #20 merged (schema lock → 15), main merged into the branch. Step 1: `tests/support/k4.ts` (persistent `e2e office k4`, lane-independent, fixed `e2e-k4-*` users), RLS `activity-doc-filter` (D-1), `document-last-activity`, `k4-volume`; unit `scope-url`, `last-activity-line`, `document-refs`. Results: the equality harness **9/9 green against today's function** (step 2); `document_last_activity` and the unit files fail for the expected reason (missing); `k4-volume`: Staff card < 1 s already, **Limited card times out (statement timeout)** — K4 reproduced in the K4 office (200,000 rows; seeded 2026-11-01).
