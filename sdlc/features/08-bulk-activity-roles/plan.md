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
| src/lib/documents/actions.ts | mod | extract `getFileLink`'s RLS lookup into a shared helper used by both (no behaviour change) |
| src/lib/activity-feed/{catalogue,queries,actions,categories}.ts | new | sentences, load page, filters |
| src/lib/auth/permissions.ts | new | the matrix (one source) |
| src/components/selection-bar.tsx, zip-download.tsx, bulk-review-dialog.tsx | new | selection bar, zip progress dialog, confirm/progress/result |
| src/app/(app)/documents/(search)/search-view.tsx | mod | row checkboxes, select-all, bar |
| src/app/(app)/clients/[id]/documents-view.tsx, document-row.tsx | mod | checkboxes on received-document rows, bar |
| src/app/(app)/clients/[id]/page.tsx | mod | "Activity" link |
| src/app/(app)/documents/[id]/page.tsx, activity-card.tsx | mod / new | document Activity card |
| src/app/(app)/activity/{page,activity-view,filters,loading,error}.tsx | new | the Activity screen (mockup 04) |
| src/app/(app)/settings/users/page.tsx | mod | matrix from `permissions.ts` |
| src/components/app-header.tsx | mod | Activity nav item (**shared with 05**) |
| tests/rls/bulk.test.ts, activity-feed.test.ts, activity-visibility.test.ts, role-matrix.test.ts | new | step 2 (red first) |
| tests/unit/activity-catalogue.test.ts, permissions.test.ts, selection-bar.test.tsx, zip-download.test.tsx | new | |
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
- [ ] 0. Draft PR; CI green (docs only). (—)
- [ ] 1. **Spike:** fetch a signed download URL cross-origin from the preview (CORS); measure a 100 MB, 30-file zip in Chromium. Proof: a note in the session log; stop if blocked. (0.25)
- [ ] 2. **Tests first (red)** + **matrix audit**. Write `permissions.ts` from the spec. Probe each cell against the code by reading the functions and policies. Report any cell that differs **at a short gate with you (D4)** before writing UI. RLS tests: bulk links, bulk review, feed, visibility (each entity kind × role), role matrix. Proof: `test:db` fails for the right reasons. (1.5) [matrix decisions: 15 min]
- [ ] 3. **Migration**: written, dry-run, SQL gate, applied, advisors clean. Proof: step-2 DB tests green; **all earlier RLS suites green unedited**. (1) [SQL review: 30 min]
- [ ] 4. **Bulk on `/documents` + Client › Documents**: selection, zip, Mark reviewed (confirm → chunks → result). Proof: unit + e2e (download event, unzip, entries). (1.5)
- [ ] 5. **Activity screen**: feed, sentences, filters, Load earlier, sign-ins hidden, links. Proof: unit (catalogue coverage) + e2e. (1.5)
- [ ] 6. **Document Activity card + client link.** Proof: e2e. (0.25)
- [ ] 7. **Users page matrix** from `permissions.ts`; `role-matrix.test.ts` green for every cell. Proof: RLS + e2e. (0.5)
- [ ] 8. a11y (axe), ≤ 390 px, screenshots, ui-reference deviations, releases README checklist. Proof: e2e evidence. (0.5)
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
(none yet)

## Session log
### 2026-10-02
- Done: intent, spec approved (Raja). Plan drafted.
- Plan approved; batch E launched (Raja 2026-10-02 11:39 IST).
- Next step: step 0 (draft PR) in this feature's own session.
