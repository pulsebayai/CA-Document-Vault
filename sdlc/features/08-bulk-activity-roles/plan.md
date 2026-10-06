# Plan: Bulk actions, Activity and roles
Spec: ./spec.md · Status: approved (Raja 2026-10-02 11:39 IST) · Date: 2026-10-02
Holds: **no schema lock**. With approval: the **additive-only exception** (own new functions) plus the **scoped exception** to replace `activity_select` (intent Q3a, Raja 2026-10-02). Architecture lock: 05. 08's three architecture items go to architecture.md on main at merge.
Base: `feat/08-bulk-activity-roles` from main `6227385`. **05 merges first**; 08 then merges main in (step 9).

## Design choices made while planning (from reading the code)
- **Storage CORS spike first** (step 1). Single downloads navigate to the signed URL; the zip needs `fetch()`. If Supabase Storage refuses cross-origin fetch from our origin, stop and raise it before any zip work.
- **Links in batches:** `getFileLinks(versionIds ≤ 10)` repeats `getFileLink`'s RLS lookup per ID as the signed-in user, then signs through `storage.ts` (still the only signer). The browser asks for the next batch only when it's ready to fetch, so no link outlives 60 s unused.
- **Zip:** `client-zip` (`downloadZip` over an async generator of `fetch` responses, store-only). Collected to a Blob, saved via an object URL, URL revoked after. The cap is checked in the browser **and** in `getFileLinks` (count, and total size from the DB).
- **Bulk review:** `review_documents(p_ids uuid[])` (new, invoker). It loops `public.review_document(id, 'reviewed')` in a `begin … exception` block per ID and maps known error codes to skip reasons (ALREADY_REVIEWED, NOT_CLASSIFIED, ARCHIVED, NOT_FOUND, plus needs_correction checked before the call). No change to 07's function.
- **Activity visibility:**
  - `activity_select` is replaced with `office_id = current_office and (not has_role('limited') or actor_id = current_staff or private.can_see_client(private.activity_client(entity_type, entity_id, data)))`.
  - `private.activity_client` (definer, tenant-first, stable) resolves the client: `data.client_id`; else by `entity_type` (client · document · expected_doc · follow_up · dispatch · client_group · client_doc_type); else null.
  - The `not has_role('limited')` branch is evaluated first, so Staff+ never call the helper.
- **Feed:** `activity_feed(p jsonb)` (invoker) left-joins staff, client, document, doc_type and doc_group for display fields, applies the filters (staff, client via the same resolver, action category list, date range in IST, document) and keyset (`created_at`, `id`). Sign-ins are excluded unless category = sign-ins.
- **Sentences live in TS** (`src/lib/activity-feed/catalogue.ts`), keyed by action. The unit test greps `src/**` and `supabase/migrations/**` for action literals (`'x.y'` passed as `action`) and requires an entry for each.
- **Matrix as code:** `src/lib/auth/permissions.ts` exports rows `{ id, label, values: Record<Role, "yes"|"no"|"all"|"assigned"|string> }`. The Users page renders it; `tests/rls/role-matrix.test.ts` has a `probes` map keyed by row ID and fails on a missing probe.
- **Keep away from 05's files:** 08 doesn't touch `settings/catalogue/*`, `settings/collection/*`, `src/lib/catalogue/*`, `src/lib/notifications/*`, `doc_type` or 03's trigger. Shared: `app-header.tsx` (Activity nav item) and `ui-reference.md`.

