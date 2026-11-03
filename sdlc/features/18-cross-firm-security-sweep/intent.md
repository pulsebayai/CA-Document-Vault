# Intent: Cross-firm security sweep (prove firm isolation everywhere)
Author: Sidambara (drafted with Claude) · Status: **draft — awaiting approval** · Date: 2026-11-04
Roadmap item: 18-cross-firm-security-sweep · Release: **R1** (Sidambara, 2026-11-04) · Moves product metric: none directly. It guards all of them and enables more firms, because Kushal Associates distributes the vault to other CA firms.

## Problem
- **Firm isolation is designed in, but only partly proven.** Every business table has `office_id`, and RLS keys every policy on `private.current_office_id()`. Today's tests mostly check isolation *inside* one firm: roles, Limited users, clients. 17 proved the edges (login page, invite error, sender, bootstrap), but **no test puts two firms side by side and tries every door**.
- **Size of the surface on dev (2026-11-04):**

  | Object | Count |
  |---|---|
  | public tables | 31, of which 28 have `office_id` and all have RLS on |
  | policies | 61 |
  | functions callable by staff | 63, of which 2 are SECURITY DEFINER |
  | service-role-only public functions | 17, incl. 10's upload-link functions |
  | Storage | 0 policies; signed URLs only after an RLS lookup |

- **Where a leak would most likely hide** [Likely]:
  - definer functions and triggers that set their own office (04's daily job, 10's `link_act_as`, 05's `private.notify`, 15's `private.doc_activity_ids`);
  - functions that take an ID from the caller and join across tables without re-checking the office;
  - Storage paths (`office/<office>/doc/<document>/…`) signed by `storage.ts`;
  - the 3 tables without `office_id` (`login_attempt`, `office`, `test_lane`).
- **Cost of not doing it:** the R1 demo can't show Kushal (or the firms Kushal sells to) evidence that Firm B can never see Firm A's clients, documents, DSC passwords or files. A leak found after a second real firm is live is a DPDP Act incident. Without a coverage guard, a future table or function could ship with no cross-firm test.

## Proposed outcome
1. **Two-firm fixture:** two test offices on one database, each with an Admin, a Staff and a Limited user, and a full set of data: clients, plan, expected items, documents + files, review/custody/dispatch, follow-ups, upload links, DSCs, notifications and activity.
2. **A cross-firm test for every object**, run as Firm A's staff against Firm B's rows:
   - **Tables:** select, insert, update and delete each return nothing or are refused.
   - **Staff-callable functions:** called with Firm B's IDs, each returns nothing or a refusal, and writes nothing. These are invoker and definer functions, RPC and server actions.
   - **Service-role public functions** (10's `link_*`): a Firm A link can't reach Firm B's items or files.
   - **Storage:** no signed view, download or upload link for a Firm B path, through any server action.
   - **Reads that aggregate:** counts, facets, metrics, Today, search and activity feeds include nothing from Firm B.
3. **Coverage guard:** a test lists the database's tables, policies and functions and fails when one has no cross-firm case. This works like 08's permission matrix: a new table or function without a cross-firm test fails CI.
4. **Any leak found is fixed failing-first.** The test is committed red, then the fix follows. A fix needs a migration, which takes the schema lock then (free today).
5. **Evidence for Kushal:** a short report in `sdlc/releases/R1/evidence/` listing what was probed, the result and any fixes. It can be shown in the demo.

## Users & systems affected
- **No screen changes.** Tests only, unless a leak is found.
- **Systems:**
  - `tests/rls/` gets a new cross-firm suite, a coverage guard and fixture helpers;
  - fixes, if any, go in the affected function or policy (schema lock then);
  - the suite runs in PR CI on the local stacks, and in the nightly on dev.

## Success metrics
1. **100% coverage:** every table with `office_id`, every staff-callable function and every service-role public function has a cross-firm case, and the guard proves it (pass/fail).
2. **0 cross-firm leaks** at merge. Each one found is fixed and tested.
3. **CI cost:** the suite adds ≤ 3 min to PR CI's RLS job [Uncertain; measured in the plan].

## Constraints
- **Never edit an existing test to make it pass.** No change to business behaviour unless it is a leak fix.
- **Test data only** (`is_test` offices, `.test` users). Never run against staging data or prod.
- **No PII** in test names or logs.
- Leak fixes follow the existing patterns: tenant-first definer functions, `search_path = ''`, RLS as the enforcement.

## Out of scope
- Super admin / operator console (19).
- Data export and offboarding (after R1).
- Per-firm DSC keys (dropped: one platform key per environment, Sidambara 2026-11-04).
- Penetration testing of the deployed site by an outside party (a candidate before the second *real* firm; not decided).
- Roles inside one firm, which are already covered by 08's role matrix.

## Open questions for approval
1. **Q1 — the coverage guard's strictness.** I recommend **fail CI** when a new table or function has no cross-firm case, not just warn. It mirrors 08's matrix.
2. **Q2 — server actions.** I recommend that functions are tested at the database (where RLS decides), plus **one e2e per screen family** that signs in as Firm A and opens Firm B's URLs (client, document, DSC, link) and expects Not Found. Covering every server action one by one would roughly double the work for little extra protection [Likely].
3. **Q3 — if a leak is found**, fix it inside 18 (taking the schema lock), rather than recording it for later. I recommend fixing inside 18.
