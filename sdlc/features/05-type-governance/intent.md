# Intent: Type governance
Author: Raja (drafted with Claude) · Status: draft · Date: 2026-10-02
Roadmap item: 05-type-governance · Release: R1 · Batch E (with 08; **05 holds the schema lock**) · Moves product metric: 3 (catalogue convergence), and keeps metric 1 honest for documents filed under proposed types

## Problem
Since 03, staff create a **proposed type** inline while filing ("+ New type '…' for this client"). The architecture expects about 60% of the types the firm needs to arrive this way. Nothing happens to a proposed type after that:
- **It stays private to one client.** The same real-world document proposed on two clients ("Salary register") becomes two separate proposed types. Search, facets and the catalogue split the same document kind in two, and the mockup's "used on 2 clients" can't be shown.
- **It is never collected.** Proposed types are "as needed", with no schedule, so 04 never generates expected items for them. A document the firm needs every month from that client is never chased, and metric 1 doesn't cover it.
- **Duplicates of existing types stay duplicates.** A typo or an old form name ("Form 16" vs "Form 130") filed as a new type isn't counted against the approved type: its documents don't link to that type's expected items, and search by the approved type misses them.
- **Admin/Manager can see the queue but can't act.** 03 shipped the "Proposed by staff" panel read-only.
- **The proposer never hears back.**

**Cost:** a catalogue that drifts apart client by client, documents that are invisible to collection and search by type, and metric 3 that can only get worse.

## Proposed outcome
On Settings › Document catalogue, the "Proposed by staff" panel (mockup 05) becomes a decision queue for Admin/Manager. Each item shows the name, group, proposer, date, the clients it's used on and its document count. The four actions:
- **Approve.** The type becomes an approved catalogue type, offered to every client.
- **Edit & approve.** Rename it, move it to another group, or set its frequency and schedule first.
- **Map to existing** (the mockup's "Merge into…"). All its documents and plan rows move to the chosen approved type. The proposed type is retired, and its name is kept as an alias of the target, so suggestions find it next time. Documents then link to the target's expected items (04's linking does this, no new rule).
- **Reject.** Allowed only when no documents use the type (see Q3).

Every decision is logged in `activity`, and the proposer gets an **in-app notification**: a header bell with an unread count and a list. Never a blocking popup.

**Same-name proposals are one queue item.** A name proposed in the same group by different clients is decided once for all of them (see Q1).

**Metric 3** ("% of documents filed under approved types") is shown on Settings › Collection beside metric 1.

## Users & systems affected
- **Admin/Manager:** decide proposals. This matches today's matrix row "Approve proposed types, manage catalogue" and 02's catalogue write rights. architecture.md says "Admin review queue"; this intent reads it as Admin/Manager.
- **Staff who proposed a type:** receive notifications.
- **Everyone else:** sees approved types in suggestions, and mapped names found through aliases.
- **Systems:**
  - `doc_type` (status / retirement / alias);
  - `document.doc_type_id` re-pointed;
  - `client_doc_type` re-pointed or retired;
  - 07's review-reset rule (see Q2);
  - 04's linking (runs as is on re-pointed documents);
  - a new `notification` table;
  - 03b search and facets (types merge);
  - Settings › Catalogue and Collection, the header;
  - `activity`.

## Success metrics
1. **Queue age (pilot):** median time from proposal to decision is ≤ 3 working days. No proposal is older than 10 working days at any month end.
2. **Metric 3 measurable from day 1** on Settings › Collection, with the baseline recorded after 2 pilot weeks. Target: rising month on month (product.md).
3. **Correctness (tests):** after a map, every document of the proposed type is under the target type and still has its DOC-ID, versions and history. Each one links to the target's expected item for its period and client when one exists. No document is lost or duplicated.
4. **Effort:** one decision = ≤ 2 clicks plus the target choice (Map) or the edit form (Edit & approve). It covers every client that used that name.

## Constraints
- **Nothing is hard-deleted.** A mapped or rejected type stays as a retired row. The original value is kept in `activity` and on the row.
- **Filing is never blocked** (architecture). Proposing stays exactly as in 03.
- **No silent propagation** (02): an approved type joins *other* clients' plans only when someone adds it. What happens to the proposing clients' own plan rows is Q4.
- **Re-pointing must be one transaction per decision** (one SECURITY INVOKER function, one `activity` row, per the 02 data-access pattern). It must stay fast at pilot volume: a type used on ~1,000 documents decides in < 2 s.
- **Expected items:** proposed types never have expected items (they are unscheduled; 04 generates only for approved, scheduled rows), so there is nothing to re-point. The roadmap row's "re-points `expected_doc`" becomes "documents link to the target's items through 04's existing trigger". Verified in the 04 migration, 2026-10-02.
- **Locks:** schema lock → 05 at plan approval. 05 changes 03/07 write paths (`document.doc_type_id`, the review-reset trigger), so **RUN_SLOW before merge**.
- **Notifications:** in-app only. No email to staff (staff nudge emails stay on the Later list).

## Behaviour that must not change
- 03's inline proposing, suggestions (except that mapped names now also match as aliases) and the ≤ 3-click filing.
- DOC-IDs, versions, archive rules and file security.
- 04's generation and metric 1 definition, and 07's review and dispatch rules for every change that isn't a 05 map (see Q2).
- Limited users see only their assigned clients. A notification never reveals a client the recipient can't see.

## Out of scope
- AI or automatic type suggestions or auto-mapping (Later).
- Mapping or merging two **approved** types (catalogue clean-up). 05 covers proposed → approved only.
- Staff email notifications. Notifications for anything other than type decisions. The table is generic, but 05 only writes type decisions.
- Bulk decisions across different names.

## Decisions for you (recommendations first)
- **Q1 Same-name proposals:** proposals with the same name (ignoring case and spacing) in the same group are **one queue item**, and one decision applies to all of them. *Recommended.* The alternative is one item per client: simpler, but the admin decides "Salary register" N times and approving the second clashes with the first's approved name.
- **Q2 Does a map reset reviews?** 07 resets a document to To review when its type changes. **Recommended: a 05 map keeps each document's review and dispatch state.** The file and its content are unchanged; only the catalogue label moves. The map writes one history note. The alternative is to reset everything mapped, which would put already-checked documents back on everyone's Today list.
- **Q3 Reject when documents use the type:** **Recommended: Reject only when no documents use it; otherwise the admin must Map** (the UI says why). The alternative is to reject anyway, which leaves documents filed under a dead type.
- **Q4 Approving: the proposing clients' plan rows.** They were created "as needed" as placeholders. **Recommended: on (Edit &) approve with a schedule, those clients' rows take the approved schedule** (logged), so 04 starts generating from the earliest open period. Other clients are unaffected. The alternative is to leave them "as needed" until someone edits each client.
- **Q5 Who decides:** **Admin and Manager.** *Recommended*, consistent with catalogue writes and the Users matrix. Alternative: Admin only.

## Open questions
Settled at the intent gate.
