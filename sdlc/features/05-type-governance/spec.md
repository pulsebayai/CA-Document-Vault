# Spec: Type governance
Intent: ./intent.md · Status: approved (Raja 2026-10-02, all spec decisions as recommended) · Date: 2026-10-02
Screens: mockup 05 (Settings › Document catalogue, "Proposed by staff" panel), header (bell: no mockup), Settings › Collection (04, no mockup).

## Where we start (verified in code, 2026-10-02)
- A proposed type **is** a `doc_type` row: `status = proposed`, `proposed_by`, `proposed_for_client_id`, `period_kind none`, `default_frequency as_needed`, `reminders false`. 03 built no `doc_type_proposal` table. Names are unique per group **per client** (`doc_type_proposed_name_key`). Approved names are unique per group.
- `create_proposed_type` adds a plan row (`client_doc_type`, as needed) and, if needed, a client group row holding only that type.
- **Plan rows can't move** (`IMMUTABLE: plan rows cannot move` on client / type / group).
- 03's document trigger re-checks on any type change:
  - the period kind fits the type (`PERIOD_KIND`);
  - an archived document can't change (`ARCHIVED`);
  - 07's review reset applies (AC-4).
- 04 generates expected items only for approved, scheduled plan rows, so proposed types have none. 04's AFTER trigger re-links a document whenever its type changes.
- Settings › Catalogue shows the panel read-only to Admin/Manager (03 AC-16).

## User stories & acceptance criteria
**Queue**
- **AC-1 Queue items.** Given pending proposed types, when Admin/Manager opens Settings › Document catalogue, the "Proposed by staff" panel shows **one item per group + name** (case and spaces ignored), oldest first. Each item shows:
  - name, group;
  - who proposed it (one or more names) and when (earliest);
  - "used on N clients" (the client names on hover/expand, only those the viewer can see; Admin/Manager see all);
  - the number of documents;
  - a "N waiting" badge on the panel.

  Empty: "No proposed types waiting." Staff and Limited don't see the panel (unchanged).
- **AC-2 Approve.** Given an item, when Admin/Manager clicks **Approve**:
  - the earliest row of the item becomes an approved, active type, offered to every client (suggestions, Add document, Client › Settings, catalogue list);
  - the item's other rows (other clients) are **merged into it** under AC-5's rules;
  - if an approved type with the same name already exists in the group, Approve is refused: "Use Merge into… — 'X' already exists in GST".
- **AC-3 Edit & approve.** A form, the same fields and validation as 02's "+ Add type": name, aliases, group, period kind, frequency and schedule offsets, registration kind, reminders. It approves with the edited values.
  - **Renamed** → the old name is added to aliases.
  - **Group changed** → the type moves group, and each proposing client's plan row is retired and re-added in the new group (AC-5 plan rules; plan rows can't move).
  - **Period kind** must fit every existing document of the item. Otherwise it is refused: "N documents are filed for a month; a yearly type can't hold them". Those documents are listed with links.
- **AC-4 Schedule for the proposing clients (intent Q4).** When the approved type is scheduled (frequency ≠ as needed), each proposing client's **active** plan row takes the type's schedule, from the earliest still-open period (04's default). 04 generates their expected items at once. Paused and removed rows keep their state; they take the schedule but generate nothing until resumed or re-enabled (04 rules). Other clients are unchanged (no silent propagation).

**Merge (= "map to existing")**
- **AC-5 Merge into an approved type.** Given an item and an approved, active, client-source target in any group, **Merge into…** does all of this in one transaction:
  - every document of the item's rows, **archived ones included**, moves to the target. DOC-ID, versions, received details, period and remark are unchanged;
  - each proposing client's proposed plan row → `removed`. The target is **added to that client's plan** if absent (target's default schedule, earliest open period; the client group row is created or re-enabled as in 03's propose). If the target is already in the plan, in any state, it is left as is (spec decision S1);
  - the proposed name is added to the target's aliases (unless it already is the name or an alias);
  - each proposed row is retired: `status mapped`, inactive, `mapped_to_id` = target. Nothing is deleted;
  - 04's trigger links each moved document to the target's expected item for its client, period (and registration) when one exists. That item becomes received under 07's rule (not Needs correction).
- **AC-6 Review and dispatch survive a merge (intent Q2).** A merged document keeps its status, reviewer, reviewed-at, correction reason and dispatch. **No `reset` history row** is written. Any other type change (staff editing a document) still resets, as in 07.
- **AC-7 Period fit before merge.** If any document's period doesn't fit the target's period kind (03's `PERIOD_KIND` rule), the merge is refused before anything changes. The dialog says how many and which (DOC-IDs, links); nothing moves.
- **AC-8 Preview.** The Merge and Approve dialogs show what will happen before confirming, e.g.:
  - "12 documents on 2 clients move to Payroll register."
  - "Review and dispatch states stay."
  - "Payroll register is added to 1 client's plan (monthly, from Sep 2026)."
  - "3 documents will count as received for their expected items."

