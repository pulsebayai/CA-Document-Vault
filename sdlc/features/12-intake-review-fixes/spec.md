# Spec: Intake and review fixes from the Kushal review
Intent: ./intent.md (approved 2026-10-30) · Status: **approved (Sidambara, 2026-10-30 09:53 IST; Q1–Q6 as recommended)** · Date: 2026-10-30
Screens: mockup 12 (Add document) + Sankar's prototype (cavault.pulsebay.com › Add document, live type field) · mockup 02 (Inbox) · 10 (Client › Documents) · 03 (Clients)

## Decisions taken into this spec (intent open questions, recommended answers — confirm at this gate)
| # | Question | Answer in this spec |
|---|---|---|
| Q1 | Handed over by | Kinds **Client's staff · Courier · Security · Other**, plus a **name, required for every kind** (1–120 chars) |
| Q2 | Inbox name | Keep **"Inbox"**; new subtitle + a link to Today › To review |
| Q3 | "Wrong details" fix | ~~Any save~~ → **amended by plan R1:** reset by correction kind; remark / channel / received-by never reset (AC-23) |
| Q4 | Undo review | **Staff, Manager and Admin**, any review, reason required, logged. Limited: no |
| Q5 | "My clients" | Incharge **or** assigned to one of the client's groups or types (06's "Mine"). On by default for **Staff only** |
| Q6 | Returnable on a soft copy | **No**: only hard copies can be returnable |

## User stories & acceptance criteria

### A. Document type field (Add document, Inbox › Assign, Edit)
- **AC-1** Given a client is chosen, when staff focus the empty field, then they see only that client's plan types (active rows, approved + its proposed types), **grouped under group headings** in the catalogue's group order, each with its frequency on the right (prototype). No client chosen (Inbox): the list says "Type to search all types".
- **AC-2** When staff type, matches come from the type's **name, its aliases (02) and its group's name**, case-insensitive, ignoring spaces, hyphens, dots and slashes ("3b", "gstr 3b", "GSTR3B" → GSTR-3B; "26q" → Form 26Q). The client's plan types come first, under their group headings. Every other approved, active type follows under one heading **"Other types"**, with its group name on the right in place of the frequency. Matches that start with the typed text come before matches that only contain it.
- **AC-3** At most **8** rows are shown. More matches add a last line: "N more — keep typing to narrow". A group heading with no matching rows is not shown.
- **AC-4** Keyboard: ↓/↑ move, Enter picks, Esc closes and restores the last pick, Tab leaves. It is an ARIA combobox (`role="combobox"`, `aria-expanded`, `aria-activedescendant`, listbox/option). axe shows no violations, and it works at 390 px wide.
- **AC-5** No match: the list shows up to **3 close types** (sharing a word of ≥ 3 letters with the typed text), then **"+ Propose a new type… needs approval"** (prototype wording). Picking it opens 03's existing new-type step (group choice, suggestions, 05 queue). It is offered only to Staff+ with a client chosen, as today; Limited sees "No matching type".
- **AC-6** After a pick, the line under the field reads "Group **<group>** · set from the type" (prototype), plus "Proposed — waiting for approval" for a proposed type.
- **AC-7** Upload for an expected or requested item keeps the type locked (read-only), as today.

### B. Received as, Returnable, Handed over by
- **AC-8** "Received as" offers **Soft copy | Hard copy**. Hard copy shows a **Returnable** checkbox ("The client wants this back"), unticked by default. Soft copy hides and clears it.
- **AC-9** **Migration:** every document stored as `original` becomes `hard_copy` + returnable. The count of returnable hard copies after = the count of originals before, on every office. Review state, dispatch packets, DOC-IDs, versions and 04 links are unchanged. The migration writes no activity rows; the counts are recorded in the PR.
- **AC-10** No document is ever stored as `original` again (check constraint). An API call that still sends `received_as: 'original'` is stored as hard copy + returnable (legacy alias, so older callers and test helpers keep working).
- **AC-11** Wherever "original" decided behaviour, **returnable hard copy** now decides it, with the same rules:
  - Ready to dispatch;
  - the dispatch dialog and `create_dispatch` eligibility;
  - Today's "Ready to dispatch";
  - `/documents` "Return" filter and state;
  - the document page Dispatch panel;
  - activity sentences.

  The red "Original" badge becomes a **"Returnable"** badge (same tone).
