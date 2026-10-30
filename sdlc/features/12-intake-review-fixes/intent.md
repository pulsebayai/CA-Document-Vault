# Intent: Intake and review fixes from the Kushal review
Author: Sidambara (drafted with Claude) · Status: **approved (Sidambara, 2026-10-30 09:49 IST)** · Date: 2026-10-30
Roadmap item: 12-intake-review-fixes · Release: **R1** (Kushal Associates: needed before they start using the app, 2026-10-29) · Moves product metric: 5 (adoption) mainly; 4 (Inbox age) and 3 (catalogue convergence)
Source: review of 2026-10-29 (Sidambara + Sankaranand with Kushal's team) → `sdlc/feedback/2026-10-29-kushal-review-plan.md` (§0 decisions); discussion note "CA Document Vault — Changes from the 29 Oct review" confirmed by Kushal + Sankar on 2026-10-30.

## Problem
Kushal's team tried the app on dev and found everyday intake and review work slower or more confusing than it should be. They won't start the pilot until this is fixed (Q7).
- **Document type is a long dropdown** (every approved type in the office). Sankar's prototype, the agreed UI source of truth, has a type-ahead search field. The dropdown was an unrecorded change from the mockup. It gets longer with every type added, and staff can't find types by short forms ("3B").
- **"Original" is a third way of receiving,** next to soft copy and hard copy. It mixes two things: the paper form, and whether the client wants it back. Staff were unsure which to pick.
- **Nobody records who handed in a hard copy** (client staff, courier, security). When a paper goes missing, nobody knows who brought it.
- **The Inbox can't show the file.** Staff assign a client and type without being able to open the document.
- **Reviewers expected the Inbox to be their review queue.** It holds only unfiled documents. The review queue is Today › To review, and nothing points there.
- **Editing after filing looks locked.** It is possible today (document page › Edit, including a type in another group), but the group shows as read-only and Edit is easy to miss. So staff think a wrong group means re-uploading.
- **"Needs correction" always means re-upload.** A wrong period or type should be fixed by editing, with no new file.
- **Only Admin/Manager can undo "Reviewed".** A staff member who clicks it by mistake has to ask a manager.
- **Long lists:** Client › Documents has no pages. `/documents` shows 50 rows a page; the team wants 20, newest received first.
- **Staff see every client first.** They want their own clients by default.

**Cost:** the pilot doesn't start. After that, [Likely] slower filing, mis-classified documents and duplicate type proposals.

## Proposed outcome
1. **Type-ahead Document type field** (Sankar's prototype), on Add document, Inbox › Assign and Edit:
   - suggestions grouped under group headings, frequency on the right;
   - the client's plan types first; typing also searches the rest of the catalogue ("Other types");
   - short forms and hyphens ignored ("3B" → GSTR-3B);
   - a capped list ("keep typing to narrow"); empty group headings hidden;
   - keyboard ↑ ↓ Enter Esc, ARIA combobox (WCAG AA);
   - no match: close types first, then "+ Propose a new type", into 05's queue as today.
2. **Received as = Soft copy | Hard copy, plus a Returnable checkbox** for hard copies. Existing "Original" documents become hard copy + returnable. Dispatch, Today's "Ready to dispatch" and the `/documents` filters follow Returnable instead of "Original".
3. **Handed over by** (required for hard copies): a kind (client's staff, courier, security, other) plus a name.
4. **Inbox:** View / Download on each row (also on `/documents` and Today rows). The wording says what the Inbox is, with a link to Today › To review.
5. **Edit:**
   - the same type field;
   - a confirmation line when the type or group changes ("Moves from GST › GSTR-3B to Banking › Bank Statement. Review will reset.");
   - an Edit button on document rows and on the Needs-correction message.

   Staff, Manager and Admin, as today (Q4).
6. **Needs correction has two kinds:** "Wrong file" (upload a new version, as today) or "Wrong details" (fix with Edit, no new file). Either fix sends the document back to To review.
7. **Staff can undo a review** (Q4). Undo dispatch stays with Admin/Manager.
8. **Lists:** `/documents` 20 per page, newest received first (Q6). Client › Documents gets pages.
9. **"My clients" filter on by default** for Staff on the Clients list (Q5). One click shows all clients. Nobody loses access to any client.

## Users & systems affected
- **Staff / Manager / Admin:** all items. **Limited:** the type field, Inbox view, wording and lists. Their permissions are unchanged.
- **Systems (to be detailed in the spec):**
  - `document` (received as + returnable, handed over by; migration of "original" rows);
  - 03's `create_document` / `update_document` + `document_before_write`;
  - 07's state rules (`src/lib/documents/state.ts`, SQL `return_state`), dispatch eligibility and Needs-correction reasons;
  - 03b search filters ("returns");
  - 06's Today counts;
  - 08's permission matrix (split "Undo a review or a dispatch");
  - 10's link uploads (soft copy, unchanged);
  - the document form, Inbox, document page, `/documents`, Clients list;
  - `activity` sentences.

## Success metrics
1. **Adoption (metric 5):** the pilot starts with 12 (and 13–15) in place. During the pilot, ≥ 80% of pilot staff are active ≥ 4 days a week.
2. **Inbox age (metric 4):** median < 24 h in the pilot. Viewing from the Inbox should cut the time between "arrived" and "filed".
3. **Fewer duplicate proposals (metric 3):** share of 05 queue items closed as "merge into an existing type". Baseline = the first 2 pilot weeks. Target: falling.
4. **Corrections without re-upload:** share of Needs-correction documents fixed by Edit vs by a new version, and the median time back to To review.
5. **Filing speed (principle 1):** a known type is picked in ≤ 3 keystrokes + Enter. Re-time 03's AC-5 with a Staff user on staging.

## Constraints
- **The mockup is the UI source of truth** (`ui-reference.md`). The type field follows Sankar's prototype, and every addition is recorded as a deviation row.
- **Governed taxonomy stays.** Typing never creates an approved type, only a proposal (05).
- **Data migration is safe and reversible in meaning.** "Original" maps 1:1 to hard copy + returnable. Dispatch packets, review state, DOC-IDs and 04 links are unchanged. Run on dev, then staging, before real data.
- **Schema lock** (new columns + migration); architecture.md note (07's state rules change from "original" to "returnable"). 12 changes 03's filing trigger and 07's rules → **RUN_SLOW before merge**.
- **No new performance load** on Today / Clients list (K3). The "My clients" filter must stay office-first.
- **Privacy:** "handed over by" names a person. It is stored on the document like the remark, never in activity, URLs or logs.
- **Design for 13:** "Document in office" (13) sits after Reviewed for every hard copy. 12's returnable flag and state changes must leave room for it, without building it.

## Behaviour that must not change
- DOC-IDs, versions, archive, the 04 linking and metric 1 rules (Needs correction still doesn't count as received).
- 05's merge (keeps review + dispatch); 10's link uploads (soft copy, channel locked, download-only until reviewed); 11's format check.
- Existing dispatch packets and their undo. A document dispatched as "Original" before the migration still shows as dispatched.
- Limited users see and can do exactly what they can today.
- Every existing test passes unedited, except where a test asserts the "Original" option or the 50-row page. Those changes are listed in the plan, flagged for approval, and never weaken a check.

## Out of scope (other features)
- "Document in office" state and the reception "Log receipt" form → **13 hard-copy-custody**.
- DSC tracking → **14 dsc-tracking**.
- Client › All documents tab, Last activity, K4 fix → **15 client-all-documents**.
- Restricting what staff can see (dropped, Q5); column chooser / saved views (not asked).
- AI type suggestions; renaming or merging catalogue types.

## Open questions (for the spec — recommended answers proposed, to confirm at the spec gate)
1. **Handed over by:** are "Client's staff, Courier, Security, Other" the right kinds? Is the name required for every kind, or only for "Other"?
2. **Inbox name:** keep "Inbox" with clearer text (recommended: no rename, as the mockup uses "Inbox"), or rename to "Unfiled"?
3. **"Wrong details" fix:** recommended — any save of a Needs-correction document by Staff+ sends it back to To review, even when only received-as / channel / remark changed (today only client / type / period / registration changes reset it).
4. **Undo review by Staff:** any reviewed document (recommended; logged), or only reviews they made themselves?
5. **"My clients":** recommended = clients where the user is the incharge or is assigned to a group or type. This matches 06's "Mine" on Today. Default on for Staff only, or for Managers too?
6. **Returnable on a soft copy:** recommended no. Only hard copies can be returnable, as only paper goes back.