**Reject**
- **AC-9 Reject.** Allowed only when the item has **no documents** (archived included). A reason of 1–500 characters is required. Each row is retired (`status rejected`, inactive) and its plan rows → `removed`. With documents, Reject is disabled with "N documents use this type. Merge it into an approved type instead." (intent Q3)

**Everyone**
- **AC-10 Who.** Only Admin and Manager can approve, edit & approve, merge or reject (intent Q5). Staff and Limited calling the functions directly get `ROLE_REQUIRED` (RLS/DB test).
- **AC-11 Decided once.** A second decision on an item already decided (another tab, another admin) fails with "Already decided by <name>", and the panel refreshes. A document filed under a proposed type while it is being merged either lands before the merge (and moves) or is refused afterwards (`TYPE_NOT_OFFERED`): never left behind.
- **AC-12 Optional comment.** Every decision takes an optional comment (≤ 500), required for Reject. It is stored on the type row, never in `activity`.
- **AC-13 Notifications.** Each distinct proposer of a decided item gets one in-app notification:
  - "Salary register (Payroll) was approved."
  - "Salary register was merged into Payroll register."
  - "Salary register was rejected: <comment>."

  It is shown by a **bell** in the header for every signed-in staff member: `Notifications, N unread`, a badge with the count, and a panel of the newest 20. **Opening the panel marks them read** (S4). A notification never names a client, so it can't reveal one the recipient can't see. Each staff member sees only their own notifications (RLS).
- **AC-14 Audit.**
  - One activity row per decision: `doc_type.approved` / `doc_type.merged` / `doc_type.rejected` (type IDs, target ID, counts of documents, clients and plan rows; no names).
  - **Plus one `document.type_merged` row per moved document** (document, client, from-type and to-type IDs), so each document's history shows it (S2).
  - Plan changes use 02/04's existing activity actions.
- **AC-15 Search and suggestions.**
  - Retired types disappear from type filters, suggestions and the catalogue.
  - `/documents` finds merged documents under the target.
  - Typing the old proposed name in Add document suggests the target, through its alias.
- **AC-16 Metric 3.** Settings › Collection (Admin/Manager) shows **"Filed under approved types: N%"** = classified, non-archived documents whose type is approved ÷ all classified, non-archived documents. Beside it: "N proposals waiting · oldest N days" (intent metric 1).
- **AC-17 Speed.**
  - A merge of an item with 1,000 documents finishes in < 2 s on dev (RUN_SLOW test).
  - The queue loads in < 1 s with 50 items.
  - 03's document save time is unchanged (documents-perf stays green).

## Functional requirements
- Grouping key = `(doc_group_id, lower(name))`. `create_proposed_type` already collapses spaces, so no new normalisation is needed.
- An item's "survivor" (AC-2/3) is its earliest-created row. The others are merged into it in the same transaction.
- Approving clears `proposed_for_client_id` and keeps `proposed_by`, so who proposed it stays visible on the catalogue row as "proposed by <name>".
- Retired rows (`mapped`, `rejected`) keep `proposed_for_client_id` for the record. The status ⇔ client check becomes `status in (proposed, mapped, rejected)` ⇔ client set.
- The merge target must be approved, active and `source = client`. A firm record can't be in a plan.