- **AC-12** A returnable document in a live dispatch packet can't change client, received as, or Returnable until its dispatch is undone (07's lock, extended to the flag).
- **AC-13** `/documents`: the "Received as" facet shows Soft copy / Hard copy. A new **"Returnable"** filter shows returnable hard copies. An old link with `as=original` opens with Hard copy + Returnable.
- **AC-14** **Handed over by** shows for hard copies: a kind (Client's staff · Courier · Security · Other) and a name (1–120 characters).
  - **Every staff screen** (server action) refuses a new hard copy, or a change to hard copy, without it.
  - The **database** enforces the shape: both fields or neither, never on a soft copy, and once set they can be changed but not cleared.
  - Existing hard copies with none show "Not recorded", and an unrelated edit doesn't force them to be filled.

  *(Amended by plan R2, 2026-10-30: "required" is checked in the app, not as a database rule.)*
- **AC-15** Handed over by shows on the document page and in the Inbox row ("handed over by Courier · <name>"). The name **never** goes into activity data, URLs or logs. Activity records only that the field changed.
- **AC-16** Client upload links (10) are unchanged: soft copy, not returnable, no handed over by.

### C. Inbox and quick file access
- **AC-17** Inbox subtitle: "Documents waiting for a client or a type. Filed documents to review are on **Today › To review** (N)." The link opens Today filtered to To review.
- **AC-18** **View / Download** buttons on each Inbox row, `/documents` result row and Today "To review" row that has a file. They use 03's existing file buttons and rules:
  - View only for PDF, JPG and PNG;
  - a link upload is download-only until reviewed (10);
  - signed ≤ 60 s after an RLS lookup.

  A hard copy with no file shows "No file yet".

### D. Edit and corrections
- **AC-19** An **Edit** button on each document row (Client › Documents, `/documents`) and on the Needs-correction message, for users who can edit that document today. Archived documents: no Edit, as today.
- **AC-20** Before saving, when the client, type or group changes, the form shows a confirmation line: "Moves from <group> › <type> to <group> › <type>." When the document is Reviewed or Needs correction, it adds "Review will reset to To review." The save needs no second click; the line is information.
- **AC-21** Marking **Needs correction** asks for the kind, **Wrong file** or **Wrong details**, plus the reason (1–500, as today). The kind is stored on the document and in its review history, and shown in the review panel and rows ("Needs correction · wrong details · <reason>").
- **AC-22** The Needs-correction message offers the matching action first: Wrong file → "Upload corrected file" (new version, 07 as today); Wrong details → "Edit details". Both actions stay available.
- **AC-23** The reset depends on the **correction kind**:
  - **Wrong details:** a saved change to client, type, period, registration, received as, Returnable, received on or handed over by sends the document back to To review, with a `reset` row in its history;
  - **Wrong file:** a new version resets it (07, as today);
  - a **remark, channel or received-by change never resets** a Needs-correction document (staff log follow-ups in the remark);
  - Needs correction marked before 12 (no kind): 07's rules, unchanged.

  A Reviewed document still resets only on a new version or a client/type/period/registration change (07, unchanged). *(Amended by plan R1, 2026-10-30; replaces Q3's "any save".)*
- **AC-24** **Undo review**: Staff, Manager and Admin can undo any review (reason 1–500, logged as today). Limited can't. **Undo dispatch** stays Admin/Manager. Settings › Users shows two rows ("Undo a review" · "Undo a dispatch"), each probed per role.

### E. Lists
- **AC-25** `/documents` shows **20** results per page, default sort **Date received, newest first** (unchanged), with page controls and "N–M of T".
- **AC-26** Client › Documents: each group card lists its received documents **20 per page**, newest received first, with Previous / Next and "N–M of T" per card. Select-all selects the documents on the page shown. The FY and group filters keep working.
- **AC-27** Clients list: a **"My clients"** toggle. A client is "mine" when the user is its incharge, or is the assigned staff of one of its active groups or plan types (06's Mine). It is **on by default for Staff**, off for Admin/Manager, and not shown for Limited (who see only their clients already). Toggling never changes access: every client stays reachable by search and link. The filter is a URL flag (no PII).
- **AC-28** The Clients list with "My clients" on is no slower than today's list on dev (02's `clients-list` timing test). It is re-timed at volume with the K3 fix.

### F. Unchanged behaviour (regression)
- **AC-29** Every behaviour listed in the intent's "must not change" holds. The full suite stays green. The only test changes are those listed under Test strategy (requirement changes: Original option, 50-row page, undo-review role), each shown in the plan and approved before it's made.

## Functional requirements
- Type matching runs in the browser over the types 03 already loads for the form (`typesForClient`: plan + approved). There is no new search endpoint. One pure function, `matchTypes(types, text)`, is unit-tested (normalising, ranking, cap, close matches).
- `create_document` / `update_document` take `returnable`, `handed_over_kind`, `handed_over_name`. `review_document` takes `p_kind` (`file` | `details`). It is optional in SQL for older callers (null = not given, shown as plain "Needs correction"); the UI always sends it.
- `undo_review` allows Staff+. `create_dispatch` checks returnable hard copy.
- `search_documents` / `search_document_facets` (same signature, one jsonb argument): `returnable` filter; `return_state` from returnable.
- `today_items`: Ready to dispatch from returnable.
- `search_clients` gets `p_mine boolean default false`, office-first with `exists` on `client_group` / `client_doc_type`.
- `/documents` passes `page_size: 20`. The SQL cap stays at 50, so other callers and tests are unchanged.

## Non-functional requirements
- **Accessibility:** WCAG 2.1 AA; axe on Add document (list open), Inbox, document page, Clients.
- **Performance:** typing filters in < 16 ms for 500 types (unit benchmark). No new query on Today. Clients list per AC-28.
- **Privacy:** handed-over name treated like the dispatch recipient: on the entity, RLS like its document, never in activity, logs or URLs.
- **Security:** no new definer function. Role checks stay in SQL (undo review) and are probed in `role-matrix.test.ts`.

## Data model changes (schema lock)
- `document.returnable boolean not null default false`; check: returnable → `received_as = 'hard_copy'`.
- Data step: `update document set received_as = 'hard_copy', returnable = true where received_as = 'original'` (under 03's write flag; no activity). Then add check `received_as <> 'original'`. The enum value stays: Postgres can't drop it without rebuilding every dependent function.
- `create type handed_over_kind as enum ('client_staff', 'courier', 'security', 'other')`.
  - `document.handed_over_kind` null, `document.handed_over_name text` null; both set or both null; length 1–120.
  - Soft copy → both null. Required by `document_before_write` on insert as hard copy, and on a change to hard copy. Can't go from set to null.
- `create type correction_kind as enum ('file', 'details')`; `document.correction_kind` (set by `review_document`, cleared with the review); `document_review.correction_kind`.
- `document_before_write`:
  - legacy `original` → hard copy + returnable;
  - the handed-over rules;
  - Needs-correction reset by correction kind (AC-23, plan R1);
  - the 07 lock on the returnable flag (AC-12).
- **Grants:** new columns are added to the existing column grants. Activity field lists may name `handed_over` but never its value (ACTIVITY_PII is unchanged).

## Existing code affected
- **Forms:** `documents/new/document-form.tsx` (type field, received as, returnable, handed over by, confirmation line), `documents/[id]/assign/page.tsx`.
- **Inbox:** `inbox/inbox-view.tsx`, `documents/queries.ts` (Inbox select + handed over by).
- **Document page:** `documents/[id]/page.tsx`, `review-panel.tsx`, `document-controls.tsx`.
- **Client page:** `clients/[id]/documents-view.tsx` (pages per card), `document-row.tsx` (Edit, badge), `dispatch-dialog.tsx`.
- **Search and Today:** `documents/(search)/search-view.tsx` (20/page, Returnable filter, file buttons, Edit), `today/today-view.tsx` + `lib/today/shape.ts` (file buttons, returnable).
- **Clients:** `clients/clients-browser.tsx`, `lib/clients/queries.ts`, `lib/validation/client-search.ts` (My clients).
- **Libraries:**
  - `lib/validation/document.ts` (RECEIVED_AS, new fields), `lib/documents/state.ts` (returnable), `lib/documents/actions.ts`;
  - `lib/review/*` (kind), `lib/dispatch/*`;
  - `lib/search/queries.ts`, `lib/validation/document-search.ts`;
  - `lib/auth/permissions.ts` (row split), `lib/activity-feed/catalogue.ts`.
- **SQL:** a new migration replacing `create_document`, `update_document`, `document_before_write`, `review_document`, `undo_review`, `create_dispatch`, `search_documents`, `search_document_facets`, `today_items` and `search_clients`.

## Backward compatibility & data migration
- The migration is one transaction; on dev, then staging/prod replay from the file (schema fingerprint re-run).
- Legacy `original` input is accepted (AC-10). Old `/documents?as=original` links work (AC-13).
- Activity rows written before the migration keep their wording (sentences are built at display time; "dispatched N originals" stays readable).
- Rollback = a down-migration in the PR notes (returnable → `original`, drop the new columns). Not run unless needed.

## UX flows & screens
- **Type field:** closed → focus → grouped list → typing → pick → group line; no-match → close types → propose. Loading: types load with the client (03, as today; the field is disabled with "Loading types…"). Error: "Couldn't load types. Try again" + retry.
- **Received as:** segmented control (mockup) + checkbox + handed-over row (select + text). Validation messages are inline, as in 03.
- **Needs correction dialog:** two radio options + reason.
- **Clients:** a toggle chip "My clients" beside the existing filters, with the count.
- Every new element follows `ui-reference.md` tokens. New deviation rows: the type field's "Other types" section, the 8-row cap, the close-type suggestions, the Returnable checkbox (the mockup had an "Original" option), Handed over by, and My clients.

## Test strategy
| AC | Unit | RLS (db) | e2e |
|---|---|---|---|
| 1–7 | `type-match.test.ts` (normalise, aliases, groups, cap, close matches, ranking); form component test (keyboard, ARIA) | — | `document-type-field.spec.ts` (Add, Assign, Edit; propose; 390 px + axe) |
| 8–13 | `document-state.test.ts` (returnable) | `returnable.test.ts` (migration counts on a seeded office, legacy alias, checks, dispatch eligibility, lock, search filter, today count) | `client-documents.spec` / `review-dispatch.spec` (as changed below) |
| 14–16 | validation unit | `handed-over.test.ts` (required rules, can't clear, soft copy null, never in activity, link upload unaffected) | Add hard copy in `inbox.spec` |
| 17–18 | — | — | `inbox.spec` (View/Download), `search` + `today` file buttons |
| 19–23 | `review-actions.test.ts` (kind) | `review-dispatch.test.ts` additions (kind stored, any-field reset) | `review-dispatch.spec` (Wrong details → Edit → To review) |
| 24 | `permissions.test.ts` | `role-matrix.test.ts` (two rows, every cell probed) | — |
| 25–26 | — | — | `search` (20/page), `client-documents.spec` (pages) |
| 27–28 | `client-search` unit | `clients-list.test.ts` (`p_mine`, timing) | `clients.spec` (default on for Staff) |

**Existing tests that change (requirement changes, not weakening; each listed in plan.md for approval):**
- tests that pick or assert the **"Original"** option / `received_as = 'original'` in results:
  - e2e `client-documents`, `inbox`, `review-dispatch`, `today-documents`, screenshot specs;
  - RLS `documents`, `document-search` (facet values), `review-dispatch`, `today-documents`;
  - unit `document-state`, `dispatch-dialog`, `search-review`, `today-shape`, `today-view`, `document-rules`.

  They change to hard copy + returnable. Calls that only *create* an original keep working through the legacy alias and stay unedited.
- the **50 per page** expectation in `document-search.test.ts` stays (the SQL cap is unchanged). The UI's 20 is a new e2e test.
- the `undo_review_dispatch` matrix row splits in `permissions.test.ts` / `role-matrix.test.ts` (Staff: allowed for review, refused for dispatch).

**RUN_SLOW before merge:** yes (03's filing trigger and 07's rules change). Smoke-safe for prod: no new smoke tests.

## Proposed architecture changes (architecture lock + schema lock)
1. 07's "original" → **returnable hard copy** (received as = medium; returnable = return obligation). Enum value `original` retired by a check constraint, accepted only as an input alias.
2. Needs-correction reset widened to any user-field change; correction kind stored.
3. Undo review = Staff+ (was Admin/Manager); undo dispatch unchanged.
4. Handed over by on the document (PII snapshot rule, like 06's recipient).
5. `search_clients` gains `p_mine` (06's effective-assignee rule reused for the Clients list).
6. The decision log row of 2026-09-28 ("Original = must be returned") gets a superseding row.

## Risks & areas of concern
- **Wide change across 03/07/10's paths:** many functions replaced in one migration. Mitigation: replace by copying each latest definition and changing only the marked lines; diff each against its previous version in review; RUN_SLOW; schema fingerprint.
- **Test churn:** about 20 test files mention originals. Mitigation: the legacy alias keeps creation calls unedited; only assertions on the removed option change, each listed and approved.
- **K3:** `search_clients` is a known slow query. `p_mine` adds a narrowing `exists`, office-first; timed per AC-28.
- **Type field on large catalogues:** client-side filtering. Fine to [Likely] 1,000 types (benchmark in unit).
- **13 builds on this:** "Document in office" will sit between Reviewed and Ready to dispatch for every hard copy. 12 keeps Ready to dispatch derived (returnable + reviewed). 13 will turn it into a stored step.

## Out of scope
Document in office, reception form (13) · DSC (14) · Client › All documents, K4 (15) · staff access restriction · column chooser · AI suggestions · catalogue renames.
