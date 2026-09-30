# Plan: Document search
Spec: ./spec.md · Status: approved (Raja 2026-09-29 23:01) · Date: 2026-09-29
Holds: **no schema lock.** 03b applies its own additive migration under the read-only exception (spec decision, Raja 2026-09-29, option A). There is **no architecture lock**; the spec's agreed deviations go to ui-reference.md, which is feature-owned.
Base: `feat/03b-document-search` from main `f0be2c1` (after #13/#14). **Merge order: 04 first, then 03b rebases and re-runs the full suite.**

## Design choices made while planning
- **03b avoids every file 04 changes.** `search_clients` is called directly from the new `src/lib/search/` through `supabase.rpc`, not through `src/lib/clients/queries.ts`, which 04 changes for "Has overdue". 03b also doesn't touch the client page, the Add document form or `src/lib/documents/queries.ts`.
- **One migration, applied early to dev:** the two SECURITY INVOKER search functions. Indexes, if needed, go in a second small migration at step 7. Neither references anything 04 creates, so they replay cleanly on staging in version order whichever is applied first.
- **The 100k volume test can't be seeded through the API.** 03's documents-perf seeds 700 documents in about 1 minute, so 100k would take more than 2 hours. The plan adds **a test-only seeding function**, `seed_test_documents(p_count, p_template)`:
  - SECURITY INVOKER, refused outside `is_test` offices (as with `app.doc_clock`);
  - it loops over the existing `create_document`, so every trigger, DOC-ID and RLS rule applies;
  - it's called in chunks of 2,000 to stay under the 8 s statement timeout;
  - the perf office (`e2e office search-perf #<lane>`) is **not reset each run**: it is re-seeded only when its count is wrong, so nightly runs don't pay the seeding cost.

  **This goes one step past "read-only"**: the function writes, though only through `create_document` and only in test offices. **Needs your OK (see the gate).**
- **Faster Limited searches:** add `client_id = any(visible clients)` on top of RLS. The visible-client list comes from the same rule as `can_see_client`, computed once per query in a CTE.

## Files that change
| Path | New/Mod | Why |
|---|---|---|
| supabase/migrations/<ts>_document_search.sql | new | `search_documents(jsonb)`, `search_document_facets(jsonb)` (invoker; EXECUTE to authenticated); `seed_test_documents(int, jsonb)` (invoker; `is_test` offices only; pending your OK) |
| supabase/migrations/<ts>_document_search_indexes.sql | new, **only if AC-12 fails** | trigram GIN on `document.remark` and `document_version.file_name`; `(office_id, received_on desc)`, `(office_id, created_at desc)` |
| src/lib/validation/document-search.ts | new | zod for URL filters (UUIDs/enums/dates), text rules (≤ 5 words × 50 chars), filter ↔ URL mapping, DOC-ID pattern |
| src/lib/search/{queries,actions}.ts | new | `suggest`, `searchDocuments`, `documentFacets`, `openDocId` (server actions, POST); `search_clients` via rpc |
| src/components/app-header.tsx | mod | search box between nav and "+ Add document"; mobile search button |
| src/components/header-search.tsx | new | the combobox (client component): debounce, stale-response guard, `/` shortcut, session-storage hand-off |
| src/app/(app)/documents/page.tsx, search-view.tsx, loading.tsx, error.tsx | new | results page (filters, chips, facet popovers, rows, sort, paging, states) |
| sdlc/product/references/ui-reference.md | mod | agreed deviations: `/documents` screen, mobile search button |
| tests/rls/document-search.test.ts | new | matching, escaping, filters, facets, archived toggle, visibility matrix, no activity (written first) |
| tests/rls/document-search-perf.test.ts | new | RUN_SLOW: 100k documents, timings for suggestions, first page + facets, Limited |
| tests/unit/document-search.test.ts, header-search.test.tsx | new | validation/URL mapping; combobox keyboard, `/` rules, stale responses |
| tests/e2e/search.spec.ts | new | header → dropdown → DOC-ID jump / See all → filters → URL round trip; no text in any URL; axe; ≤ 390 px |
| tests/support/search.ts | new | perf-office seeding (chunked), fixtures |

**Overlap with 04: none in code.** 04's files are the client page, Add document, the Clients list, Settings, `src/lib/expected/`, and its migration. 03b's shared dependency is `search_clients`, which it calls with its existing parameters; 04 extends it (adds `p_has_overdue`) while keeping the old signature working. This is checked at the 03b rebase.

## Migrations (read-only exception, Raja 2026-09-29)
1. `<ts>_document_search.sql`: the two search functions plus `seed_test_documents` (pending your OK). Dry-run on dev inside a rolled-back block as admin/staff/limited, then apply and run the advisors.
2. `<ts>_document_search_indexes.sql`: **only if** the step-7 volume test misses its targets without them.

Staging and prod get both at R1, in version order after or around 04's (both are additive, with no dependency either way).

## Steps (estimates = build sessions with Claude; your time in brackets)
- [x] 0. Draft PR, CI green on the branch (docs only). Rebase later when 04 merges. (—)
- [x] 1. **RLS/DB tests first (red)**, proof: `test:db` fails for the right reasons (1). Cases:
  - text AND/OR rules; escaping of `%`, `_`, `\`; DOC-ID prefix;
  - each filter; sort; paging + total;
  - archived toggle;
  - facet counts equal the result set, zero-count values hidden, inactive staff marked;
  - visibility matrix (4 roles × assigned/unassigned × classified/Inbox × own/others') on results, totals, facets and suggestions;
  - search writes no activity.
- [x] 2. **Migration** written, dry-run, applied to dev, advisors clean. Proof: step-1 tests green in CI. (1) [review SQL: 30 min]
- [x] 3. Validation + filter ↔ URL mapping. Proof: unit tests red → green. (0.5)
- [x] 4. Server actions (`suggest`, `searchDocuments`, `documentFacets`, `openDocId`), stale-response guard, error logging (code + request ID only). Proof: unit + RLS through the RPCs. (0.5)
- [x] 5. **Header search**: combobox, `/`, dropdown groups, DOC-ID jump, See all → session storage, mobile button. Proof: e2e + unit (keyboard, `/` rules). (1.5)
- [ ] 6. **`/documents`**: filter chips + popovers with counts, result rows, sort, paging, Include archived, empty/loading/error states, text restored from session storage. Proof: e2e (URL round trip, Back/refresh; **a URL listener proves no search text in any URL**). (2)
- [ ] ~~7. Volume~~ → **deferred** (Raja 2026-09-29): a 10k-document volume test, with the test-only seeding function, runs **after all R1 features are built** (roadmap "Before pilot"). Indexes wait until then.
- [ ] 8. a11y (axe on the header dropdown and `/documents`), ≤ 390 px, screenshots, ui-reference.md deviations. Proof: e2e evidence. (0.5)
- [ ] 9. AC-13: timed find check, Staff role, 5 lookups, recorded in the PR. [you or a staff member: 10 min]
- [ ] 10. After 04 merges: rebase and run the full suite. Then `verifier` → `sdlc-reviewer` → fix Important findings → PR with the AC → test → result table. Proof: CI green, evidence for all suites. [PR review: 1 h]

**Total ≈ 7.5 build sessions** (volume step deferred). Your review ≈ 2–3 h. **First cut if it slips:** facet counts (plain filters without counts). Second cut: the mobile search sheet.

## Risks
| Risk | Mitigation |
|---|---|
| Search leaks a document or count across roles | invoker functions only (RLS always on); the visibility matrix covers results, totals, facets and suggestions |
| Search text in a URL or log | text only in POST bodies and session storage; e2e URL listener; server logs code + request ID only |
| Limited users' searches slow at volume (`can_see_client` per row) | extra visible-clients predicate in a CTE; timed in step 7 |
| `ILIKE '%…%'` slow at 100k | measured; trigram indexes only if needed |
| Seeding 100k takes too long or hits timeouts | chunked `seed_test_documents` calls; persistent perf office per lane; re-seeded only when the count is wrong |
| 04 changes `search_clients` | 03b calls only its existing parameters; checked after the rebase |
| The two migrations reach staging out of order | both are additive with no dependency; replayed in version order |
| Two lanes' perf offices double dev storage (2 × 100k rows, no files) | ~100 MB of rows [Uncertain]; watch database size; drop to one perf lane if needed |

**Rollback:** revert the PR, plus a compensating migration that drops the functions and indexes. No data changes.

## Proof of done
- AC-1…13 → test → result table in the PR.
- CI green, plus a RUN_SLOW run with the timings.
- No search text in URLs (e2e).
- Screenshots; ui-reference.md updated.
- All 02/03/04 tests unchanged and green after the rebase.

## Deviations from plan
- **Step 4 test file (2026-09-30):** the server-action unit tests live in a new `tests/unit/search-actions.test.ts`, which isn't in "Files that change". It's test-only and doesn't overlap with 04.
- **Volume test deferred and reduced (Raja 2026-09-29 23:01).** Spec AC-12 is measured at **10k documents**, once all R1 features are built, not in 03b. The test-only `seed_test_documents` function is approved and ships with that volume test, not in 03b's migration. Consequences:
  - 03b's migration holds only the two search functions;
  - the indexes migration is deferred;
  - `tests/rls/document-search-perf.test.ts` and `tests/support/search.ts` move to the volume-test item.

  Risk accepted: a slow search at volume shows up later. It is fixable with additive indexes, which need no change to 03b's code.

## Session log
### 2026-09-29
- Done: intent approved (3b7e1a2), spec approved (2218b4a, option A read-only migration exception), plan drafted.
- In progress: — (plan approved; Batch C launch approved 2026-09-29 23:01).
- Blocked / failing: —
- Next step: roadmap PR (Batch C in progress, locks) → build step 0 in parallel with 04.
- Decisions made (cross-cutting → flag for architecture.md at merge):
  - read-only migration exception for search functions;
  - search text handed over via session storage;
  - test-only seeding function (pending approval).

### 2026-09-30
- Done:
  - Step 0: merged main (769892b) into the branch (no force-push); draft PR #19; CI 36717094910 green (docs-only, tests skipped).
  - Step 1: `tests/rls/document-search.test.ts` (48 tests: text rules, escaping, DOC-ID prefix, 5-word/50-char cut, current file name only, each filter, sort, paging, archived toggle, facets incl. own-filter exclusion and "(inactive)", visibility matrix incl. group- and type-level assignment, anon, no activity). Local run: 47 fail with "function not found" (right reason); the anon test passes vacuously until step 2.
  - Before any test had passed, I fixed two defects in my own step-1 test: a token collision ("zqmv" contained "zqm"), and assignments not being restored after a failure (now try/finally).
  - Step 2 in progress: migration `<ts>_document_search.sql` drafted. A rolled-back dry-run on dev (staff and Limited impersonated) found a NULL bug: a document with no file or remark matched every text. It's fixed with coalesce and re-verified.
  - Step 2: SQL gate approved (Raja 18:39 IST): all 4 decisions — the migration as drafted, logic duplicated in both functions (no helper, per the exception), single-value filters, plan quality left to the volume test. Applied to dev as `20260930131025_document_search` (the file was renamed to match; applied statements md5-verified). Security advisors: nothing new. Local 48/48; **CI 36719993363 green** (about 18 min; `test:db` about 7 min).
  - Step 3: `src/lib/validation/document-search.ts`, with unit tests 19/19 (red first).
  - Step 4: `src/lib/search/{queries,actions}.ts`, with unit tests 10/10. The unit tests were written after the code; the logging test was mutation-checked (it fails when the text is logged).
  - Steps 3–4 **CI 36722198604 green**.
  - Step 5: `src/components/header-search.tsx` (an ARIA 1.2 combobox: `/` shortcut, 250 ms debounce with a stale-answer guard, Clients/Documents groups, DOC-ID jump, "See all" hand-off through session storage, and a Search button + full-width field below 640 px), wired into `app-header.tsx`. Unit 16/16; `tests/e2e/search.spec.ts` 5/5 locally.
    - Two component bugs caught by the new tests:
      - a late suggestion answer wiped the "No document … you can open" message;
      - the sr-only `role="status"` added a second status region to every page. The existing client-edit e2e uses `getByRole('status')`; it now uses `aria-live` without the role.
    - Local full e2e: 42 passed. The other failures were 30 s timeouts (catalogue, client-plan, both screenshot specs). client-plan fails the same way on a baseline build without step 5, so it's this session's latency to dev, not the change; CI passed those specs in 36722198604.
- In progress: CI for step 5.
- Blocked / failing: —
- Next step: step 6, the `/documents` results page. It reads `SEARCH_TEXT_KEY` from session storage and listens for `cdv:documents-search-text`.
- Decisions made (cross-cutting → flag for architecture.md): none new.

