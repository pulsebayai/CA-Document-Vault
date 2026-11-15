# Restore drill — database (2026-11-15)
chore prod-backups · runbook `sdlc/features/chore-prod-backups/runbook.md` §3 C.2 and §4 · run by Sidambara (Terminal) with Claude (checks).

| | |
|---|---|
| Backup used | `db/2026-11-15/0114/` (scheduled run 43661888588, 01:14 UTC = 06:44 IST): roles, schema, data |
| Target | throwaway project `restore-drill-2026-11` (`nmwnigwrxdxuywmzfhwv`, ap-south-1); **still running at this record (2026-11-15 10:20 IST): delete it** (it holds real staff accounts) |
| Client | psql 18 (Postgres.app) on a Mac, session pooler, one transaction |
| Result | **Pass**: restored database equal to prod on every count checked |

## Counts (read-only, 2026-11-15 ≈ 10:15 IST)
| | Prod | Restored |
|---|---|---|
| Public tables | 35 | 35 |
| Functions (public + private) | 227 | 227 |
| RLS policies (public + storage) | 62 | 62 |
| Offices · staff · auth users | 1 · 2 · 4 | 1 · 2 · 4 |
| Activity rows (all before 01:14 UTC) | 20 | 20 |
| Clients · documents · versions · Storage objects | 0 · 0 · 0 · 0 | 0 · 0 · 0 · 0 |
| Versions with no file (`restore-check.sql` §2) | — | 0 |

## Findings (fixed in the runbook)
1. `roles.sql` line `GRANT SET ON PARAMETER "log_min_messages" TO "supabase_realtime_admin"` is refused on a new project (Supabase's own grant, already present). Commented out; nothing else in roles.sql needed a change.
2. The first full attempt dropped its connection after > 16 min (laptop). One transaction, so nothing was written, but the session stayed *idle in transaction* holding locks and had to be ended before the retry. The retry with keepalives and `caffeinate -i` completed (≈ 4 min, from chat timestamps).

## Not covered (repeat ≈ 23 Nov 2026)
- **Files:** prod had no documents yet (Kushal's team starts 2026-11-16), so the file back-fill (runbook B) was not exercised.
- **Restore time at real volume:** this database is near-empty.