## Non-functional requirements
- **Security:** every decision is one SECURITY INVOKER function (02 pattern); writes it needs beyond RLS use a transaction flag `app.type_merge` = the proposed type's ID, honoured only by 03's document trigger for a change of `doc_type_id` alone (skip the archived guard and the review reset). Notifications are written only by these functions through a SECURITY DEFINER private helper, read and marked read only by their recipient. `search_path = ''`, tenant first.
- **Privacy:** no free text in `activity` or `notification` (names are read at display time from the type rows; comments live on the type row).
- **Accessibility:** WCAG 2.1 AA. The bell is a button with an accessible name and count; the panel is a dialog or disclosure that keyboard and screen readers can use. Dialogs use the shared Modal. Axe-clean.
- **Phones:** the catalogue panel and bell work at 390 px.

## Data model changes (schema lock)
- `doc_type_status` enum: + `mapped`, + `rejected`.
- `doc_type`: + `mapped_to_id uuid null → doc_type`, `decided_by uuid null → staff_user`, `decided_at timestamptz null`, `decision_comment text null (≤ 500)`. Check: `mapped_to_id` set ⇔ `status = mapped`. The status/client check is widened as above.
- New `notification` (id, office_id, recipient_id → staff_user, kind enum `type_decision`, entity_type, entity_id, data jsonb (IDs and the decision only), created_at, read_at). Index `(recipient_id, created_at desc)`. RLS: select and update(`read_at`) own rows only; no insert/delete policies; `reset_test_office` purges it.
- 03's `document_before_write` honours `app.type_merge` (above). Nothing else changes in 03/04/07 objects.
- **No `doc_type_proposal` table** (S6): the type row is the proposal (03 already built it that way). architecture.md is corrected at merge.
- **Existing data:** none to migrate (dev only; existing proposed rows stay `proposed`).

## API / interfaces
SQL (SECURITY INVOKER unless noted):
- `proposal_queue()` — the items (AC-1), counts, documents, visible client names.
- `preview_type_decision(p jsonb)` — AC-8 counts and AC-7/AC-3 period conflicts, without writing.
- `approve_proposed_type(p jsonb)` (`{type_id, edits?, comment?}`).
- `merge_proposed_type(p_type uuid, p_target uuid, p_comment text)`.
- `reject_proposed_type(p_type uuid, p_comment text)`.
- `mark_notifications_read()`.
- `private.notify(…)` (definer).

`p_type` is any row of the item; the function resolves the item.

Server actions in `src/lib/catalogue/governance.ts`; notifications in `src/lib/notifications/`.

