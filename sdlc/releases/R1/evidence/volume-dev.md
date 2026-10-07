# R1 volume test — dev (09)
Date: 2026-10-07 · Env: dev (`ysddbwskljzhbjjohool`, Nano compute) · Office: `e2e office volume` (is_test) · Branch: `chore/09-volume-test` · Runner: Claude cloud session (local run; the CI dispatch result is added below when it runs)
Plan: `sdlc/features/09-volume-test/plan.md`. **Rule (Raja 2026-10-07): measure and record; no fixes in 09.**

## Volume
1,000 clients (6 groups, GSTIN + TAN each; 150 with the Staff user and 50 with the Limited user as incharge) · **183k expected items** (12 months, office clock 2027-04-15) · **10,100 documents** (10k filed, each linked to an item; 7k soft copies with a stored file; 100 in the Inbox; 3k reviewed) · **200k activity rows**.
Seeding: clients 108 s (API) · expected items 13 SQL steps (see K2) · uploads 288 s · documents 133 s · reviews 28 s · activity 77 s.

## Results
"API" = median of 5 warm calls through PostgREST as the right role, minus a trivial-read ping (291 ms). "DB" = the same function timed inside the database as that user (no 8 s limit), from rolled-back blocks. **TIMEOUT = over the 8 s `authenticated` statement limit: the screen shows an error, not a slow page.**

| # | What | Target | API (server ≈) | DB | Result |
|---|---|---|---|---|---|
| V1 | Header suggestions ("bank": 5 clients + 5 documents) | < 300 ms | 160 ms | — | pass |
| V2 | `/documents` page 1 + facets, Staff (no text / "bank") | < 1 s | 250 / 150 ms | — | pass |
| V3 | `/documents` page 1 + facets, **Limited**, "bank" | < 1 s | 924–1,198 ms (2 runs) | — | **borderline miss** |
| V4a | Daily job, normal day (nothing new to create) | < 60 s | n/a (cron) | **26.3 s** | pass (see K2) |
| V4b | Daily job, month start, all 1,000 clients monthly (16k new items) | < 60 s | n/a (cron) | **30.0 s** | pass (see K2) |
| V5a | **Clients list**, page 1 with overdue counts (also "Has overdue") | < 1 s | TIMEOUT | **26.6–32.6 s** | **TIMEOUT** |
| V5b | Client › Expected (busiest Staff client, 183 items) | < 1 s | 568 ms | 141 ms | pass |
| V5c | Client › Documents (list + open-item cards) | < 1 s | 554 ms | 23 ms (list) | pass |
| V6 | **Collection metric** (FY 2026-27) | < 2 s | TIMEOUT | **15.6 s** | **TIMEOUT** |
| V7 | Document save in the volume office − in an empty office | + < 50 ms | no measurable difference (290 vs 340 ms round trip) | — | pass |
| V8 | **Today**, "Mine" (150 clients) | ≤ 1 s | TIMEOUT | **13.5–19.8 s** | **TIMEOUT** |
| V9a | Activity first page (Staff) | < 1 s | 110 ms | 121 ms | pass |
| V9b | Activity first page, **Limited** | < 1 s | 605–1,204 ms (2 runs) | — | **borderline miss** |
| V9c | `/activity?client=` | < 1 s | 25 ms | 599 ms | pass |
| V9d | **Document page Activity card** (20 rows) | < 1 s | TIMEOUT | **14.1 s** | **TIMEOUT** |
| V10 | Bulk Mark reviewed, 200 documents | < 5 s | 1,793 ms | — | pass |

**Data-skew check (rolled back):** with 10k documents, 92% of items are overdue. Marking 85% of overdue items received on time (metric 1 = 83%) and re-timing gave Clients list **26.6 s**, Today **13.5 s**, Collection metric **15.7 s**. So the skew isn't the cause: these costs grow with the office's total items.

## Known performance issues (recorded, not fixed — Raja 2026-10-07)
- **K1 — CSV import with several groups times out.** 200-row chunk, GSTIN + TAN: 0 groups 0.8 s · 3 groups 8.8 s · 6 groups 16.9 s (limit 8 s). Workaround until fixed: files of ≤ 40 rows (6 groups) or ≤ 80 rows (3 groups). Likely fix: smaller chunks in the import screen, or set-based group enabling.
- **K2 — daily job time grows with all stored items, not with new ones.** Month-start steps: 7.7 s at ~17k items → 25.7 s at ~168k; a run with nothing new: 17.4 s (no documents) → 26.3 s (with 10k documents). Under 60 s now; [Likely] about 60 s after 2–3 years at 1,000 clients. Likely fix: generate forward from each plan row's last generated period instead of re-checking every past period nightly.
- **K3 — Clients list, Today and Collection metric time out** at ~1 year × 1,000 clients (26–33 s, 13.5–20 s, 15.6 s). [Uncertain] extrapolation, if roughly linear in items: the Clients list reaches 8 s at ~55k items (≈ 300 clients × 1 year, or 1,000 clients × ~4 months); Today at ~110k. Likely fix: per-client overdue counts computed for the page only (not every client), and index-backed filters on `expected_doc (office_id, status, overdue_from)`; Collection metric on an aggregate.
- **K4 — document page Activity card times out** (14.1 s at 200k activity rows). The 08 review had flagged its unindexed document filter. Likely fix: an index on `activity (entity_type, entity_id, created_at)` or a resolved document column.
- **K5 — Limited users' search and Activity are borderline** (≈ 0.6–1.2 s vs < 1 s), the per-row visibility helpers. Low priority.

## What this means for R1
- **Pilot (2–3 staff, 20–30 clients):** [Likely] unaffected. 30 clients produce ≈ 5.5k items a year, ≈ 3% of this volume; every timed screen is far below its limit at that size.
- **Rollout to all clients:** **blocked by K3 and K4** (main screens return errors), and import needs K1's workaround. [Likely] those screens fail within months at 1,000 clients, and sooner for the Clients list.
