# Evidence: cross-firm security sweep (feature 18)
Date: 2026-11-04 · Environment: dev (`ysddbwskljzhbjjohool`, Mumbai), from a Claude session; PR CI on ephemeral local Supabase stacks · Branch: `feat/18-cross-firm-security-sweep` · Spec: `sdlc/features/18-cross-firm-security-sweep/spec.md`

## What this shows
Many CA firms share one database (17). This sweep tries, as **Firm A's staff**, every way the application offers to reach **Firm B's** data, and proves each attempt fails for the right reason.
- **Every refusal has a control:** the same call, with the same shape, on Firm A's own records, which must succeed. So no attempt "passes" because of a typo, a missing field or a role rule. Where Firm A's own call is refused in exactly the same way, the change is closed to everyone, and that is recorded as such.
- **Firm B is untouched afterwards.** Every one of Firm B's rows, and its office row, is hashed before and after the run, and the hashes match.
- **Nothing in Firm A points at Firm B.** No row of Firm A references an object of Firm B through any foreign key, and no activity row or notification of Firm A names one.
- **Nothing escapes the list.** A guard test reads the database's own list of tables, views and functions, and fails the build if any of them has no cross-firm test. A second check fails if the map claims a test that didn't run.

## Result
**1 leak found and fixed. 0 open.**

| ID | What | Impact | Fix |
|---|---|---|---|
| L-1 | Firm A's Admin could insert a financial **period** of Firm A attached to **Firm B's financial year**. The access rule checked only the new row's own firm, and the foreign key doesn't know about firms. | Firm B's data was neither readable nor changed. The integrity breach: Firm A's data could be tied to Firm B's year. | `20261104110000_period_fy_office.sql`: the rule now requires the year to belong to the caller's own firm. The test was committed red first (5dad702); it is green after the fix. |

Also tightened (no exposure): six internal trigger functions from feature 02 still had PostgreSQL's default "anyone may execute" grant. Trigger functions can't be called directly, and that schema isn't exposed over the API, so nothing was reachable. The grant was revoked anyway, so the guard's "nothing callable without signing in" rule holds with no exceptions.

## Coverage (inventory read from the database, 2026-11-04)
| Object | Count | How it is tested |
|---|---|---|
| Tables with firm data | 28, plus `office` and the view `doc_type_usage` | read · change Firm B's rows · insert into Firm B · point Firm A's rows at Firm B through every writable foreign key |
| Tables with no app access | 4 (`login_attempt`, `test_lane`, `doc_counter`, `link_attempt`) | Firm A reads nothing and every insert is refused by the access rules |
| Functions staff can call | 63 | 106 attempts with Firm B's IDs, or Firm A's record mixed with one of Firm B's |
| Platform-only functions | 18 (incl. the 3 client upload-link functions) | refused for anonymous callers and for Firm A's Admin by the grant; upload links also tried with Firm B's items |
| Internal functions that bypass access rules | 60 | 56 reached through the tests above; 4 exempt with reasons (2 nightly jobs, 2 catalogue seeders used only by the platform's firm setup) |
| File storage | 1 private bucket, 0 storage policies | direct download, signed link, list, upload and move on Firm B's file; the app's own file-link code run as Firm A |
| Screens | client page (6 tabs), document page, activity, search | browser test: Firm B's pages show Not Found and carry none of Firm B's text; Firm A's own pages open |

## Results by kind (final run, 145 tests green)
**Tables**
| Case | Refused by a named firm check¹ | Refused; Firm A's same call works | Closed for everyone² | Accepted but not stored |
|---|---|---|---|---|
| Insert a row into Firm B (19 tables) | 4 | 4 | 11 | — |
| Point Firm A's row at Firm B — update (23 foreign keys) | 5 | — | 12 | 6 |
| Point Firm A's row at Firm B — insert (36 foreign keys) | 12 | 1 | 23 | — |

**Reading and changing Firm B's rows**
- **Read (30 tables + view):** Firm A's Admin and Limited users get none of Firm B's rows; the same read finds Firm A's own.
- **Change Firm B's rows (29 tables):** 0 rows changed. On 10 tables the attempt wrote a new value, and the same change to Firm A's own row worked or was closed. On the other 19 there was no staff-writable column, so only a delete was tried. Every Firm B row is still there.

**Functions** (106 attempts)
| Outcome | Attempts |
|---|---|
| Refused; Firm A's same call worked | 74 |
| Refused; Firm A's same call refused identically (a DSC can't move to another client) | 1 |
| Refused with the expected "not found" (no control possible, reason recorded³) | 1 |
| Searches, activity, Today, DSC reminders, type suggestions, previews: nothing of Firm B's returned, checked by ID and by a unique marker text; Firm A's own results returned | 20 |
| Firm-wide figures (6 metrics) asked by an empty Firm C: all zero, while Firm A's own figures are not zero | 6 |
| Functions with no ID argument: only the caller's firm changed | 4 |

**Upload links, files and screens**
- **Upload links:** Firm A's link lists only Firm A's items. Tickets for Firm B's items are refused. Filing into Firm B's item, or filing Firm B's stored file under Firm A's item, is refused. Firm B's live link can't reach Firm A's items. The control: Firm A's own upload is filed.
- **Files:** direct storage calls on Firm B's file are all refused. The app's view/download link, bulk zip, file lists and upload start give out nothing of Firm B's, while the same calls on Firm A's document work. A new upload always lands in Firm A's own folder.
- **Screens** (3/3): Firm B's client page (all six tabs, DSC included) and document page show Not Found to Firm A's Admin. Activity and search show nothing of Firm B's. Firm A's own client, document, activity and search work.

¹ Named firm checks: the database's own refusals such as `CLIENT_OFFICE`, `TYPE_OFFICE`, `PERIOD_OFFICE`, `GROUP_OFFICE`, `PLAN_MISMATCH`, `ASSIGNEE`, `INCHARGE`, `PATH`.
² Closed for everyone: staff can't write that column or table directly at all. Those changes go only through the vault's own functions, which are tested separately above.
³ `retry_link_email` needs a link whose email failed. Firm A's one email per client per day is already used by another test's control.

## Runs
- **Session on dev, 2026-11-04:**
  - the cross-firm folder: 145 tests green, ≈ 7 min including setting up the two firms;
  - the full database suite: 66 files, 1,013 passed, 0 failed, 17 skipped (the volume and slow tests that are off by default);
  - unit tests: 702 passed;
  - the browser test, locally: 3/3.
- **PR CI on fresh local test databases:** see the PR. Its run ID and time are added here when it finishes.
- **Pre-PR review:** independent `sdlc-reviewer` pass. It found 1 blocker and 9 important issues, all in the test logic, and all are fixed. None was a leak in the product.

## How to re-run
`npx vitest run --project db tests/rls/cross-firm/` (with `XF_REPORT=<file>` it writes each case and verdict to that file) · `npx playwright test tests/e2e/cross-firm.spec.ts`. Both run in PR CI on every pull request and in the nightly Regression on dev.
