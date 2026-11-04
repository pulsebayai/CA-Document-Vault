# Spec: Cross-firm security sweep
Intent: ./intent.md · Status: **approved** (Sidambara, 2026-11-04: X1–X8 as proposed; X1 and X3 as recommended) · Date: 2026-11-04

## Inventory (dev, read 2026-11-04)
| Object | Count | Notes |
|---|---|---|
| public tables | 31 | RLS on for all 31. 28 have `office_id`. No `office_id`: `office` (row = the firm), `login_attempt` and `test_lane` (no policies, service role only) |
| public policies | 61 | none on `doc_counter`, `link_attempt`, `login_attempt`, `test_lane` (no app access) |
| public views | 1 | `doc_type_usage` (`security_invoker = true`) |
| public functions callable by `authenticated` | 63 | 61 invoker; 2 definer: `dsc_reveal`, `run_expected_generation` |
| public functions, service role only | 17 | 10's `link_open` / `link_ticket` / `link_register`; operator and job helpers; test helpers |
| private SECURITY DEFINER functions | 60 | triggers, guards, helpers. RLS doesn't apply inside them, so each must check the tenant itself |
| Storage | 1 private bucket, 0 policies | files reached only through server-signed links after an RLS lookup (`src/lib/documents/storage.ts`) |
| Realtime publication | 0 tables | nothing to probe; the guard keeps it at 0 |

## Summary of design decisions (proposed; marked X-n for the gate)
- **X1: one introspection function, test-only, service role only.** The coverage guard has to list tables, policies, views and functions. PostgREST can't read `pg_catalog`, so a new `public.test_schema_inventory()` (definer, `search_path = ''`, EXECUTE for `service_role` only, like 04's `expected_job_info`) returns names and kinds only. **This needs one migration, so 18 takes the schema lock at plan approval** (free today). The intent said "no lock unless a leak". This read-only function is the only other change. Alternative: parse `supabase/migrations/*.sql` as text. I rejected it because it's brittle and misses objects created by dashboard-applied migrations (05, 08).
- **X2: the coverage map is code.** `tests/rls/cross-firm/coverage.ts` names every object with its case:
  - every public table and view;
  - every public function (`authenticated` and `service_role`);
  - every private definer function, with the public function or table write that reaches it.
  
  An object can be **exempt** only with a written reason, e.g. "service role only; operator tool, never reachable by staff" or "test helper; `is_test` only". The guard fails when:
  - the database has an object the map lacks;
  - the map names an object the database lacks;
  - an exemption has no reason.
  
  This is 08's permission-matrix pattern.
- **X3: the attacker is Firm A's Admin.** Admin is the widest role, so a refusal for Admin is a refusal for every role. Two places add a second actor:
  - **Firm A's Limited** user, for the definer functions and `activity_select`, whose rules depend on the role;
  - an **unauthenticated** caller for the 17 service-role functions (already refused; re-asserted in one loop).
- **X4: four case shapes, applied by table-driven helpers**, so a new object is usually one line in the map:
  1. **Read:** select Firm B's rows by ID, and list without a filter: 0 of B's rows.
  2. **Write B's rows:** update and delete by B's ID. 0 rows are affected, and a service-role read shows B's row unchanged.
  3. **Insert into B:** insert with `office_id = B`. Refused.
  4. **Cross-reference (the class most likely to leak [Likely]):** insert or update a row **in Firm A** that points at a **Firm B** parent: `client_id`, `document_id`, `doc_type_id`, `period_id`, `expected_doc_id`, `dsc_id`, `upload_request_id`, `dispatch_id`, `registration_id`, `doc_group_id`, assignee `staff_user`. Expected: refused. A policy's `with check (office_id = current_office_id())` does **not** check that the parent belongs to the same firm. Only the parent tables' triggers do, where they exist, so every foreign key gets a case.