## Files that change
| Path | New/Mod | Why |
|---|---|---|
| supabase/migrations/<ts>_bulk_activity.sql | new | `review_documents`, `activity_feed`, `private.activity_client`; **replace `activity_select`** (scoped exception) |
| package.json, package-lock.json | mod | + `client-zip` |
| src/lib/bulk/actions.ts | new | `getFileLinks`, `markReviewedBulk` |
| src/lib/bulk/links-core.ts | new | zip manifest + batch signing (reuses 03's `lookupVersion`; `documents/actions.ts` unchanged — Deviations) |
| src/lib/documents/queries.ts | mod | `getDocumentDetail` no longer reads activity (the card reads `activity_feed`) |
| src/components/action-dialog.tsx | new | a dialog opened by code (bulk flows) |
| src/lib/activity-feed/{catalogue,queries,actions,categories,filters}.ts | new | sentences, load page, URL filters |
| src/lib/auth/permissions.ts | new | the matrix (one source) |
| src/components/selection-bar.tsx, zip-download.tsx, bulk-review-dialog.tsx | new | selection bar, zip progress dialog, confirm/progress/result |
| src/app/(app)/documents/(search)/search-view.tsx | mod | row checkboxes, select-all, bar |
| src/app/(app)/clients/[id]/documents-view.tsx, document-row.tsx | mod | checkboxes on received-document rows, bar |
| src/app/(app)/clients/[id]/page.tsx | mod | "Activity" link |
| src/app/(app)/documents/[id]/page.tsx, activity-card.tsx | mod / new | document Activity card |
| src/app/(app)/clients/[id]/page.tsx | mod | "Activity" button (AC-10) |
| src/app/(app)/activity/{page,activity-view,loading,error}.tsx | new | the Activity screen (mockup 04); filters live in activity-view |
| src/app/(app)/settings/users/page.tsx | mod | matrix from `permissions.ts` |
| src/components/app-header.tsx | mod | Activity nav item (**shared with 05**) |
| tests/rls/bulk.test.ts, activity-feed.test.ts, activity-visibility.test.ts, role-matrix.test.ts | new | step 2 (red first) |
| tests/unit/activity-catalogue.test.ts, permissions.test.ts, selection-bar.test.tsx, zip-download.test.ts, activity-view.test.tsx | new | |
| tests/e2e/bulk.spec.ts, activity.spec.ts | new | |
| tests/e2e/users.spec.ts | mod | **additions only**: the matrix rows from `permissions.ts` (existing assertions untouched) |
| tests/support/* | mod | helpers **additions only** (fixture activity, many documents) |
| sdlc/releases/README.md | mod | R1 manual checklist: role-matrix steps per role |
| sdlc/product/references/ui-reference.md | mod | deviations: selection bar, document Activity card (**shared with 05**) |

## Migrations (no schema lock; exceptions as above)
One migration, `<ts>_bulk_activity`.
- Dry-run on dev in a rolled-back block, as each role (local un-suffixed fixtures).
- Then the **SQL gate** (you review, ~30 min), apply, md5 check, advisors.
- It changes no existing object except `activity_select`. The diff for that policy is shown at the gate.

## Steps (estimates = build sessions; your time in brackets)
- [x] 0. Draft PR; CI green (docs only). (—)
- [x] 1. **Spike:** fetch a signed download URL cross-origin from the preview (CORS); measure a 100 MB, 30-file zip in Chromium. Proof: a note in the session log; stop if blocked. (0.25)
- [x] 2. **Tests first (red)** + **matrix audit**. Write `permissions.ts` from the spec. Probe each cell against the code by reading the functions and policies. Report any cell that differs **at a short gate with you (D4)** before writing UI. RLS tests: bulk links, bulk review, feed, visibility (each entity kind × role), role matrix. Proof: `test:db` fails for the right reasons. (1.5) [matrix decisions: 15 min]
- [x] 3. **Migration**: written, dry-run, SQL gate, applied, advisors clean. Proof: step-2 DB tests green; **all earlier RLS suites green unedited**. (1) [SQL review: 30 min]
- [x] 4. **Bulk on `/documents` + Client › Documents**: selection, zip, Mark reviewed (confirm → chunks → result). Proof: unit + e2e (download event, unzip, entries). (1.5)
- [x] 5. **Activity screen**: feed, sentences, filters, Load earlier, sign-ins hidden, links. Proof: unit (catalogue coverage) + e2e. (1.5)
- [x] 6. **Document Activity card + client link.** Proof: e2e. (0.25)
- [x] 7. **Users page matrix** from `permissions.ts`; `role-matrix.test.ts` green for every cell. Proof: RLS + e2e. (0.5)
- [x] 8. a11y (axe), ≤ 390 px, screenshots, ui-reference deviations, releases README checklist. Proof: e2e evidence. (0.5)
- [ ] 9. **Merge main (05 shipped)** → add sentences for 05's 4 actions (the coverage test forces it), the matrix probe for 05's approve function, header conflict → full suite → `verifier` → `sdlc-reviewer` → PR with the AC → test → result table. (0.5) [PR review: 1 h]

**Total ≈ 7.5 build sessions.** Your review ≈ 2 h. **First cut if 08 slips:** the document Activity card (step 6). Second: bulk select on Client › Documents (keep `/documents`).

## Risks
| Risk | Likelihood | Mitigation | Rollback |
|---|---|---|---|
| Storage blocks cross-origin `fetch` | low–medium | step-1 spike before any zip code | raise at once; options: proxy-free per-file downloads, or drop zip from R1 |
| Policy rewrite hides rows from Staff+ or leaks to Limited | medium | role × entity-kind RLS tests reading the table directly | migration restoring the 01 policy (one statement, in the PR description) |
| Matrix cells differ from the code | medium | audit + gate in step 2 (D4) | — |
| Bulk review of 200 slow (07 function + triggers per row) | low | timed in step 3's dry run | smaller chunks (50) |
| Header conflict with 05 | high, small | 05 merges first; resolved in step 9 | — |

## Proof of done
Every spec AC maps to a passing test (table in the PR). The full regression suite is green. 07's single review, 03's file security and 01's user flows are unchanged (their suites unedited and green).

## Deviations from plan
- **D4 matrix rows (Raja 2026-10-02, step 2):** the audit found every spec cell matches the code. Two enforced rules had no row and were added: "Add, edit and import clients" (Yes · Yes · Yes · No) and "Add a financial year" (Yes · No · No · No). The current Users screen's "See and edit clients… Limited: Assigned" was wrong (Limited can't edit clients). "Waive · Reopen" is shown as two rows, so each cell has one meaning (same values).
- **Zip manifest step:** `zipManifest(documentIds ≤ 100)` lists the selection's current files and checks the 100-file / 300 MB cap on the whole selection. `signLinks(versionIds ≤ 10)` then signs batches. `getFileLinks` alone only sees 10 at a time, so it couldn't check the cap. Core in `src/lib/bulk/links-core.ts`, tested as each role, like 03's `storage-core`.
- **No change to `src/lib/documents/actions.ts`:** 03's `lookupVersion` (storage-core) already is the shared RLS lookup; `signLinks` reuses it.
- **`src/components/action-dialog.tsx` (new):** a dialog opened by code for the bulk flows (the shared `Modal` opens only from its own trigger). The zip cap is checked in the browser by count; size comes back from the server's manifest.
- **Document Activity card keeps 03/07's wording** for the document's own events ("uploaded a new version", "marked it reviewed"…). 03's e2e asserts it and tests aren't edited. Dispatch events use the catalogue's sentences. `getDocumentDetail` no longer reads activity itself; the card reads `activity_feed` (20 rows).
- **Migration applied through the Supabase dashboard SQL editor** (Raja, 2026-10-02 14:22 IST). The connector's write calls kept getting cancelled. So dev's migration history has **no row** for `20261002120000_bulk_activity`. Instead, the live function bodies were checked against the file (md5 equal for all three), along with the policy text, security modes and grants. When staging is created, the file applies normally. If dev's history must be complete, add the row later (owner's call).
- **No dry run:** Raja approved the SQL directly (12:57) after the dry-run call was cancelled.
- **Selection count is an `aria-live="polite" aria-atomic="true"` region, not `role="status"`** (spec NFR said role=status). Screen readers announce it the same way. CI 36987085679 showed an always-mounted second `status` on the client page breaks 02's `client-edit.spec.ts` (`getByRole('status')`, strict mode); the fix is in code, and 02's test is untouched.
- **Activity client filter is a text box + list of buttons**, not an ARIA combobox (spec AC-7 says "combobox"). Usable by keyboard (Tab) and screen readers; same pattern as 03b's `/documents` client picker. A full combobox is a later polish item.
- **Dispatch sentence** reads "Ravi dispatched 2 originals", not the spec example "Ravi dispatched Original Form 16": a packet row names several documents, and activity rows hold IDs only. The document card and `/activity?document=` show the packet against each document.
- **Activity follows a document's current client:** the client of a document's past events is the document's client now. If a document moves from client A to B, a Limited user on B sees its earlier events and one on A no longer does (IDs only; names stay behind RLS). This follows AC-11's wording; noted for architecture.md.
- **Accepted for the pilot (pre-PR review nits 4–5):**
  - A document marked Needs correction by someone else in the moment between `review_documents`' check and 07's `review_document` can still end up Reviewed (07 allows needs_correction → reviewed). The window is tiny; the review history shows both.
  - 200 sub-transactions per call is fine at office scale. Drop to 50 if RUN_SLOW or the volume test shows contention.
- **Activity module path:** `src/lib/activity-feed/` (not `src/lib/activity/`), because `src/lib/activity.ts` (01's `logActivity`) already exists.

## Session log
### 2026-10-02
- Done: intent, spec approved (Raja). Plan drafted.
- Plan approved; batch E launched (Raja 2026-10-02 11:39 IST).
- Next step: step 0 (draft PR) in this feature's own session.

### 2026-10-02 (build session 1)
- Done: step 0, draft PR #29. Step 1 spike: **not blocked.**
  - **CORS** (dev Storage, a real signed link, `Origin` = a vercel.app preview): GET → 200 with `access-control-allow-origin: *` (both view and `download=` links); OPTIONS preflight → 200, `*`, max-age 3600. A plain `fetch()` with no credentials needs nothing more. CSP `connect-src` already lists the Supabase origin.
  - **Zip** (`client-zip` 2.5.1, Chromium 1194 headless, 30 × 3.33 MB incompressible files = 100 MB, links consumed in batches of 10, served cross-origin from a local server): `downloadZip(...).blob()` took 1.07–1.21 s over 3 runs, JS heap 39–61 MB (the Blob lives outside the JS heap). The CPU and memory costs are small.
  - Not measured: real network time. At the 300 MB cap it is bandwidth-bound (≈ 2 min at 20 Mbit/s), so the progress dialog + Cancel matter more than zip speed. Links stay safe: each batch of 10 is requested when it is about to be fetched, and expiry is checked when a request starts.
  - Not done: a browser `fetch` from the real preview origin (previews aren't reachable from this session). The curl `Origin` check covers the same CORS rule for a credential-less GET; step 4's e2e (download event + unzip) proves it end to end.
- In progress: —
- Blocked / failing: —
- Next step: step 2, tests first (red) + matrix audit → short D4 gate with Raja on any matrix cell that differs from the code.
- Decisions made: none.

### 2026-10-02 (build session 1, cont.)
- Done: step 2 written (not yet run against dev). D4 gate held: two matrix rows added (Deviations).
  - `permissions.ts` (17 rows) + unit test green; catalogue/categories (49 actions, every scanned action covered) + unit test green; lint + typecheck clean.
  - RLS tests: `bulk`, `activity-feed`, `activity-visibility`, `role-matrix` (+ `tests/support/activity.ts`).
  - Step 3 drafted ahead: migration `20261002120000_bulk_activity.sql` (file only, **not applied, not dry-run**); `src/lib/bulk/links-core.ts`.
- **Hold (Raja 11:56 / 11:59):** ask before any CI run; **no CI or dev DB runs until 05's CI finishes** (Raja will say). Commits stay local (a push starts CI).
- Next step: when cleared, run the 4 new DB files (step-2 proof: red for the right reasons), dry-run the migration, then the SQL gate.

### 2026-10-02 (build session 1, step 4 — Raja 12:10: "05's CI still running; go ahead")
- Done (code, local checks only): step 4.
  - `client-zip` 2.5.1; server actions `src/lib/bulk/actions.ts`.
  - Components: `selection-bar`, `zip-download` (injectable `runZip`), `bulk-review-dialog`, `action-dialog`.
  - Wired into `/documents` and Client › Documents (received rows only). Stubs added in `tests/support/setup-dom.ts`.
  - New unit tests: `selection-bar.test.tsx` (9), `zip-download.test.ts` (5, real client-zip, unzips entries).
  - Unit suite 427/427, lint, typecheck and build green locally.
  - `tests/e2e/bulk.spec.ts` written, **not run**: it needs dev, so it runs in CI.
- Not yet: step-2 DB proof, migration dry-run + SQL gate, any e2e. All held until Raja clears CI/dev use.
- Next step: step 5 (Activity screen) code, or the DB steps when cleared.

### 2026-10-02 (build session 1, steps 5–8 — code only)
- Done (local checks only):
  - Step 5: `/activity` (page, view, loading, error), filters/queries/actions in `src/lib/activity-feed/`, and the "Activity" nav item.
  - Step 6: document Activity card + "See all in Activity"; client page "Activity" button.
  - Step 7: Users page matrix from `permissions.ts` (17 rows; scrolls inside its card on phones).
  - Step 8: `ui-reference.md` deviation rows; `sdlc/releases/README.md` role-matrix staging checklist.
  - New unit test `activity-view.test.tsx` (8). Unit 435/435, lint, typecheck and build green.
  - e2e written, **not run**: `activity.spec.ts` (3 tests), `users.spec.ts` (+1 test, addition only).
- Steps 4–8 stay unticked until their e2e passes in CI.
- Still held (Raja): step-2 DB proof → migration dry-run → SQL gate → apply; then push (starts CI); step 9 after 05 merges.

### 2026-10-02 (build session 1, steps 2–3 — Raja: "05's CI completed, continue" 12:33; "I approve the sql" 12:57)
- Step 2 proof: the 4 new DB files were red only for the right reasons: 17 failures (`review_documents` / `activity_feed` missing; Limited reading every activity row). The other 75 passed, including 67 of 68 matrix cells against today's code. Four fixture bugs in my own new tests were fixed first (dispatch date, a future received-on, test-clock order); they are fixture mistakes, not weakened assertions.
- Step 3: 05 had applied 4 migrations to dev by then (`20261002073810` … `082118`); none touch `activity_select`, `activity`, `review_document` or the access helpers, and no names clash.
  - Applied via the dashboard (see Deviations); live objects verified against the file.
  - Advisors: nothing new (the `run_expected_generation` WARN is 04's known item).
  - The 4 files are now green: **99 passed, 2 skipped** (the RUN_SLOW speed tests).
- Commits backed up to `backup/08-bulk-activity-wip` (no CI on non-PR branches).
- Next: Raja's OK to push to PR #29 → CI runs the full suite: earlier RLS suites unedited, plus the new e2e for steps 4–8. Then step 9 after 05 merges.

### 2026-10-02 (CI 36987085679 on 78061a3 — Raja: "yes push" 14:28)
- Green: lint, typecheck, unit, build; the **full RLS suite** (every earlier suite unedited, under the new `activity_select`); all of 08's new e2e. 86 e2e passed.
- Failed (2):
  1. `client-edit.spec.ts:74`: two `role=status` on the client page. **Caused by 08**, fixed in code (see Deviations).
  2. `client-plan.spec.ts:45`: GST region still visible after disabling, on 30 s timeouts. **Not caused by 08 [likely]:** 05's run 36986531535 (no 08 code) marked the same test *flaky*, and here it overlapped 05's CI on the shared dev DB. To watch on the re-run.

### 2026-10-02 (CI 36993204343 on 628256a — **green**; Raja: "we will push" 15:31)
- All jobs green: lint, typecheck, unit, build; full RLS suite; full e2e, including all of 08's new e2e and both 02 tests that failed on 78061a3. Steps 4–8 ticked.
- 05's CI 36990723961 is also green.
- Next: step 9 after 05 merges (merge main → sentences for 05's activity actions → matrix probe for 05's approval → header conflict → full suite → verifier → sdlc-reviewer → AC table → ready for review).

### 2026-10-06 (step 9 — 05 merged as PR #28; Raja: "don't run any CI or regression", another CI is running)
- Done (local only; no CI, no Regression, no dev-DB test runs):
  - Merged origin/main (`d8dcfad`). Conflicts in three shared files, each resolved keeping both sides:
    - `app-header.tsx`: 05's bell count + 08's Activity item;
    - `setup-dom.ts`: both stubs;
    - `ui-reference.md`: 05's rows, then 08's.
  - 05's 7 migrations touch nothing 08 relies on (`activity_select`, `review_document`, the access helpers); no name clashes.
  - The catalogue test caught 4 new 05 actions (`doc_type.approved` / `merged` / `rejected`, `document.type_merged`). Sentences added.
  - The role-matrix "Manage catalogue, approve proposed types" probe now also calls 05's `approve_proposed_type`.
  - `sdlc-reviewer`: **no Important findings in 08's code**; its one Important item is the missing CI run on the merged head.
    - Nits fixed: impossible URL dates broke the feed; repeated Esc could close a busy dialog; no "Try again" on the zip cap; "Retry failed" says it saves a second zip; this plan's file table.
    - Others recorded in Deviations / below.
  - Unit (all, incl. 05's), lint, typecheck and build green.
- Pending before merge:
  1. Local run of the changed DB test (`role-matrix.test.ts`, per CLAUDE.md 2026-10-06).
  2. Push → full CI green on the merged head.
  3. AC → test → result table in PR #29; ready for review.
  4. Raja reviews + merges.
- At merge (on main): the spec's 3 architecture items, plus the "activity follows the document's current client" note. Add `/activity?client=`, the document Activity card and Limited's first page to the pre-pilot volume test (review nit 3). Dev's migration history has no row for `20261002120000` (applied via the dashboard).
- Decisions made: none new.
