# Sankar — R1 testing feedback (2026-11-12) and what was done

Source: three WhatsApp screenshots from Sankar (Pulsebay), 2026-11-12 06:45–06:53 IST.

| # | Feedback | Cause | Fix |
|---|---|---|---|
| 1 | Add DSC: "Show password" button is misaligned (wraps into two lines, sits off the field); use an eye icon instead of text. | `dsc-view.tsx` put a small text button beside the input in a flex row. | Eye icon button inside the field (slashed eye when shown). Accessible name stays "Show password" with `aria-pressed`, so screen readers and the existing e2e selectors are unchanged. |
| 2 | Today's "In office" card is empty (fine: nothing to act on), but the client page should list all hard copies the firm holds. | Today only lists copies that need an action; a filed copy had no view. | New client tab **In office** (`?tab=office`, spec 13 AC-21/22): every physical hard copy with a custody step and not in a live packet (includes copies showing Needs correction / To review), any FY, uncapped query, longest held first; same rows and actions as the Documents tab. No migration. No count on the tab label. |
| 3 | All documents tab defaults to the current FY, so documents with no financial year are hidden (tab said 2, list showed 1). | 15 AC-2 chose "current FY by default"; `search_documents` `fy` matches `period.financial_year` only. | **All years by default** (Sankar's first suggestion). An FY is now a filter the user picks. Spec 15 AC-2 updated; tests updated (scope-url, all-documents-view, e2e all-documents). |

Open point: picking a specific FY still hides documents with no FY. Acceptable (it is what a filter means); a later option is an "No financial year" entry in the FY select.

## Review
Opus reviewed both spec changes on 2026-11-12: approve with changes. Applied: filter by custody (not shown state), `listHeldDocuments` (no explicit limit; `max_rows` 1000 applies), 13 AC-21/22, 15 AC-1/AC-2/AC-4 + intent Q2 + architecture + ui-reference wording. Still to do: e2e `in-office.spec.ts` (run locally first), a 13 plan addendum step, move to a chore branch, re-run the release gate for the next R1 release.

## Round 2 (2026-11-12, after PR #42) — decisions and what was done
Branch `chore/r1-sankar-feedback-2`. Decisions relayed by the owner the same day:

| # | Decision | Change |
|---|---|---|
| 2 | In office = **"everything we physically hold should be listed"** (Sankar). PR #42 listed only copies with a custody step, so copies waiting to be placed, not yet reviewed, or untagged were missing. | 13 AC-21/22 widened: every non-archived hard copy of the client not in a live packet, any FY, any step (untagged, To review, Needs correction, To place in office, In office, Ready). `listHeldDocuments` reads `received_as = hard_copy` (no custody filter); untagged rows (no type) are mapped as "Untagged document" with 03's Untagged state; `DocumentRow` treats them as not filed, so they offer Edit only. Order = held since (in office time, else received on), then DOC-ID. Heading adds "· M not yet placed in office". The Mark in office button on a To place row works from this tab too. |
| 3 | **Add "No financial year"** to the FY select. | Last option of the FY select on Client › All documents **and** `/documents` (one shared view), URL `fy=none`, Period select hidden, empty state "No documents without a financial year." Search gets a new filter key `no_fy` (boolean: `period_id is null`), so a migration replaces `search_documents` / `search_document_facets` (same signatures; one declare line + one where line each; bodies otherwise = 13's `custody_b`). The app sends `no_fy`, never `fy_id: "none"`, so an older function would ignore it rather than fail. |

**Locks:** this chore takes the **schema** lock (one migration, read functions only) and the **architecture** lock (two wording changes in the client-tabs line); both were free; released at merge (roadmap updated on main then).

**Migration `20261112100000_search_no_fy`:** dev's live bodies were checked = `custody_b` (md5 `df94…e3` / `dcd7…13`) before; applied to dev 2026-11-12 (same two-line change to the live definitions); after: `search_documents` md5 `5c40828ee282956b0137ad3e5d225350`, `search_document_facets` `49aa19ed9aca507f0daea7a1a0f93ff5` = the file; grants unchanged (authenticated yes, anon no). No new object, so no new cross-firm coverage line (the guard passed on dev).

**Existing tests that change (requirement change, owner decision 2026-11-12):** `tests/unit/in-office-view.test.tsx` first case (a reviewed copy not yet placed is now listed; untagged and To review cases added); `tests/e2e/in-office.spec.ts` (6 rows instead of 3, new order, the not-placed copy is now listed). Everything else is new tests only.

**Verification (session, 2026-11-12):** lint 0/0 · typecheck 0 · unit 88 files / 800 tests · build 0 · RLS on dev: `document-search` 54 (the 3 new `no_fy` cases failed before the migration, pass after), `cross-firm/guard`, `custody`, `custody-today`, `format-reads`, `returnable`, `review-dispatch` 97 passed · e2e locally against dev: `in-office.spec` 3 + `all-documents.spec` 5 (incl. the new No financial year test) passed.

**Still open:** a dev Regression dispatch with `only` = `rls/document-search` (CLAUDE.md rule for PRs with a migration); staging/prod get the migration at the next release replay.