- **X5: functions are called with Firm B's IDs.** Expected: a refusal (any error) or an empty result, **and no write anywhere**. A service-role snapshot of B's rows and of both firms' `activity` and `notification` is taken before and after; the counts must match. Aggregate reads (search, facets, Today, `dsc_due`, metrics, `activity_feed`, `proposal_queue`, `search_clients`, `suggest_doc_types`) are called with no filter and with B's IDs as filters. The result must not contain any of B's **marker strings**: unique, non-PII tokens seeded into B's remarks, file names, client names and type names.
- **X6: Storage and server actions.**
  - **(a)** Firm A's signed-in client calls Storage directly (download, list, create a signed URL, upload) on B's object path. Refused, because there are no policies.
  - **(b)** The server-side lookups that come before signing (`currentFiles`, `getFileLink`, the bulk listing, the upload ticket's document check) are exported query functions. They are tested as A with B's document IDs and must return nothing to sign. `signFileLink` itself takes a path and isn't exposed to the browser.
  - **(c)** **One e2e per screen family** (intent Q2) signs in as A and opens:
    - B's client page (every tab, DSC included) → Not Found;
    - B's document page → Not Found;
    - `/activity?document=<B>` → empty;
    - header search for B's DOC-ID and marker → nothing.
- **X7: where it runs.** It is a new RLS project folder `tests/rls/cross-firm/`. It runs in PR CI on the local stacks and in the nightly on dev, with lanes via the existing fixture naming (`e2e office xfirm-a #<lane>`). The seed is created once per run as signed-in staff, because clients can't be created by the service role (02). Target: **≤ 3 min added** to PR CI's RLS job, measured at step 2.
- **X8: a leak found = failing-first.** The case is committed red (never wrapped in `it.fails` or skipped) and stays red until the fix. The fix follows in the same PR with a migration (schema lock, X1). It follows the existing patterns: tenant-first in the trigger or definer function, `search_path = ''`, and RLS as the enforcement. Each leak gets a row in the evidence report: object, case, impact, fix.

## User stories & acceptance criteria
*As Firm A's staff, I can't read, change, create, link to, call into or download anything of Firm B's, and the build fails if a new object ships without that proof.*

### Fixture
- **AC-1** A two-firm seed creates firms A and B (test offices), each with an Admin, a Staff and a Limited user. Each firm has at least one row in **every** table with `office_id`, made through the app's own functions:
  - client with registration and contact;
  - plan rows (group, doc type) and an expected item;
  - a proposed type;
  - documents with versions and stored files: one reviewed, one in custody, one in a dispatch;
  - a follow-up;
  - an upload request with scheduled and ad-hoc items, plus a link upload;
  - a DSC with custody and a setting;
  - a notification and activity rows.
  
  B's text fields carry marker tokens (`XF-B-<random>`). The seed is idempotent per lane and has no PII.

### Coverage guard
- **AC-2** The guard test compares `test_schema_inventory()` with `coverage.ts`. It fails, naming the object, when:
  - an object in the database has no case or exemption;
  - an entry names a missing object;
  - an exemption has no reason;
  - a public table has RLS off;
  - a view isn't `security_invoker`;
  - a function is executable by `anon`;
  - the Realtime publication holds a table.
- **AC-3** `test_schema_inventory()` is executable by `service_role` only. An `authenticated` or `anon` call is refused (tested). It returns object names, kinds and flags, and no data.

### Tables (28 with `office_id` + `office` + the view)
- **AC-4** For each table and the view, the cases in X4 that apply to its policies:
  - **read** for all;
  - **write B's rows** where an update or delete policy or grant exists;
  - **insert into B** where an insert policy exists;
  - **cross-reference** for every foreign key to a firm-owned parent.
  
  Each case passes as A's Admin. For `activity`, `notification` and the DSC tables, the read case also runs as A's Limited user.
- **AC-5** A table with **no** app policies (`doc_counter`, `link_attempt`, `login_attempt`, `test_lane`) returns nothing and refuses writes for an `authenticated` client of either firm.

### Staff-callable functions (63)
- **AC-6** Each function is called as A's Admin with B's IDs in every ID argument (and, for jsonb arguments, in every ID key). The result is a refusal or empty, and the before/after snapshot (X5) shows no change in B and no new row in either firm's `activity` or `notification`.
- **AC-7** For the 2 definer functions:
  - `dsc_reveal(<B's DSC>)` returns no ciphertext and writes no reveal row, as A's Admin and as A's Limited;
  - `run_expected_generation` changes only the caller's own office (B's `test_today` and expected items unchanged).
- **AC-8** The aggregate reads in X5 return none of B's markers or IDs, with no filter and with B's IDs as filters.

### Service-role functions (17)
- **AC-9** `link_open`, `link_ticket` and `link_register` with **A's valid token** and **B's** item, request or document IDs return `NOT_ACTIVE` or the item refusal, create no ticket, file nothing and write nothing to B. A link of A's never lists B's items.
- **AC-10** Every service-role function is refused for `anon` and `authenticated` (one loop over the inventory). The operator, job and test helpers are listed as exemptions with reasons. Their own office checks are already tested by their features (17 bootstrap, 13 backfill, 02 reset).

