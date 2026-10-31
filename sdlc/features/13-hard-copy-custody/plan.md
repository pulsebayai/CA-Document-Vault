# Plan: Hard-copy custody — "Document in office" and Log receipt
Spec: ./spec.md (approved 2026-10-31, S1–S5 as recommended) · Status: **approved (Sidambara, 2026-10-31 ≈ 14:00 IST; P1, P2 and the test list as proposed)** · Date: 2026-10-31
Branch: `feat/13-hard-copy-custody` · Locks: **schema + architecture → 13** (from step 0, subject to the 13 ∥ 14 checkpoint) · RUN_SLOW: owner's deferral (full RUN_SLOW Regression after 13–16, before staging)

## Two refinements found while planning (approved 2026-10-31 with the plan)
**P1. Keep 07's "Held N days" untouched; "In office N days" is a separate badge shown only past 30 days.** Showing both counts on every returnable row would put two different day numbers side by side. Rows keep 07's "Held N days" (from received on). The bad-tone badge "In office N days" appears only when AC-10 applies (> 30). The document page's Custody panel shows "in office since <date>" always.

**P2. Tests that expect *derived* Ready get one new shared helper, not a changed old one.** `mustCreateOriginal(as, doc, reviewer)` is used in 9 test files. Making it also mark Ready would quietly change what those tests set up. Instead, add a new helper `mustMarkReady(as, id)` (in office, then ready) to `tests/support/documents.ts` and call it in the setups listed below. Tests that only dispatch stay unedited (S2).

## Files that change
**Migrations (new):**
- `…_custody_a.sql`:
  - enum `custody_step`; `document.custody`, `in_office_at/by`, `ready_at/by`; the checks;
  - table `document_custody` (append-only; RLS select like `document_review`, insert only under `app.doc_custody`), FK to `document`;
  - `document_before_write`: custody columns only under `app.doc_custody`; S5 refusals (`CUSTODY_SOFT_COPY`, `CUSTODY_READY`);
  - data step (AC-17), 12's pattern for archived rows; counts raised as a notice;
  - `reset_test_office` (also purges `document_custody`).
- `…_custody_b.sql`:
  - `set_custody(p_ids uuid[], p_step text)` (≤ 200, sub-transaction per ID, skip reasons), `undo_custody(p_id)`;
  - `create_dispatch` (eligibility + implied steps, S2), `undo_dispatch_item` (document stays Ready);
  - `search_documents` / `search_document_facets` (`return_state` from custody: `to_place | in_office | ready | dispatched`; `held` filter; `custody`, `in_office_at` per row);
  - `today_items` (`to_place`, `held`; `ready` from custody);
  - `log_receipt(p jsonb)`, `custody_metric(from, to)`.

