# Intent: Review & dispatch
Author: Raja (drafted with Claude) · Status: draft · Date: 2026-10-01
Roadmap item: 07-review-and-dispatch · Release: R1 · Batch D (with 06; **07 merges first**, holds the schema lock) · Moves product metric: 1 (on-time completeness: a wrong document stops counting as received) and the vision's "received → **returned**" step

## Problem
Since 03 a document is only ever "received". Two things the firm does with every document are invisible to the vault:
- **Checking it.** Someone has to confirm the file is the right one: right client, period, complete pages, readable. Today nobody can tell which documents were checked, by whom, or which are still waiting. A wrong or incomplete document is found only when the return is being prepared, close to the due date, and 04 already counts it as "received", so metric 1 overstates completeness.
- **Returning originals.** Clients hand over originals (signed returns, Form 16, deeds, share certificates) that the firm must give back. Today that's tracked from memory or a register. product.md names it as a core cost: "originals not tracked back to clients".

**Cost:** late discovery of bad documents, chasing that starts too late, originals the firm can't account for, and no audit trail for either.

## Proposed outcome
Every classified document has a visible **review state**, and every original has a **return state**, as in mockups 01 and 10:
- **To review → Reviewed.** One click, "Mark reviewed"; the row then reads "reviewed <date> by <name>".
- **Needs correction.** The reviewer records a reason (wrong period, missing pages…). Nothing is deleted. The document's linked **expected item goes back to "not received"**, so it shows as due/overdue again and can be reminded (06). A corrected file goes back to To review.
- **Ready to dispatch → Dispatched (originals only).** A reviewed original shows "Ready to dispatch". Staff return originals in a **dispatch**: one packet for one client with date, method (courier · hand delivery · client collected · other), optional courier name and tracking number, and recipient. It holds one or many originals. Each original then reads "dispatched <date> by <method>".
- **Where staff see it:** Client › Documents rows get the state badge and the next action (mockup 10). The `/documents` page from 03b gets the new states in its Status filter and facet, which gives staff "everything to review" and "everything to dispatch" lists before 06's Today screen exists. 06 adds the Today counts and rows ("To review", "Ready to dispatch").
- **History:** every review, correction, dispatch and undo is in `activity` (IDs and field names only).

## Users & systems affected
- **All staff, including Limited, for documents they can see:** review, needs correction, dispatch (Raja 2026-10-01: same visibility rule as the documents).
- **Admin/Manager:** undo a review, correction or dispatch, with a reason.
- **Systems:**
  - `document_status` gains values;
  - a new `dispatch` (packet) plus dispatch-items entity;
  - 04's linking rule changes, because a document needing correction no longer makes its expected item received;
  - 03's document page and version upload (a corrected file goes back to To review);
  - 03b's status filter, facet and validation (new values);
  - Client › Documents cards;
  - `activity`.

## Success metrics
1. **Originals accounted for (pilot):** every original received during the pilot is either dispatched or visibly "held", with how long it's been held. At each month end, zero originals are unaccounted for in the firm's own check against the vault.
2. **Review backlog (baseline first):** median time from received to reviewed, and the count of documents To review for more than 3 working days, are measurable from pilot day 1. The baseline is recorded after 2 pilot weeks; no target until then.
3. **Metric 1 honesty (tests):** a document marked Needs correction never counts its expected item as received, and the item returns to received when a corrected document is reviewed or filed. The received-on date then comes from the corrected document.
4. **Effort:** Mark reviewed = 1 click from Client › Documents. Dispatching N originals of one client is one dialog with ≤ 4 inputs, not N separate actions.

## Constraints
- **Who (Raja 2026-10-01):** anyone who can see the document may review, mark needs correction or dispatch it. Undo is Admin/Manager only, with a reason. Archived documents are read-only, as in 03.
- **Scope (Raja 2026-10-01):** **every** document needs review, once it is classified (client + type). Inbox documents can't be reviewed until classified. Documents that exist before 07 start as To review (dev data only; no real data exists yet).
- **Dispatch (Raja 2026-10-01):** a packet = one client, date, method, optional courier and tracking number, recipient name; it contains originals only. Hard copies that aren't originals and soft copies never need dispatch. A recipient name is personal data: it is stored on the dispatch, never in `activity`, URLs or logs.
- **The state shown is derived where it can be:** "Ready to dispatch" = an original that is reviewed (or needs correction, see Q1) and not yet dispatched. It is not stored separately.
- **No client-facing output in 07.** Dispatch acknowledgement emails stay on the Later list.
- **Bulk "Mark reviewed" is 08**, which depends on 07's status.
- **Locks:** schema lock → 07 at plan approval. 06 builds alongside under an additive-only exception (new tables and functions of its own). The architecture lock → 06 (Brevo integration). 07's cross-cutting decisions are flagged for architecture.md at merge.
- **Volume:** state changes must not slow 03's filing or 04's linking. The documents-perf and expected volume checks stay green (RUN_SLOW before merge, since 07 changes 03/04 write paths).

## Behaviour that must not change
- 03's filing speed (≤ 3 clicks after choosing the file), DOC-IDs, the Inbox, versions, archive rules and file security.
- 04's generation, dates, waive/reopen and metric 1 definition. Only "received" gains the condition "and not needing correction".
- 03b's search contract and visibility. The new statuses simply appear as status values.
- Limited users see only their assigned clients.

## Out of scope
- Today screen counts and rows → **06**.
- Bulk mark reviewed, bulk zip download, Activity screen, Users & roles → **08**.
- Proposed-type review → **05**. "Review" in 07 means checking a received document, not the catalogue.
- Acknowledgement emails to clients on receipt or dispatch; courier integrations or label printing; reviewer assignment and queues per person; review checklists per document type.
- A "Scanned" flag for hard copies (shown in mockup 10). It's left out unless you want it; see Q4.

## Open questions (my recommendation first)
1. **Can an original that Needs correction be dispatched?** Recommend **yes**: a wrong original still has to go back to the client, and often goes back *with* the correction request. Originals still in To review can't be dispatched; review them first.
2. **How does a correction get resolved?** Recommend: uploading a new version of the same document (03's versions) **or** filing a separate correct document both work. A new version puts the document back to To review. A separate document links to the expected item as usual, and the wrong one stays marked Needs correction for the record.
3. **Undo rules?** Recommend: Admin/Manager can undo any review, correction or dispatch (a reason is required, and it's logged). Staff can't undo, so the trail stays trustworthy. Is a same-day self-undo for the person who did it worth adding? Recommend not in 07.
4. **The mockup's "Scanned" badge on hard copies:** leave it out (recommend) or include it in 07?
5. **Pilot volume:** roughly how many originals a month does the firm receive, and how long are they usually held? This sets whether a "held > N days" warning is worth building now. Recommend: show the held age only, with no warning, in 07.