### Private definer functions (60)
- **AC-11** Each is mapped in `coverage.ts` to the AC-4 or AC-6 case(s) that execute it with a cross-firm input, e.g. `private.link_item` ← AC-9, `private.notify` ← the type-decision calls in AC-6, `private.doc_activity_ids` ← `activity_feed` and `document_last_activity` in AC-6/AC-8. A function no case reaches is either given a case or exempted with a reason (e.g. "cron only, iterates offices itself").

### Storage and screens
- **AC-12** X6 (a) and (b): Firm A gets no file of Firm B's through any path.
- **AC-13** X6 (c): A's Admin sees Not Found or empty on B's client (all tabs), document, document activity and search. Each page is also checked for no marker of B in its HTML.

### Results
- **AC-14** All cases pass at merge, i.e. 0 open leaks. Every leak found is fixed failing-first (X8) and listed in `sdlc/releases/R1/evidence/cross-firm-sweep.md`. The report also gives the inventory counts, the case counts by shape, the exemptions with reasons and the run IDs. It is written for the Kushal demo.
- **AC-15** The suite adds ≤ 3 min to PR CI's RLS job. Measured; if over, the plan shards it, and no case is dropped.
- **AC-16** Every existing test passes unedited.

## Functional requirements
- `tests/rls/cross-firm/`:
  - `seed.ts` (AC-1);
  - `coverage.ts` (map + exemptions);
  - `guard.test.ts` (AC-2, AC-3);
  - `tables.test.ts` (AC-4, AC-5);
  - `functions.test.ts` (AC-6–AC-8);
  - `links.test.ts` (AC-9, AC-10);
  - `storage.test.ts` (AC-12).
  
  Shared helpers: `snapshot(officeIds)` (service role: row counts per table, plus `activity` and `notification` maxima), `asFirmA(role)`, `markersOf(B)`.
- `tests/e2e/cross-firm.spec.ts` (AC-13).
- Migration `…_test_schema_inventory.sql` (X1), the only schema change unless a leak is found.

## Non-functional requirements
- **Security:** the inventory function returns metadata only, for the service role only. No test writes to a non-test office. The marker tokens are random and contain no PII.
- **Speed:** ≤ 3 min (AC-15). The seed is reused within a run.
- **Maintainability:** a new table or function is one map line plus, when the shape is new, one helper.

## Data model changes
- None, except `public.test_schema_inventory()` (X1), plus leak fixes if any.

## Existing code affected
- None, unless a leak is found.
- Test support gets additions only (`tests/support/` cross-firm seed). `vitest.config` gets an include for the new folder if the `db` project doesn't already glob it.

## Test strategy
- The suite **is** the feature. The guard proves coverage, and the shapes prove isolation.
- Order: guard + inventory first, red: every object starts missing. Then the shapes, one family at a time, until the guard is green.
- Leak cases are red until fixed (X8).
- The Regression `only` dispatch on dev = `rls/cross-firm` before merge (CLAUDE.md rule for a PR with a migration).

## Proposed architecture changes
- One line under "Cross-cutting rules": **every new table, view or function needs a cross-firm case in `tests/rls/cross-firm/coverage.ts` (guard-enforced)**, in the same spirit as 08's permission matrix. The architecture lock is taken with the schema lock at plan approval and released at merge.

## Risks & areas of concern
- **[Likely] cross-reference writes (X4.4) are where a leak is most likely.** Policies check the row's own `office_id`, not its parents'. If several tables lack parent checks, the fix is a set of trigger changes: more work than the estimate (+1–2 days) and RUN_SLOW if 02/03 write paths change.
- **[Uncertain] the time budget:** 63 functions × several ID arguments + 28 tables × up to 4 shapes ≈ 300–400 calls. On local stacks that is ≈ 1–2 min; on dev from GitHub's runner (≈ 1 s per call) it is ≈ 6–7 min in the nightly. That is acceptable there, and the PR budget applies to local stacks only.
- Dashboard-applied migrations (05, 08) exist on dev without a history row. The inventory reads the live catalogue, so they are covered.

## Out of scope
As in the intent (19, export, per-firm DSC keys, external pen test, roles within one firm).

## Decisions at the gate (Sidambara, 2026-11-04)
1. **X1:** take the schema and architecture locks at plan approval for the test-only inventory function (recommended), rather than parsing migration files.
2. **X3:** Admin as the main attacker, plus Limited on the role-dependent objects (recommended). Running every case for all 4 roles would roughly add ×3 time for little gain.
