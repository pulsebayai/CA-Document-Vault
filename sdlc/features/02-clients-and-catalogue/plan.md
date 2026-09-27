# Plan: Clients and document catalogue
Spec: ./spec.md · Seed: ./seed-catalogue.md · Status: approved (2026-09-26, Raja; D1 + D2 approved) · Date: 2026-09-26
Holds: **schema lock** (roadmap) + **architecture lock** for spec's 5 approved changes (applied to architecture.md at merge).

## Files that change
| Path | New/Mod | Why |
|---|---|---|
| supabase/migrations/<ts>_clients_catalogue.sql | new | enums, 10 tables, counter, helpers, RLS, triggers, indexes, SQL functions (below) |
| supabase/migrations/<ts>_seed_catalogue.sql | new | `private.seed_catalogue(office_id)` + run for the existing office; FY 2025-26/2026-27 periods |
| src/lib/validation/{identifiers,client,catalogue,csv}.ts | new | shared zod schemas: PAN / GSTIN / TAN / mobile / PAN-letter↔type; form + CSV use the same rules |
| src/lib/validation/gst-states.ts | new | 37 GST state codes (static map) |
| src/lib/clients/{queries,actions}.ts | new | list/search, create/update/archive/unarchive, import |
| src/lib/catalogue/{queries,actions}.ts | new | groups/types/FY upserts, add next FY |
| src/lib/plan/actions.ts | new | enable/disable group, update group/type, add type |
| src/lib/csv/parse.ts | new | Papa Parse wrapper + row validation → preview model (browser), same validator re-run on server |
| src/app/(app)/clients/page.tsx | mod | empty state → list, search, filters, pagination |
| src/app/(app)/clients/clients-view.tsx | new | presentational list + empty state (props in, no data fetching) |
| src/app/(app)/clients/new/page.tsx, client-form.tsx | new | Add client (also used for Edit) |
| src/app/(app)/clients/[id]/page.tsx, settings/*.tsx | new | client header, card, tabs, collection plan (mockup 11) |
| src/app/(app)/clients/import/*.tsx | new | upload → preview → result |
| src/app/(app)/settings/layout.tsx, settings/catalogue/*.tsx | new | Settings sub-nav (Users: admin; Catalogue: everyone, read-only below Manager) |
| src/components/app-header.tsx | mod | "Settings" visible to all staff (catalogue is readable by all, AC-6) |
| src/components/ui.tsx | mod | Switch, Tabs, Table, Dialog primitives if not present |
| src/lib/activity.ts | mod | typed action names for 02; PII-key guard (throws in tests if data has pan/email/mobile/gstin keys or values) |
| tests/rls/clients-catalogue.test.ts, tests/rls/plan.test.ts, tests/rls/import.test.ts | new | DB/RLS tests (written first) |
| tests/unit/{identifiers,csv,client-schema,clients-view}.test.ts(x) | new | validators, CSV rules, list view |
| tests/e2e/{catalogue,clients,import,client-plan}.spec.ts | new | e2e per spec test strategy + axe on new screens |
| tests/support/{db,test-data}.ts | mod | catalogue/client fixtures, synthetic PAN generator, `purgeTestClients()` |
| tests/fixtures/clients-*.csv | new | synthetic CSVs (valid, errors, duplicates, 1,000 rows generated at run time) |
| .github/workflows/regression.yml | mod | `RUN_SLOW=1` so the 1,000-row import test runs nightly only |
| package.json, package-lock.json | mod | `papaparse` (+ types) |

## Migrations (schema lock: 02)
1. `<ts>_clients_catalogue.sql` — enums `client_type, frequency, period_kind, plan_state, registration_kind, doc_source`; `office.client_code_counter`, `office.is_test`; tables per spec; `pg_trgm` indexes (client.name, previous_reference); FK indexes; RLS default-deny + policies; `private.can_see_client()`; column grants for incharge/archive/pause columns + guard trigger; `forbid_delete` trigger on all new tables.
   SQL functions (security invoker unless noted — RLS still applies):
   - `private.next_client_code(office_id)` (security definer, row lock on office) → `C0001…`
   - `public.enable_client_group(client, group)` / `disable_client_group(...)` — copy/restore in one transaction (AC-19/21)
   - `public.import_clients(rows jsonb)` — ≤200 rows per call, one transaction, re-validates PAN/GSTIN rules in SQL checks (AC-16)
   - `private.add_financial_year(office)` — FY + 12 months + 4 quarters + 1 year (AC-5)
   - `private.purge_test_office_data(office_id)` — **service role only, refuses unless `office.is_test`**; sets a transaction flag the `forbid_delete` trigger honours. Needed because clients can't be deleted, but CI would otherwise add ~1,000+ clients to dev every night.
2. `<ts>_seed_catalogue.sql` — `private.seed_catalogue(office_id)` from seed-catalogue.md (46 client documents + 9 firm records, 10 groups, none enabled for new clients); applied to the existing office.
Applied to **dev only** (project ysddbwskljzhbjjohool) via `apply_migration` after RLS tests are written; staging/prod get them at release.

## Steps (estimates = build sessions with Claude; your review time in brackets)
- [x] 0. Wait for evidence-fix PR merge → rebase on main → full suite green — proof: CI run with Unit + RLS + E2E rows [5 min]
- [x] 1. **Retarget the one skeleton test** (decision D1 below) — `clients-page.test.tsx` renders the new `ClientsView` with 0 clients; same assertions (heading, "0 clients") + empty-state text — proof: fails on current code (component missing), passes after step 7 [approve D1]
- [x] 2. RLS/DB tests first (red): tenant isolation on all 10 tables; staff/limited catalogue writes denied (AC-6); incharge/archive Admin/Manager only (AC-10/11); DELETE rejected; limited sees only assigned (AC-12); PAN partial-unique; firm-source check (AC-1); code sequence no gaps/reuse; activity has no PII values (AC-23) — proof: `npm run test:db` fails for the right reasons (1 session)
- [x] 3. Migration 1 written, reviewed, applied to dev; Supabase security + performance advisors clean — proof: step-2 tests green except seed/plan/import ones (1 session) [review SQL: 30 min]
- [x] 4. Migration 2 (seed + FY/periods) + `add_financial_year` — proof: DB tests AC-1, AC-5 (2 × 17 periods, duplicate FY rejected) (0.5)
- [x] 5. Shared validators + GST states — proof: unit tests for every AC-9 rule incl. warn-only letters (G/L/J, society/co-op) (0.5)
- [x] 6. Catalogue screen + actions + Settings sub-nav + nav change — proof: e2e admin edits a type; staff sees read-only; AC-4 DB test (master edit leaves client copies unchanged) (1)
- [x] 7. Clients list: search (name/code/PAN/GSTIN/prev ref), filters, archived toggle, 50/page; **no query text in URL** (state in form + POST/server action) — proof: e2e AC-7 asserts `page.url()` never contains search text; step-1 test green; 1,000-client list < 1 s server time (DB timing test) (1)
- [x] 8. Add / edit / archive / unarchive client (+ registrations, groups at create, code) — proof: e2e add client; DB AC-10/11 green; activity rows (1)
- [x] 9. Client › Settings: header, card, tabs, groups & types, enable/disable/pause/remove/restore, "+ Add type" — proof: DB AC-19/20/21 (no duplicates on re-enable, firm records never copied); e2e enable group (1.5)
- [x] 10. CSV import: template, browser preview, server re-validation, chunked `import_clients`, result + error-row download — proof: unit CSV tests (header, limits, in-file + DB duplicates, name warnings); e2e happy path + error file round-trip; AC-17 1,000 rows < 60 s nightly (`RUN_SLOW=1`) (1.5)
- [ ] 11. Accessibility (axe on 5 new screens) + empty/loading/error states + screenshots vs mockups 03/05/11 — proof: 0 serious/critical; screenshots in PR (0.5)
- [ ] 12. AC-22 timed manual check with a staff member (≤ 2 min) — proof: time recorded in PR [you: 10 min]
- [ ] 13. `verifier` full suite → `sdlc-reviewer` → fix Important → PR with AC → test → result table — proof: CI green, evidence shows all three suites [PR review: 1–2 h]
**Total ≈ 10 build sessions ≈ 4–5 working days elapsed; your review ≈ 4–5 h.** Calibration: 01 (13 steps) went intent → shipped in ~1 day, but 02 has ~4× the surface (10 tables, 5 screens, import). [Likely] No scope deferral needed; if step 10 slips past 1.5 sessions, error-row download is the first cut.

## Risks
| Risk | Mitigation |
|---|---|
| RLS recursion / perf: `can_see_client` reads client_group which is itself client-scoped | helper is `security definer` + `stable`, reads base tables directly; indexed on (client_id, assigned_staff_id); explain-analyze on 1,000 clients |
| Limited role leaks via SQL functions | functions are security invoker (RLS applies); definer only for code counter + purge; DB tests call each function as limited |
| Import partial failure | 200-row chunks each atomic; result shows which chunk failed; re-upload is idempotent via PAN duplicate rule |
| Migration mistake on shared dev DB | additive only; tests written first; advisors checked; rollback = compensating migration (no real data) |
| Test data growth in dev (no-delete rule) | `purge_test_office_data` limited to `is_test` offices, service role only; DB test proves it refuses a non-test office |
| PII in logs / activity / URL | activity PII guard; e2e URL assertion; server errors for import rows returned only to the uploader, never logged with values |
| Concurrency: nightly + PR runs share dev | existing CI concurrency group; 1,000-row test nightly only |
Rollback: dev only → revert PR + compensating migration.

## Proof of done
AC-1…23 → test file → result table in the PR; CI green with Unit + RLS + E2E evidence rows; screenshots vs mockups 03/05/11; AC-22 time recorded; architecture.md updated at merge with the 5 approved changes + `doc_type.source`.

## Decisions for the plan gate
- **D1 (test rule):** `tests/unit/clients-page.test.tsx` renders the page component synchronously; once the page fetches data it can't render in a unit test. Proposal: point the test at the new presentational `ClientsView` with the **same assertions plus** the empty-state text — not weaker, and the behaviour it guards (0 clients → heading + "0 clients") is unchanged. Needs your explicit OK because the rule is "never edit a test".
- **D2 (test data):** add `office.is_test` + service-role-only purge for test offices (above). Alternative: never purge, and accept dev growth (~1,000 rows/night from AC-17).

## Deviations from plan
- Step 5 done before steps 2–4 (2026-09-26): pure code, fully verifiable in the local VM; DB steps need CI. No dependency on the schema.
- GST state list = 01–38 + 97 (spec said "37 codes"; Ladakh 38 and legacy 25/28 included so older GSTINs validate). GSTIN 14th char not forced to "Z" (TDS/NRI registrations use other letters); GSTIN check-character is **not** verified (not in spec) — candidate for later if typos show up in the pilot.
- PAN letter rules: AOP/BOI accept A or B (BOI PANs use B); G/L/J always warn-only.
- Step 0: base proof = Regression #3 on main 581c64d (Unit 15, RLS 10, E2E 14, one table); 02 rebased onto it 2026-09-26.
- Step 1: minimal `ClientsView` added now (not in step 7) so the retargeted test goes red → green in one step; page renders it with 0 clients until step 7. Empty-state hint text changed from "Clients are added in the next release" to "Add a client or import a CSV to get started." (no test asserted the old text).

- Step 2 (2026-09-27) — tests fix these interface choices for step 3 (S1–S3 approved by Raja 2026-09-27):
  - Counts corrected: seed = **47** client documents (plan said 46) + 9 firm records; new tables = **9** (plan said 10).
  - Service-role test helper is `public.reset_test_office(office_id)` (not `private.purge_test_office_data`): PostgREST can't call functions in `private`, so it lives in `public` with EXECUTE revoked from anon/authenticated. It purges client data, restores catalogue + FYs to the seed and resets the code counter; refuses unless `office.is_test`. Existing "e2e office %" rows are flagged `is_test` in migration 1.
  - `public.add_financial_year()` (not `private.`) so the Admin screen can call it; security invoker, RLS = Admin only.
  - New `public.add_client_doc_type(client, doc_type)` for "+ Add type" (copies master defaults; refuses firm records / inactive types).
  - SQL functions (enable/disable group, import, add FY) write their `activity` rows in the same transaction.
  - **S1** DB-level `ACTIVITY_PII` guard trigger on `activity` (rejects PII keys or PAN/GSTIN/email/mobile-shaped values anywhere in `data`) — additive trigger on a 01 table; stronger than the TS-only guard in the plan.
  - **S2** Assigning staff (group or type) is Admin/Manager only, like incharge — assignment decides what Limited users can see. Spec AC-20 is ambiguous here.
  - **S3** Re-enabling a group restores each type's pre-disable state (removed stays removed, paused stays paused); needs a `state_before_disable` column.
  - `client.code` has no INSERT/UPDATE grant — never client-supplied; counter increments inside the insert transaction, so a failed insert leaves no gap.

- Steps 3–4 (2026-09-27): both migrations written together, dry-run on dev inside a rolled-back block, reviewed and approved by Raja, applied to dev as `20260927070322_clients_catalogue` + `20260927070427_seed_catalogue`. `reset_test_office` lives in migration 2 (it needs the seed). Security advisor: no new findings; performance: only "unused index" INFO (empty tables). Interpretations accepted at review: archived clients can't enable groups; FY always starts in April (`office.fy_start_month` ignored). **Proof: CI run 36302710875 (c21f580, PR #4) — Unit 67 · RLS 54 passed / 0 failed / 1 skipped (AC-17, nightly only) · E2E 14.**

- CI run 36302068412 (b3c052e): DB suite 53 passed · 1 failed · 1 skipped (AC-17 nightly). Failure = `clients-catalogue › tenant isolation › cannot write into another office`: rejected by `INCHARGE`, not the tenant boundary — the SECURITY DEFINER client trigger locked/incremented the *other* office's code counter before RLS denied the row. Code fix (test unchanged): migration `20260927071425_client_trigger_tenant_first` checks office first (`OFFICE_DENIED`); verified on dev by impersonation (counter untouched). E2E did not run in that job (stops at first failing step), hence "Evidence incomplete".

- Step 6 (2026-09-27):
  - **New migration `20260927073233_doc_type_usage`** (not in the plan's list): security-invoker view `public.doc_type_usage` for "Used by N clients" (spec UX). PostgREST aggregates are off and fetching every plan row would not scale (~50k rows at 1,000 clients). Counts active plan rows on non-archived clients; RLS applies, so Limited users count only their clients. Dry-run in a rolled-back block, then applied to dev; security advisor shows no new findings. DB test `tests/rls/catalogue-usage.test.ts`.
  - **D3 (approved by Raja 2026-09-27):** `tests/e2e/users.spec.ts` AC-10 retargeted from "non-admins see no Settings link" to "non-admins see no Users and roles link in the Settings sub-nav". /settings/users still 404s with no staff data; Settings is now for everyone (02 AC-6).
  - `settings/users/page.tsx` modified (not listed): its h1 became an h2 under the shared Settings layout; no behaviour change.
  - Mockup 05 shows an inline frequency dropdown per row; built as text + schedule summary, edited in the type dialog, because frequency and the ask/overdue offsets must change together (DB check: offsets set ⇔ scheduled). Reminders stay an inline switch as in the mockup.
  - Frequency can't be more often than the type's period (month → any; quarter → quarterly/yearly; year → yearly; none → as needed). UI/validator rule only — the DB does not enforce it. [Likely] fine for 04, which generates per frequency.
  - Group reorder = ↑/↓ buttons (swap `sort`); group/type "delete" = deactivate. Internal codes are generated (slug + random suffix), never shown.

- Step 7 (2026-09-27):
  - **New migration `20260927080310_search_clients`** (not in the plan's list): `public.search_clients(query, type, incharge, include_archived, limit, offset)`, SECURITY INVOKER (RLS decides visibility → AC-12 holds), returns list rows + enabled/paused group names + a window total. Chosen over PostgREST `.or(ilike…)` filters so user text is never spliced into a filter string, LIKE wildcards are escaped, and the GSTIN match (child table) is one query. PAN/GSTIN match uses identifier characters only (spaces/case ignored). Dry-run as `authenticated`, applied to dev; advisors: no new findings. DB tests `tests/rls/clients-list.test.ts` were written with the function but could only run in CI after it was applied (shared dev DB), so there is no separate red CI run.
  - Search state never enters the URL: it lives in component state and goes to the `searchClients` server action (POST). Inputs have no `name`, so a pre-hydration submit adds nothing to the URL. e2e records every request/navigation URL and asserts none contains the search text or filter values.
  - Header count = active clients visible to the user; "Showing a–b of N" = matches. Import CSV / Add client buttons are not shown until steps 10 / 8 (no dead links); "Open" = the client name links to `/clients/[id]` (built in step 9; PR is draft until then).
  - CI run 36305200606 (033c6dc): all AC-7/AC-12 search tests passed; the timing test's **setup** failed — `permission denied for function pan_fits_type`: the service role cannot insert clients (the PAN CHECK calls a `private` helper only `authenticated` may execute). Not a product path (the app never writes clients as the service role), so test setup now inserts as a signed-in staff member / manager, like the app. Flag for architecture.md: service role cannot write `client` rows (fine today; revisit if an admin tool/seed ever needs it).
  - CI run 36305790377 (5eb4f38): DB suite green (67 passed / 1 skipped); one new e2e assertion expected "Partnership" but the app correctly shows "Partnership firm" (`CLIENT_TYPE_LABEL`) — the never-green test's expectation was corrected, app unchanged.
  - 1,000-client timing test runs on every PR (not nightly): setup is one service-role insert and `reset_test_office` purges it next run, so dev does not grow. The measured time is the full round trip from the US runner (stricter than "server time").

- Step 8 (2026-09-27):
  - Raja's decisions (2026-09-27): **dev migrations are dry-run, applied and reviewed together at the PR** (not one by one); **archive reason is stored on the client** (`client.archive_reason`, Admin/Manager only, cleared on unarchive, never in activity).
  - **New migration `20260927084340_client_create_update_archive`**: `archive_reason` + guard in `client_before_write`; `public.create_client(jsonb)` (client + registrations + groups in one transaction — a clashing GSTIN leaves no half-created client and uses no code); `public.update_client(uuid, jsonb)` (details + registration set in one transaction; removed registrations become inactive, re-added ones are reactivated). Both SECURITY INVOKER, one activity row each with field names only. The dry run caught a `text[] || 'literal'` bug before apply.
  - PAN is effectively fixed once a client has a GSTIN (the trigger compares all GSTINs, active or not, and registrations can't be deleted). Clear message; the workaround is archive + re-add. [Likely] rare in practice — flag if the pilot hits it.
  - `/clients/[id]` built now with the header + client card (AC-18's first half) because Edit and Archive need a home; step 9 adds the tabs and the Settings/collection plan. Edit is its own route `/clients/[id]/edit` (same `client-form.tsx` as Add).
  - CI run 36307379741 (4a9f75a): DB green; 19/20 e2e — the new edit test's `getByRole("link", { name: "Edit" })` also matched the brand link (fixture office "e2e office client-edit-ui" contains "edit"); selector made exact, app unchanged.
  - Society/co-op PAN letter warnings (AC-9 warn-only) need a second click ("Save anyway"); hard errors block.
- Step 9 (2026-09-27):
  - Code was written by a session that ended without a log (14:46–14:54 IST); reviewed against spec AC-18…21 and the migration's triggers/functions before committing. No new migration — step 2–3 functions (`enable_client_group`, `disable_client_group`, `add_client_doc_type`) and plan triggers cover it.
  - Added in review: read-only "Client reminders" card (spec UX line; text as specced, "Reminders arrive with feature 06" — internal wording, fine while 02 is dev-only); server refuses the reminders toggle on a removed/paused type or removed group (UI already did).
  - Refactor within scope: `validateSchedule` shared by catalogue and client plan (one rule set); `Modal` / `FieldError` / `Offset` moved from catalogue-view to `src/components/dialog.tsx` (catalogue e2e still green).
  - Single-row plan edits (pause/resume, assign, remove/restore, reminders, type dialog) update then log activity from the server action — same pattern as catalogue edits (not atomic; activity is best-effort). Multi-row changes use the atomic SQL functions.
  - The new e2e test needed 3 fixes before its first green run, none weakening an assertion (test had never passed, precedent c2f447f): exact name "Pause GST" (substring hit "Pause GST notice / order received"); activity asserts scoped to the test's client (serial-mode retry re-creates the client, `reset_test_office` keeps activity); fixture staff are named "Test <label>". App code unchanged by these.

- Step 10 (2026-09-27):
  - **Import is driven from the browser in chunks:** preview = one `previewImport` call with all rows (validation only); import = one `importClientsChunk` server action per ≤ 200 valid rows, in file order. The server re-validates every chunk against the DB *as it is now*, so a PAN repeated across chunks is caught as a duplicate (earlier chunks are committed). Keeps each request small, shows progress, and avoids one long serverless call for 2,000 rows.
  - If `import_clients` refuses a chunk (e.g. a clash created after the preview), that chunk is retried **row by row**, so good rows still import and the bad row gets a reason in the error file. Normal path is still one transaction per chunk.
  - Not in "Files that change": `src/lib/clients/import.ts` (DB context loader, paged GETs so no PAN/name enters a request URL); `next.config.ts` → `experimental.serverActions.bodySizeLimit: "3mb"` (a 1 MB file's rows as JSON can exceed the 1 MB default).
  - Rules the spec didn't spell out: a GSTIN/TAN already on another client, or used by an earlier row, is an **error** (the DB would otherwise reject the whole chunk); `client_type` accepts the stored value or the label, any case; blank `groups` = the office's "Enabled for new clients" groups; `incharge_email` is required (active staff); cells > 500 chars are rejected; header columns may be in any order/case, and a trailing `error` column is ignored so the error file re-uploads as-is; rows are numbered as in a spreadsheet (header = row 1).
  - Error file = error rows only (plus rows not imported because a chunk call failed), **not** duplicates — skipped rows need no fix. Formula-looking cells (`= + - @`) get a `'` prefix in the file and it is stripped on re-upload (so `+91…` mobiles round-trip).
  - AC-17 (1,000 rows < 60 s) runs in `regression.yml` with `RUN_SLOW=1`; nightly runs from `main`, so the first nightly proof comes after merge — **accepted by Raja 2026-09-27** as the AC-17 proof.

- Step 11 (2026-09-27):
  - Axe was already asserted on all 5 new screens (steps 6–10); gaps were in the states. `/clients/[id]`, `/new`, `/edit` and `/import` inherited the clients-list skeleton and "Clients could not be loaded." — each now has its own loading (and error where it loads data). Shared `src/components/states.tsx` (not in "Files that change"); the two existing skeletons put `aria-label` on a plain div (prohibited by ARIA 1.2, not announced) → now `role="status"` + sr-only text. Unit test `tests/unit/screen-states.test.tsx` (10) incl. axe-core in jsdom.
  - `tests/e2e/screenshots.spec.ts` (new, not in plan): seeded office with 3 realistic synthetic clients; screenshots of 03 / 05 / 11 + Add client + Import preview at 1280 px and 03 / 11 at 390 px into `test-results/screenshots/` (CI `test-evidence` artifact); axe on each.
  - Phone width: first recorded as an annotation because I assumed the 01 app header overflowed — wrong: the clients list fits at 390 px; the overflow was 02's own client page (fixed above).
  - **Mockup comparison (Raja put the CI `test-evidence` in the project folder):** 03 and 05 match apart from agreed deferrals (Export, overdue text, "Proposed by staff" panel, select filters, ↑/↓ + Edit group). 11 had two gaps, fixed: the header lacked **email and mobile (AC-18)**, and below `lg` the page grid's implicit column grew to the plan table's min-content width (534 px on a 390 px phone). Mockup 11's "Added <date> by <name>" in the client card is not in any AC — not added. The phone-width annotation became an assertion (≤ 390 px on both phone shots) plus an AC-18 header assertion.
  - **D4 (approved by Raja 2026-09-27 19:07 IST):** `tests/e2e/client-edit.spec.ts:86` `getByText("owner@example.test")` → `{ exact: true }`. The email now correctly appears in the header *and* the client card, so the substring match hit two elements (strict mode). Same behaviour guarded (the saved email is shown); not weaker.
  - Earlier note superseded: comparison vs mockups needed the screenshots: the cloud workspace can't download CI artifacts (blob storage blocked) and the Vercel preview needs a Vercel login.

## Session log
### 2026-09-26
- Done: intent approved; spec + seed catalogue approved (rev 2: catalogue = documents from the client; firm records separate, `doc_type.source`); 5 architecture changes approved; no groups pre-ticked; challans stay client documents. Plan drafted.
- In progress: plan gate.
- Blocked / failing: nothing pushed — Mac git has no GitHub credentials (Raja running `gh auth login`); evidence-fix PR not open yet.
- Next step: plan approval → step 0 after evidence-fix merge.
- Decisions made (cross-cutting → flag for architecture.md): spec's 5 changes + `doc_type.source client|firm`; `office.is_test` + purge function (if D2 approved).

### 2026-09-26 (evening)
- Done: plan approved (D1, D2). Evidence fix merged (PR #3); CI #21 and Regression #3 on main 581c64d show Unit 15 / RLS 10 / E2E 14. 02 rebased onto main. Steps 0–1 done (ClientsView + retargeted test; unit 15/15, lint 0, typecheck 0 — run locally in the device VM, which works for unit/lint/typecheck).
- In progress: —
- Blocked / failing: none. Rebased branch not yet force-pushed (Raja: `git push --force-with-lease origin feat/02-clients-and-catalogue`).
- Next step: step 2 — RLS/DB tests first (red), then step 3 migration.
- Watch in step 7: `tests/e2e/auth.spec.ts:44` expects "No clients yet" in its fixture office → client e2e tests must use a separate fixture office.
- Decisions made (cross-cutting → flag for architecture.md at merge): spec's 5 changes + `doc_type.source`; `office.is_test` + purge function. Debt: GitHub Actions on Node 20 (bump action versions); `ubuntu-latest` → Ubuntu 26 on 19 Oct 2026 (pin `ubuntu-24.04` before then).

### 2026-09-26 (late)
- Done: step 5 — `src/lib/validation/{identifiers,gst-states,client}.ts` + 2 unit test files (red → green); unit 65/65, lint 0, typecheck 0.
- Next step: step 2 (RLS/DB tests, red) → step 3 (migration 1 to dev) → step 4 (seed). Steps 0, 1, 5 done.
- Raja to push: `git push origin feat/02-clients-and-catalogue` (fast-forward, no force needed).

### 2026-09-27
- Done: step 2 (DB/RLS tests, 3 files + helpers; S1–S3 approved); steps 3–4 (migrations applied to dev, advisors clean). Unit 67/67, lint 0, typecheck 0.
- In progress: —
- Blocked / failing: none. CI run 36302710875 green (Unit 67 · RLS 54/0/1 · E2E 14) after the tenant-first trigger fix. Draft PR #4 is open (Raja opened it early; stays draft until step 13).
- Next step: step 6 — catalogue screen + actions + Settings sub-nav (read node_modules/next/dist/docs first, per AGENTS.md).
- Decisions made (cross-cutting → flag for architecture.md at merge): DB-level ACTIVITY_PII guard on `activity` (S1); assignment = Admin/Manager (S2); service-role-only helpers live in `public` with EXECUTE revoked (PostgREST can't reach `private`); `app.plan_bulk` / `app.purge_office` transaction flags honoured by triggers.

### 2026-09-27 (afternoon)
- Done: step 6 — Settings › Document catalogue (groups, types, firm records, FYs), Settings sub-nav, Settings for all staff; `doc_type_usage` view (dev). D3 approved. **Proof: CI run 36303853212 (45c7dec) — Unit 86 · RLS 58 / 0 / 1 skipped (AC-17 nightly) · E2E 16.**
- Workflow change: repo attached to the cloud workspace with push access — Claude pushes the feature branch directly (never main); Raja's Mac checkout is synced by git bundle.
- In progress: —
- Blocked / failing: none.
- Next step: step 7 — clients list (search, filters, archived toggle, 50/page, no query text in URL). Client e2e tests need their own fixture office (auth.spec.ts:44 expects "No clients yet").
- Decisions made (cross-cutting → flag for architecture.md at merge): security-invoker views for aggregates the UI needs (RLS applies); Settings visible to all staff with per-item role gating.

### 2026-09-27 (afternoon, step 7)
- Done: step 7 — clients list (search name/code/PAN/GSTIN/prev ref, Type/Incharge filters, Show archived, 50/page) via `search_clients` + server action; nothing typed reaches the URL. **Proof: CI run 36306261758 (6f365e6) green — Unit 94 (local, same code) · RLS 67 / 0 / 1 skipped (run 36305790377; DB tests unchanged since) · E2E 18.** 1,000-client search: 220–234 ms round trip from the US runner.
- In progress: —
- Blocked / failing: none.
- Next step: step 8 — add / edit / archive / unarchive client (+ registrations, groups at create, code); brings the "Add client" button.
- Decisions made (cross-cutting → flag for architecture.md at merge): list/search via SECURITY INVOKER SQL functions called from server actions (POST) — the pattern for any PII-bearing search; service role cannot write `client` rows (private CHECK helpers are `authenticated`-only).

### 2026-09-27 (afternoon, step 8)
- Done: step 8 — Add client / Edit (shared form), client page header + card, archive with optional reason / unarchive; `create_client` / `update_client` (atomic) + `archive_reason` on dev. **Proof: CI run 36307833084 (c2f447f) — Unit 97 · RLS 76 / 0 / 1 skipped (AC-17 nightly) · E2E 20.**
- In progress: —
- Blocked / failing: none.
- Next step: step 9 — Client › Settings: tabs, groups & types, enable/disable/pause/remove/restore, "+ Add type" (AC-18 … AC-21).
- Decisions made (cross-cutting → flag for architecture.md at merge): multi-table writes go through one SECURITY INVOKER SQL function per user action (atomic + one activity row); free-text notes (archive reason) live on the entity, never in activity; dev migrations reviewed together at the PR (Raja, 2026-09-27).
- Wrap-up (Raja, 2026-09-27 14:43 IST): Raja checks the **whole feature** on the Vercel preview after step 13, then merges PR #4 himself (no partial merge). Step 9 starts in a new session.

### 2026-09-27 (evening, step 9)
- Done: step 9 — Client › Settings: tabs (Settings only), collection plan per group (enable/disable with restore, remove/restore types, schedule/start period/reminders dialog, pause/resume + assign for Admin/Manager, "+ Add type to <group>"), client card + read-only reminders card. **Proof: CI run 36317948748 (e03e370) — Lint/typecheck/unit (104)/build green · RLS 76 / 0 / 1 skipped (AC-17 nightly) · E2E 22 / 0, no flaky.**
- In progress: —
- Blocked / failing: none.
- Next step: step 10 — CSV import (template, browser preview, server re-validation, chunked `import_clients`, result + error-row download; AC-13…17). `papaparse` not yet installed.
- Decisions made (cross-cutting → flag for architecture.md at merge): shared `src/components/dialog.tsx` (native `<dialog>` modal) for all forms-in-dialogs; single-row edits log activity from the action (best-effort), multi-row via atomic SQL functions.

### 2026-09-27 (evening, step 10)
- Done: step 10 — Clients › Import CSV: template download, browser parse (Papa Parse 5.7) + server preview (counts, per-row problems, "only rows with problems"), import in ≤ 200-row chunks via `import_clients` with server re-validation, result with code range + "Download error rows"; error file re-uploads as-is. "Import CSV" button on the clients list. No new migration. **Proof: CI run 36319719071 (7fa6436) green — lint/typecheck/unit (127)/build · RLS suite green (DB tests unchanged; AC-17 skipped, nightly) · E2E 24 / 0.**
- First CI run (36319153205, ff87501): the new e2e test's `getByRole("alert")` also matched Next's route announcer — switched to the existing `appAlert` helper; app unchanged (test had never passed).
- In progress: —
- Blocked / failing: none. AC-17 (1,000-row import < 60 s) not yet proven. **Raja 2026-09-27 18:24 IST: accept the first nightly `regression.yml` run after merge as AC-17 proof** (no manual branch run). The PR's AC table marks AC-17 "pending — first nightly after merge"; if that nightly fails, it is the top priority of the next session (fix-forward branch with the failing test kept).
- Next step: step 11 — axe on the 5 new screens + empty/loading/error states + screenshots vs mockups 03/05/11.
- Decisions made (cross-cutting → flag for architecture.md at merge): long-running bulk actions are driven from the browser in bounded chunks (each server action ≤ 200 rows, re-validated server-side); `experimental.serverActions.bodySizeLimit` = 3 MB; CSV exports neutralise formula-looking cells.