## UX flows & screens
- **Panel (mockup 05):** each row has **Approve** (primary), **Edit & approve** (link-button; agreed deviation, ui-reference 2026-09-25) · **Merge into…** · **Reject**, in the mockup's order. The mockup's "Merge into…" wording is kept for map (S5). "Used on N clients" expands to the client list.
- **Merge dialog:** an approved-type picker (closest by name/alias first, reusing 03's trigram suggestion), the preview (AC-8), an optional comment and "Merge". A period conflict (AC-7) replaces the button with the list.
- **Reject dialog:** a required reason; disabled with the reason when documents exist.
- **Edit & approve dialog:** 02's add-type form, pre-filled.
- **Bell:** header, before the avatar. The panel shows newest first ("Salary register was merged into Payroll register · 2 Oct, 11:40"), "No notifications" when empty, and "Mark all read" is implicit on open.
- **Collection page:** the metric 3 figure and the queue age line, in 04's figure pattern.
- **States:** each dialog has loading, error (alert + retry) and stale ("Already decided") states.

## Test strategy
| AC | Test | Lane |
|---|---|---|
| 1 | queue grouping, counts, visible names | RLS `type-governance.test.ts` + e2e `type-governance.spec.ts` |
| 2–4 | approve / edit & approve: offered to all, survivor + merge of others, alias on rename, group move, period fit, schedule → expected generated for proposing clients only | RLS |
| 5–7 | merge: every document (incl. archived) moved with DOC-ID/versions intact; plan rows removed + target added or left; alias; retired row; linked to expected item; review/dispatch kept, no reset row; a normal type edit still resets; period conflict refuses with no change | RLS |
| 8 | preview numbers equal what the decision then does | RLS |
| 9 | reject refused with documents; retires + removes plan rows | RLS |
| 10 | Staff / Limited get ROLE_REQUIRED on every decision function | RLS |
| 11 | second decision refused; concurrent filing never left behind (two sessions) | RLS |
| 12–14 | comment stored on row only; activity rows (one per decision + one per document, no free text, ACTIVITY_PII passes); notification to each proposer only; others can't read or mark it | RLS |
| 13 | bell count, open marks read, keyboard, 390 px, axe | e2e |
| 15 | suggestions find target by old name; retired types absent from filters/catalogue; `/documents` finds moved documents | RLS + e2e |
| 16 | metric 3 arithmetic and queue age | RLS + e2e |
| 17 | merge of 1,000 documents < 2 s; documents-perf unchanged | RLS (RUN_SLOW) |

- All new tests join the regression suite.
- None is smoke-safe (all write data).
- 03/07's existing tests stay unchanged and green. 07's AC-4 reset test proves the non-merge path still resets.
- **RUN_SLOW before merge** (05 changes 03's document trigger).

## Proposed architecture changes
1. **Type governance paragraph:** the proposal is the `doc_type` row (status proposed · approved · mapped · rejected, `mapped_to_id`, decision columns). No `doc_type_proposal` table. Merge doesn't re-point expected items (proposed types have none) or plan rows (immutable): proposed plan rows are removed and the target is added.
2. **`notification`** (in-app, recipient-only RLS, written only through functions, IDs only), the first per-user inbox table.
3. **Transaction flag `app.type_merge`**, and the one exception to 07's reset rule: a catalogue merge doesn't reset reviews.

These are applied in 05's PR (05 holds the schema lock; the architecture lock is requested with it, since 08 needs none).

## Spec decisions (Raja 2026-10-02, all as recommended)
- **S1 Merge adds the target to the client's plan** with its default schedule, if absent. *Recommended*: the staff member proposed it because the firm needs it from that client, and it matches Q4. The alternative is to only remove the proposed row, so the client's plan loses the type until someone adds it.
- **S2 One activity row per moved document** plus one per decision. *Recommended*: each document's history (08's document activity card) shows "type merged". The alternative is one row per decision, cheaper but invisible from the document.
- **S3 Archived documents are merged too.** *Recommended*: the catalogue fully converges and nothing is left on a dead type. The alternative leaves archived documents under the retired type.
- **S4 Opening the bell panel marks all read.** *Recommended* (simplest; only one kind of notification). The alternative is per-item read plus "Mark all read".
- **S5 UI wording "Merge into…"** (mockup) for map. *Recommended.*
- **S6 No `doc_type_proposal` table** (architecture correction). *Recommended*. The alternative is a separate table that duplicates the row 03 already writes.

## Risks & areas of concern
- **Changing 03's document trigger** (the most-used write path). Mitigation: the flag is checked only when `doc_type_id` alone changed and only for the flagged type; RUN_SLOW plus the full 03/07 suites.
- **Set-based update of up to 1,000 documents fires 04's AFTER linking trigger per row.** It must stay < 2 s (AC-17). If it fails, defer linking set-based like 04's `app.expected_defer`.
- **Group move on Edit & approve** creates or re-enables client group rows. That touches Limited visibility (assignment); the group row takes the client's incharge, as 03 does today.
- **08 runs in parallel** and adds the Activity nav item to the same header file. A small merge conflict is expected (merge order in the plan).

## Out of scope
As in the intent: AI suggestions, merging two approved types, staff email, notifications other than type decisions, bulk decisions across names.
