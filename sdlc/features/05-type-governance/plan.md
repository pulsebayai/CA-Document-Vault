# Plan: Type governance
Spec: ./spec.md · Status: draft · Date: 2026-10-02
Holds (from approval): **schema lock** and **architecture lock** (batch E). 08 runs alongside with an additive-only exception plus its one `activity_select` replacement.
Base: `feat/05-type-governance` from main `6227385`. **05 merges before 08**; 08 then merges main in.

## Design choices made while planning (from reading the code)
- **Two migrations.** `ALTER TYPE doc_type_status ADD VALUE` (mapped, rejected) can't be used in the transaction that adds it (07's precedent). Migration A = enum values only; B = everything else.
- **03's trigger, smallest change.**
  - `document_before_write` (latest body: `20261001123125_review_and_dispatch.sql`) is copied **verbatim** with one addition: when `app.type_merge` = the old type's ID **and** only `doc_type_id` changed, skip (a) the archived guard and (b) 07's review reset.
  - Everything else, including the period-kind and offered checks against the target, still runs, so merges are validated by the same rules as staff edits.
  - The diff is reviewed line by line at the SQL gate.
- **Plan rows aren't moved** (immutable).
  - Merge: the proposed row → `removed` (as Admin/Manager; 02's trigger allows it). Then the target is inserted the way `add_client_doc_type` does (defaults, earliest open period), after creating or re-enabling the client group row the way `create_proposed_type` does.
  - **Approve with a group change** = create a new approved type in the new group, then merge the item into it (same code path). Approve without a group change updates the survivor in place.
- **Survivor and same-name rows:** approve updates the earliest row and merges the others into it inside the same function. Merge and reject loop over the item's rows.
- **Linking cost:** the set-based `update document set doc_type_id = …` fires 04's `document_after_link` per row. We measure 1,000 rows first (step 2). If > 2 s, defer linking with a set-based relink after the update (04's `app.expected_defer` pattern) as a planned fallback, not a surprise.
- **Notifications:** a definer `private.notify(recipients uuid[], kind, entity…)` called from the invoker decision functions. Table RLS = recipient-only select/update(read_at); no insert policy.
- **Metric 3:** a new read function `catalogue_metric()` (invoker, Admin/Manager), shown on Settings › Collection next to `collection_metric`.
- **Keep away from 08's files:** 05 doesn't touch `/documents`, `clients/[id]/*`, `documents/[id]/*`, `settings/users`, `src/lib/activity*`, `src/lib/auth/permissions.ts` or `activity`'s policies. Shared: `src/components/app-header.tsx` (05: bell; 08: Activity nav item) and `ui-reference.md` (deviation rows).

## Files that change
| Path | New/Mod | Why |
|---|---|---|
| supabase/migrations/<ts>_doc_type_status_decided.sql | new | A: `doc_type_status` += `mapped`, `rejected` |
| supabase/migrations/<ts>_type_governance.sql | new | B: `doc_type` decision columns + checks; `notification` (+ RLS, index); `notification_kind` enum; `proposal_queue`, `preview_type_decision`, `approve_proposed_type`, `merge_proposed_type`, `reject_proposed_type`, `mark_notifications_read`, `catalogue_metric`, `private.notify`, `private.merge_type_core`; `document_before_write` (+ `app.type_merge`); `reset_test_office` (+ notification purge) |
| src/lib/catalogue/governance.ts | new | server actions: queue, preview, approve, edit & approve, merge, reject (errors as code + request ID only) |
| src/lib/catalogue/queries.ts | mod | `loadProposedTypes` → `loadProposalQueue` (items, counts) |
| src/lib/catalogue/messages.ts | new | error → plain message map (ALREADY_DECIDED, PERIOD_KIND, HAS_DOCUMENTS, DUPLICATE_TYPE…) |
| src/lib/validation/catalogue.ts | mod | edit & approve input = 02's add-type schema + comment |
| src/lib/notifications/{actions,queries}.ts | new | list newest 20, unread count, mark read |
| src/app/(app)/settings/catalogue/catalogue-view.tsx | mod | ProposedPanel → decision queue (buttons, expandable client list) |
| src/app/(app)/settings/catalogue/proposal-dialogs.tsx | new | Approve / Edit & approve / Merge / Reject dialogs with preview |
| src/app/(app)/settings/collection/page.tsx | mod | metric 3 figure + queue age |
| src/components/notification-bell.tsx | new | bell button + panel (client) |
| src/components/app-header.tsx | mod | mount the bell (**shared with 08**) |
| src/app/(app)/layout.tsx | mod | unread count for the header (like `inboxCount`) |
| tests/rls/type-governance.test.ts | new | step 1 (red first) |
| tests/rls/type-governance-perf.test.ts | new | 1,000-document merge (RUN_SLOW) |
| tests/unit/proposal-queue.test.tsx, notification-bell.test.tsx, governance-messages.test.ts | new | |
| tests/e2e/type-governance.spec.ts | new | queue flows, bell, metric 3, axe, 390 px, screenshots |
| tests/support/catalogue.ts | mod | helpers: proposed type with N documents on M clients (**additions only**) |
| sdlc/product/references/ui-reference.md | mod | deviations: Edit & approve link-button; bell (no mockup) (**shared with 08**) |
| sdlc/product/architecture.md | mod | at step 9, under the architecture lock: type governance paragraph, `notification`, `app.type_merge`, decision log |

