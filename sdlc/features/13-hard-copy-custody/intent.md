# Intent: Hard-copy custody — "Document in office" and Log receipt
Author: Sidambara (drafted with Claude) · Status: **approved** (Sidambara, 2026-10-31) · Date: 2026-10-31
Roadmap item: 13-hard-copy-custody · Release: **R1** (Kushal Associates: needed before they start using the app, Q7) · Moves product metric: 1 (on-time completeness: received → returned) and 4 (Inbox age)
Source: Kushal review 2026-10-29 → `sdlc/feedback/2026-10-29-kushal-review-plan.md` §0 (**Q3**, **Q8**, follow-up 16:50) and the 30 Oct D-table (**Sankar #6, #14**). Builds on 12's **Returnable** flag and **Handed over by**.

## Problem
Paper is the part of the job the vault tracks least. The product promise is "expected → received → **returned**", and its core-problem cost includes "originals not tracked back to clients". Today:
- **A reviewed hard copy has no "where is it" state.** After Reviewed, a returnable hard copy jumps straight to "Ready to dispatch", worked out by the app; a non-returnable one just says "Reviewed". Kushal's team can't tell whether the paper is actually in the office, on someone's desk, or already with the article clerk. They asked for **Document in office** as a step every hard copy passes through (Q8).
- **"Ready to dispatch" isn't a decision.** The app shows it as soon as a returnable copy is reviewed, so Today's "Ready to dispatch" counts papers nobody has put aside for return. Staff can't say "this one is not going back yet".
- **Reception logs paper slowly.** The front desk receives bundles from clients and couriers. Today they must open the full Add document form per paper (type, period, channel…), or keep a separate register. Kushal wants a short **Log receipt** form for the desk, using the Staff role (Q3): client, what came in, how many, who handed it over. The scan is attached later from Untagged documents.
- **Papers sit in the office for months.** Nobody is reminded that a returnable original has been held a long time (Sankar #14: flag after 30 days).
- **Paper needs a reference staff can write on it.** Sankar #6 asked for reception paper IDs with the client code.

**Cost:** originals not returned or returned late (client trust, compliance risk on returned originals); the desk's register stays outside the vault (principle 2 "one source of truth" broken); Today's dispatch count can't be trusted.

## Proposed outcome
1. **"Document in office"** becomes a stored step for **every hard copy** (returnable or not), after Reviewed (Q8):
   - returnable: Reviewed → **Document in office** → **Ready to dispatch** → Dispatched (07's packet);
   - not returnable: Reviewed → **Document in office** (final: the firm keeps it).
   - Each move is a **click** ("Mark in office", "Ready to dispatch") on the document page and in bulk on `/documents`. **Staff, Manager and Admin can undo** each move; undo dispatch stays Admin/Manager (12).
   - Soft copies are unchanged (they end at Reviewed).
2. **"Ready to dispatch" becomes a decision, not a calculation.** Only documents someone marked ready appear in Today's "Ready to dispatch", the dispatch dialog and the `/documents` Return filter.
3. **Log receipt** (reception, Staff role, no new role or permission): a short form — client, what came in, how many, handed over by (12) — that creates hard-copy documents with no file. They go where 03 puts them today (filed if a type is given, else Untagged), and staff attach the scan later.
4. **Held too long:** a returnable document in office for more than **30 days** (Sankar #14) is flagged on Today and filterable on `/documents`.
5. **Paper reference:** the receipt confirmation shows each document's **DOC-ID + client code** to write on the paper (Sankar #6: recommendation, no second ID).

## Users & systems affected
- **Reception (Staff role):** Log receipt. **Staff / Manager / Admin:** the custody steps and undo. **Limited:** sees and moves the steps (and undoes them) on clients they can see (Q5).
- **Systems (detailed in the spec):**
  - `document`: a stored custody step (+ who/when), history like 07's `document_review`;
  - 07's rules: state order (`src/lib/documents/state.ts` + SQL `return_state`), `create_dispatch` eligibility (must be Ready), the dispatch dialog, "Held N days";
  - 12's review reset: what a reset or a correction does to custody;
  - 03b search (Return filter, a custody filter), 08's bulk actions and permission matrix, 06's Today counts (`today_items`), the activity catalogue;
  - a new reception screen; the document page.

## Success metrics
1. **Every hard copy is placed:** in the pilot, ≥ 95% of reviewed hard copies reach "Document in office" within 2 working days of review.
2. **Returns tracked (metric 1, "returned"):** median days from "Ready to dispatch" to Dispatched; target ≤ 7 days. Returnable originals held > 30 days trend down month on month.
3. **Reception in the vault:** ≥ 80% of hard copies in the pilot are created through Log receipt (not a paper register), and the median Log receipt takes ≤ 30 s for one paper.
4. **Inbox age (metric 4):** median < 24 h from receipt to filed, including scans attached later.

## Constraints
- **Fixed workflow, not a builder** (principle 5): the steps are the same for every office.
- **One filing path:** Log receipt creates documents through 03's `create_document` (as 10 and 12 do); no second path.
- **Review and custody stay separate dimensions** (07): a Needs-correction document can still be in the office.
- 12's Returnable and Handed over by rules apply unchanged; link uploads (10) are soft copies, so custody never applies to them.
- No hard delete; every move and undo is logged (IDs only in activity).
- Takes the **schema + architecture locks**; changes 07's rules and 03's write paths → RUN_SLOW before merge (or the owner's deferral, as for 12).
- [Uncertain] ≈ 3–5 working days (review estimate); bulk actions and the backfill decide most of it.

## Behaviour that must not change
- 07's review flow, review history and Needs-correction rules; 12's reset rules.
- Dispatch packets: one live packet per document, recipient required, undo dispatch Admin/Manager.
- Metric 1 ("counts as received" = linked, not archived, not Needs correction): custody steps don't change it.
- Soft copies and client upload links (10).
- Every existing hard copy keeps the state it shows today after the migration (Q3).

## Out of scope
- Physical location (cabinet / shelf / file number). [Likely] a later item if Kushal asks.
- Printing labels or barcodes for papers.
- Client notifications on Ready to dispatch (feature 16, needs SES).
- A trash bin (Sankar #1, not decided).
- DSC custody (feature 14, separate entity).

## Decisions (Sidambara, 2026-10-31)
- **Q1 — one document per paper:** "How many = 3" creates 3 documents (one DOC-ID each), with the same client / what came in / handed over by, so each paper can be scanned, reviewed and returned on its own.
- **Q3 — existing hard copies keep where they look:** reviewed hard copies → Document in office; reviewed returnable copies that show "Ready to dispatch" today → stay Ready to dispatch; dispatched stay dispatched; not-yet-reviewed hard copies unchanged.
- **Q4 — a review reset keeps custody:** the paper didn't move; only the review starts again (review and custody stay separate, as in 07). Mark in office still requires Reviewed.
- **Q6 — held too long:** returnable documents only, counted from "Document in office", one office-wide 30 days.
- **Q2 — "what came in" = the type-ahead Document type field, optional:** a type picked → filed at once (period optional); blank → Untagged.
- **Q5 — Limited users may move hard copies** (Mark in office, Ready to dispatch, and undo) for the clients they can see.