Each replaced function is copied from its latest definition (12's migrations B/C/D) and only the marked lines change; each is diffed against its previous version in review.

**Lib:**
- `src/lib/documents/state.ts`: `custody`, `inOfficeAt` inputs; states `in_office`; `isReadyToDispatch` from stored custody; `nextAction` → `in_office | ready`; `inOfficeDays`.
- new `src/lib/custody/` (`actions.ts`: mark, bulk, undo; `messages.ts`).
- `src/lib/receipt/` (`actions.ts`, validation), reusing `validation/document.ts` (handed over by, received on).
- `src/lib/validation/document-search.ts` + `lib/search/*` (Custody filter, held, old `return=` values).
- `src/lib/today/*` (shape + params: `to_place`, `held`).
- `src/lib/bulk/actions.ts` (`markCustodyBulk`), `src/lib/dispatch/actions.ts` (`readyOriginals` = custody ready).
- `src/lib/auth/permissions.ts` (2 rows), `src/lib/activity-feed/catalogue.ts` (3 sentences), Settings › Collection query.

**Screens:**
- document page: new `custody-panel.tsx`;
- `clients/[id]/document-row.tsx` (next-step button, badge), `documents-view.tsx` (bulk), `dispatch-dialog.tsx` (copy only);
- `documents/(search)/search-view.tsx` (Custody filter, held checkbox, bulk, row action);
- `today/today-view.tsx` (two counts + rows);
- new `documents/receipt/` (page, form, confirmation); links from `inbox-view.tsx`, Today, Add document;
- Settings › Collection (custody figures).

**Docs:** architecture.md (5 items + a decision row superseding 07's derived Ready), ui-reference.md deviation rows.

## New tests (failing first)
- RLS: `custody.test.ts`, `custody-today.test.ts`, `log-receipt.test.ts`, `custody-migration.test.ts`, `custody-metric.test.ts`; `role-matrix.test.ts` + `permissions.test.ts` (2 new rows, additive).
- unit: state cases in a new `custody-state.test.ts`; `receipt-form.test.tsx`; custody panel.
- e2e: `custody.spec.ts`, `log-receipt.spec.ts`.

## Existing tests that change (requirement change: Ready is stored; list approved 2026-10-31)
| File | Lines (now) | Change |
|---|---|---|
| unit `document-state.test.ts` | 36–38, 66–73 | inputs add `custody: "ready"` where they expect Ready; one added case: reviewed returnable without custody → not Ready |
| unit `document-state.test.ts` | 135–148 | the Return options become To place · In office · Ready to dispatch · Dispatched (`return=ready` keeps its query string) |
| unit `search-review.test.tsx` | 37–64 | the "Return" select is named "Custody" and lists four values |
| unit `today-view.test.tsx` | 19, 66–69 | `counts` objects add `toPlace`, `held` (type change only) |
| RLS `review-dispatch.test.ts` | 480–482 (setup) | `mustMarkReady` for `ready` and `readyFix`; assertions at 496–533 unchanged |
| RLS `today-documents.test.ts` | ≈ 56 (setup) | `mustMarkReady` for `d.ready`, `d.fixCopy`; the counts at 78/107/129 unchanged |
| RLS `returnable.test.ts` | ≈ 120 (setup) | `mustMarkReady` for `ready`; assertions unchanged |
| e2e `review-dispatch.spec.ts` | beforeAll; 172 | `mustMarkReady` after the reviews, and after the re-review at 172 |
| e2e `today-documents.spec.ts` | beforeAll | `mustMarkReady` for the reviewed original |

| RLS `review-dispatch.test.ts` | ≈ 461, 529 | row type + the TS-state input add `custody` (approved 2026-10-31, step 1) |
| e2e `review-dispatch.spec.ts` | 182 | the filter is selected by the name "Custody" (approved 2026-10-31, step 1) |
| unit `search-review.test.tsx` | 23 (fixture), 77 | `hit()` carries `custody: "ready"` (within the approved 37–64 change); chip label "Custody: Dispatched" (approved 2026-10-31, step 1) |

[Likely] a few more show up when step 1's failing tests run against the full suite; each is added here and asked before it is changed. `today-view.test.tsx` needs no change: the two new counts are optional in its type. Tests that create or dispatch documents without asserting Ready stay unedited (S2).

## Steps
- [x] 0. **Setup + checkpoint.** (roadmap PR #15 merged 2026-10-31) Commit this plan; 13 ∥ 14 parallel planning checkpoint (14 needs its intent → spec → plan first; locks and overlap decided there); roadmap PR on main: 13 in progress, locks. — proof: roadmap PR merged (docs-only CI)
- [x] 1. **Failing tests first (RLS + unit)** (2026-10-31: 25 RLS + 11 unit fail for the expected reason — missing functions/columns) for AC-1–12, 13–15, 17–19, plus the table above. — proof: they fail for the expected reason on dev
- [ ] 2. **Migration A** (schema, history table, trigger, data step, purge). — proof: `custody-migration` passes on dev; documents / review-dispatch / returnable / correction-kind / link files pass unedited except the approved setups; md5 = file
- [ ] 3. **Migration B** (functions). — proof: every step-1 RLS file passes; role-matrix, document-search, today-documents, upload-links-today green; md5 = file
- [ ] 4. **Lib layer** (state, custody actions, search/today parsing, permissions, activity sentences). — proof: unit suite green
- [ ] 5. **Document page Custody panel + row actions + dispatch dialog.** — proof: e2e `custody.spec` (page part) locally; axe
- [ ] 6. **Bulk on `/documents` and Client › Documents; Custody filter + held.** — proof: e2e `custody.spec` (bulk + filter) locally
- [ ] 7. **Today: To place in office, In office > 30 days.** — proof: `custody-today` RLS; unit today-view; e2e `today-documents` locally
- [ ] 8. **Log receipt** (page, form, confirmation, links). — proof: `log-receipt` RLS; e2e `log-receipt.spec` locally (390 px, axe)
- [ ] 9. **Metric** on Settings › Collection. — proof: `custody-metric` RLS
- [ ] 10. **Docs:** architecture.md, ui-reference.md, Settings › Users rows. — proof: review
- [ ] 11. **Full verification:** lint, typecheck, unit, full RLS on dev, new/changed e2e locally; push → PR CI (asked first); dispatch Regression `only` = the new RLS files (migration rule; asked first); `sdlc-reviewer`; fix Important findings failing-first → PR with the AC table. — proof: CI green + AC table

## Risks
- **Function copies drift** (six replaced functions, one with 12's changes only a day old). Mitigation: copy from the latest file, mark changed lines, diff in review, schema fingerprint.
- **`today_items` (K3)**: two more document sets. Mitigation: the same CTE as To review / Ready, office-first; dev timing before/after recorded.
- **Migration on archived rows**: 12's pattern (trigger off for one statement, constraints immediate).
- **14 in parallel**: overlap in `permissions.ts`, `role-matrix.test.ts`, the activity catalogue and maybe `today_items`; merge order decided at the checkpoint.

## Proof of done
All ACs mapped to passing tests in the PR table; PR CI green; RLS quick check on dev green; migrations on dev with md5 = file; roadmap/architecture updated at merge.

## Estimate
[Uncertain] 3–5 working days (2 build sessions + review). Most of the risk is in the two `today_items` / search replacements and Log receipt's form.

## Deviations from plan
- **Today rows for To place / In office > 30 days come only when their count is clicked** (Sidambara 2026-10-31, step 1; like 10's "requested later"). Spec AC-11 said "open rows per client card like Ready to dispatch"; the default list stays To review + Ready to dispatch, so `today-documents.test.ts`'s "nothing to do" row stays unedited.
- **Migration data step is a function** `public.custody_backfill(p_office)` (service role only, idempotent), so `custody-migration.test.ts` can run it on its own test office; migration A calls it for every office.

## Session log
### 2026-10-31
- Intent approved (Q1–Q6), spec approved (S1–S5), plan approved (P1, P2, test list). Sequencing: plan 14 now (intent → spec → plan), then the 13 ∥ 14 checkpoint, then build.