## Migrations (schema lock: 05)
1. **A** `<ts>_doc_type_status_decided`: two `ADD VALUE` statements, applied alone.
2. **B** `<ts>_type_governance`.
   - Dry-run on dev in a rolled-back block, as Admin, Manager, Staff and Limited (local un-suffixed fixtures only).
   - Then the **SQL gate** (you review, ~45 min), apply, md5 check, advisors.
   - No back-fill; existing proposed rows stay `proposed`.

## Steps (estimates = build sessions; your time in brackets)
- [ ] 0. Draft PR; CI green (docs only). (—)
- [ ] 1. **RLS/DB tests first (red).** Proof: `test:db` fails for the right reasons (1.5). Cases (spec test table):
  - grouping;
  - approve / edit & approve / group move / period fit / schedule → expected items for proposing clients only;
  - merge (documents incl. archived, DOC-ID/versions intact, plan rows, alias, retired row, linking, review/dispatch kept, no reset row, normal edit still resets);
  - period conflict = no change;
  - preview = effect;
  - reject guard;
  - roles;
  - decided twice;
  - concurrent filing;
  - comment on row only; activity rows with no free text;
  - notifications recipient-only;
  - metric 3;
  - suggestions via alias.
- [ ] 2. **Migrations A + B**: written, dry-run, **1,000-document merge timed in the dry run** (decides the linking fallback), SQL gate, applied, advisors clean. Proof: step-1 tests green in CI; **03, 03b, 04, 06, 07 RLS suites green unedited**. (2) [SQL review: 45 min]
- [ ] 3. Server actions + validation + messages. Proof: unit + RLS through the actions. (0.5)
- [ ] 4. **Catalogue queue UI** (panel, 4 dialogs, preview, stale handling). Proof: e2e + unit. (1.5)
- [ ] 5. **Bell** (header, panel, open = read, layout count). Proof: e2e + unit. (0.5)
- [ ] 6. **Settings › Collection**: metric 3 + queue age. Proof: e2e. (0.25)
- [ ] 7. a11y (axe), ≤ 390 px, screenshots, ui-reference deviations. Proof: e2e evidence. (0.5)
- [ ] 8. **RUN_SLOW** (05 changes 03's document trigger): Regression on the branch with `base_url` = the preview (full suite); record merge time and document save overhead. (0.5) [none]
- [ ] 9. architecture.md (3 items, under the lock), merge main → full suite → `verifier` → `sdlc-reviewer` → fix Important findings → PR with the AC → test → result table. (0.5) [PR review: 1 h]

**Total ≈ 8 build sessions.** Your review ≈ 2 h. **First cut if 05 slips:** metric 3's queue-age line (step 6). Second cut: the preview's "will count as received" line (keep the counts).

## Risks
| Risk | Likelihood | Mitigation | Rollback |
|---|---|---|---|
| The trigger edit breaks a 03/07 rule | medium | verbatim copy + one guarded block; diff checked at the SQL gate; all earlier RLS suites unedited | migration C restoring 07's function body (kept in the PR description) |
| Merge of 1,000 documents > 2 s (per-row linking) | medium | measured in step 2 before UI work | deferred set-based relink (04 pattern) |
| Group move re-enables a removed client group (Limited visibility) | low | group row takes the incharge as in 03; RLS test for a Limited assignee | — |
| Merge conflict in `app-header.tsx` / `ui-reference.md` with 08 | high, small | 05 merges first; 08 resolves | — |
| Enum ADD VALUE ordering on staging/prod | low | A before B; replayed in the R1 staging rehearsal | — |

## Proof of done
Every spec AC maps to a passing test (table in the PR). The full regression suite is green, plus RUN_SLOW on the preview. 03/04/07's behaviour is unchanged except AC-6's documented exception.

## Deviations from plan
(none yet)

## Session log
### 2026-10-02
- Done: intent, spec approved (Raja). Plan drafted.
- Next step: plan gate → batch E launch.
