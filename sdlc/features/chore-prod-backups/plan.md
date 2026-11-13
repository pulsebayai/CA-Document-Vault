# Chore: prod-backups
Owner: Sidambara · Raised 2026-11-13 (Kushal Associates starts real work on prod today) · No schema change · No app code change · Architecture lock is held by chore ses-mailer, so the architecture.md text below is **proposed**, added when that lock is free.

## Why
Before today prod had Supabase's daily backups only (7 days, Pro plan). Three gaps:
1. **Uploaded files had no backup.** Supabase backups cover the database, not Storage objects. The `documents` bucket holds every client file (PAN, KYC, financials).
2. **Up to 24 h of database changes could be lost** (daily backups only).
3. **Supabase's backups are deleted with the project**, and no restore had ever been tried.

## Decisions (owner, 2026-11-13)
- **Pilot: Supabase daily backups only (7 days), no PITR** (owner 2026-11-13, cost). Accepted risk: up to ≈ 24 h of database changes lost in a restore (documents registered, reviews, custody and DSC moves), to be re-entered by staff; their files survive in Storage and the off-site copy.
- **PITR (7 days, + Small compute) is switched on when the second firm is onboarded**, or earlier if a firm's contract promises a recovery point under 24 h. Item on the second firm's onboarding checklist.
- **Off-site copy in our own AWS account, ap-south-1** (data stays in India), every 6 hours (03/09/15/21 IST), by `.github/workflows/backup.yml`:
  - `storage/documents/…`: `rclone copy` (never deletes; `--immutable` fails the run if a backed-up object changed: the app never overwrites, D2).
  - `db/<date>/<HHMM UTC>/`: `supabase db dump` roles / schema / data, gzipped.
  - Bucket: versioning on, Object Lock (governance, 35 days), block public access, SSE-KMS. Noncurrent versions and `db/` expire after 90 days; current `storage/` objects never expire.
- **Credentials:** AWS through GitHub OIDC (no AWS keys stored); the role can list, read and put, and is explicitly denied delete and bucket configuration. Supabase S3 access key and the prod DB URL are secrets of the GitHub environment `prod-backup` (deployment branch `main` only).

## Risks accepted / open
- **[Open, owner] Supabase S3 access keys have full Storage access (read, write, delete, bypass RLS)** and the DB URL is the `postgres` role. Both now sit in GitHub. Mitigation: environment-scoped, main-only, the workflow only reads. Alternative: run the job from a small VM in our AWS account instead of GitHub (more ops work). Recommended for the pilot: GitHub, revisit before firm #2.
- Files uploaded since the last run are not in the off-site copy until the next one (≤ 6 h). Database: a restore uses Supabase's daily backup (≤ 24 h lost); records lost after it can be pulled selectively from the 6-hourly dump (≤ 6 h).
- The dumps contain PII (auth emails, client details). Same controls as the files; DSC passwords stay encrypted (key never in the database, 14).

## Steps
- [x] 1. `.github/workflows/backup.yml` (copy + verify + dump + size checks).
- [x] 2. `scripts/restore-check.sql` (counts, versions with no file, newest upload). Proven read-only on dev 2026-11-13: 0 versions missing a file (380 versions, 409 objects).
- [x] 3. `runbook.md` (AWS setup, GitHub setup, restore scenarios, drill).
- [ ] 4. Owner: confirm prod's Database → Backups list shows daily backups. Kushal Associates told the pilot's recovery point (done 2026-11-13, Sidambara).
- [ ] 5. Owner: AWS bucket + OIDC role (runbook §1), GitHub environment `prod-backup` (runbook §2).
- [ ] 6. PR (docs + workflow only; CI's "What changed" job). Merge, then `workflow_dispatch` the first run; record object count and dump sizes below.
- [ ] 7. Restore drill (runbook §4) into a throwaway project within 7 days; evidence in `sdlc/releases/R1/evidence/restore-drill.md`.
- [ ] 8. Add "PITR 7 days + Small compute on prod" to the firm-onboarding steps in `sdlc/releases/README.md` › Firms and tenancy (trigger: firm #2).
- [ ] 9. When the architecture lock is free: add the decision row below to architecture.md and a "Backups and restore" section to `sdlc/releases/README.md` pointing at the runbook.

## Proposed architecture.md decision row
| 2026-11-13 | **Prod backups:** Supabase daily backups during the pilot, PITR 7 days from the second firm; 6-hourly off-site copy of Storage `documents` (copy-only, immutable) and a `supabase db dump` to our AWS bucket in ap-south-1 (versioned, Object Lock 35 d), GitHub OIDC, job `backup.yml`; restore runbook + monthly drill | Pilot starts on prod 2026-11-13; Supabase backups don't cover Storage and die with the project | chore prod-backups |

## Session log
- 2026-11-13 (Opus): checked prod (Pro plan, daily backups only, PITR off). Recommended PITR now that the pilot starts today; owner agreed. Wrote steps 1–3 on the working tree of `chore-r1-sankar-feedback` (uncommitted; move to branch `chore/prod-backups` from main). Found while planning: the 01:00 IST `storage-sweep` cron deletes Storage objects with no `document_version` row after 24 h, so after a PITR restore it would delete files uploaded after the restore point: the runbook pauses it first.
- 2026-11-13 (owner): PITR deferred to the second firm; daily backups for the pilot (decision above).
- 2026-11-13 (owner): off-site job every 6 h (dump at each run, path `db/<date>/<HHMM>/`); Kushal Associates informed of the pilot recovery point.
