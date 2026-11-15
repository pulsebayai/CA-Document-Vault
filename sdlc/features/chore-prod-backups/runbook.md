# Prod backups and restore — runbook
chore prod-backups, 2026-11-13. What is backed up, how to set it up, how to restore. Prod = `rryzbijeosprdxpscxsx` (ap-south-1).

| What | Where | How far back | Data loss at worst |
|---|---|---|---|
| Database | Supabase daily backups (in the project); PITR from the second firm | 7 days | ≤ 24 h (≈ 2 min with PITR) |
| Database | `s3://<BACKUP_BUCKET>/db/<date>/<HHMM UTC>/` (dump, every 6 h) | 90 days | ≤ 6 h (selective recovery, see A.4) |
| Files (`documents` bucket) | `s3://<BACKUP_BUCKET>/storage/documents/…` | every file ever uploaded; old versions 90 days | files uploaded since the last run (≤ 6 h) |
| DSC encryption key | owner's password manager (releases README › DSC passwords) | — | without it, every stored DSC password is unreadable |

Not backed up here (rebuild from the repo and settings): Vercel env vars, Supabase Auth settings (SMTP, email templates, redirect URLs), AWS SES setup. Keep a copy of the prod env var list in the password manager.

## 1. AWS setup (once, owner)
Prefer a **separate AWS account** from the one that sends email, so one leaked key can't touch both.
1. **Bucket** `pulsebay-vault-prod-backup` (or similar) in **ap-south-1**, with **Object Lock enabled at creation** (it can't be turned on later; versioning comes with it).
   - Object Lock default retention: **Governance, 35 days**.
   - Block all public access: on. Default encryption: SSE-KMS (AWS managed key is fine).
   - Lifecycle: `db/` expire current versions after 90 days; whole bucket: expire **noncurrent** versions after 90 days. No expiry for current `storage/` objects.
2. **GitHub OIDC provider** in IAM: `token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
3. **Role** `vault-prod-backup-writer`, trust policy:
```json
{ "Version": "2012-10-17", "Statement": [{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:pulsebayai@341257753/CA-Document-Vault@1418560479:environment:prod-backup" } } }] }
```
   **Our organisation sends the ID-based subject** (owner and repository IDs after `@`), not `repo:pulsebayai/CA-Document-Vault:…`. The plain form fails with *Not authorized to perform sts:AssumeRoleWithWebIdentity* (first run, 2026-11-13). The IDs also stop a deleted-and-recreated repo of the same name from using the role. To read the exact subject GitHub sent: CloudTrail (ap-south-1) → **Event history** (no trail needed) → Event name `AssumeRoleWithWebIdentity` → event record → `userIdentity.userName`.
   Permissions policy (write and read only, never delete):
```json
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::<BUCKET>" },
  { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject"], "Resource": "arn:aws:s3:::<BUCKET>/*" },
  { "Effect": "Deny", "Action": ["s3:DeleteObject", "s3:DeleteObjectVersion", "s3:BypassGovernanceRetention",
      "s3:PutObjectRetention", "s3:PutBucket*", "s3:PutLifecycleConfiguration", "s3:DeleteBucket*"],
    "Resource": ["arn:aws:s3:::<BUCKET>", "arn:aws:s3:::<BUCKET>/*"] } ] }
```
   If the bucket uses a customer-managed KMS key, also allow `kms:GenerateDataKey` and `kms:Decrypt` on it.

## 2. GitHub setup (once, owner)
Repo → Settings → Environments → **New environment `prod-backup`**: deployment branches = `main` only; no reviewers (it runs at night).
- **Variables:** `BACKUP_BUCKET` = the bucket name · `PROD_PROJECT_REF` = `rryzbijeosprdxpscxsx` · `BACKUP_AWS_ROLE_ARN` = the role's ARN.
- **Secrets:**
  - `PROD_STORAGE_S3_KEY_ID`, `PROD_STORAGE_S3_SECRET`: Supabase prod → Storage → S3 → **New access key** (name it `github-backup`; revoke it there if it ever leaks).
  - `PROD_DB_URL`: Supabase prod → Connect → Connection String → Method **Session pooler** (or the transaction pooler string with port 6543 → **5432**). User `postgres.<ref>`, host `aws-N-ap-south-1.pooler.supabase.com` as shown, port 5432. Not the direct `db.<ref>.supabase.co` host: it is IPv6-only and GitHub's runners are IPv4.
    - The password is the **database password** (no prefix), not an `sb_secret_…` key. Special characters must be URL-encoded (`@` → `%40`, `#` → `%23`, `%` → `%25`, `/` → `%2F`, `:` → `%3A`, `?` → `%3F`, `&` → `%26`); an unencoded `@` gives *password authentication failed*. Prefer a generated password without them. Nothing in the app uses this password (checked 2026-11-14), so resetting it affects only this secret and hand-run tools.
- **Failure alerts:** a failed scheduled run emails the person who last changed the workflow's schedule. Make sure that is the owner (GitHub → Settings → Notifications → Actions: "Send notifications for failed workflows only").
- First run: Actions → Prod backup → Run workflow (on `main`). Expect two notices: the Storage object count and `db/<date>/<HHMM> (UTC) uploaded`.
- **Schedule is best-effort:** GitHub starts scheduled runs late or skips them under load (first 30 h: 4 runs instead of ≈ 6, at shifted times). Check the run list weekly; the worst gap so far was ≈ 9 h.

## 3. Restore

**Before any restore**
1. Tell Kushal Associates (and every firm) to stop work; note the time.
2. **Pause the `storage-sweep` cron** (Vercel → prod project → Settings → Cron Jobs → disable). It deletes Storage files that have no `document_version` row after 24 h; after a database restore, files uploaded after the restore point look exactly like that.
3. Pick the restore point **T** (just before the bad change). Write it in IST and UTC.

**A. Bad data or a bad migration (database only)** — the usual case.
1. Supabase prod → Database → Backups: restore the newest daily backup before T (with PITR: Point in Time → T). The project is down during the restore.
2. Run `psql "$PROD_DB_URL" -f scripts/restore-check.sql`. Section 2 must be empty; if not, run **file back-fill** (below).
3. Prod smoke: dispatch Regression with `target = prod` (smoke only, never data-writing tests).
4. **Pull back what the daily backup lost:** restore the newest dump taken before T into a throwaway project (C.2), list rows newer than the daily backup (`uploaded_at`, `created_at` columns on documents, versions, activity, custody), and copy the ones the firm confirms back into prod by hand (SQL insert through the normal functions where they exist). Files for those rows are already in Storage or the backup.
5. Re-enable the cron. Tell the firm exactly what was entered after the dump and must be entered again.
6. Record it in `sdlc/releases/R1/evidence/` (what, T, how long, what was lost).

**B. Files missing or damaged (database fine)**
- **File back-fill** from the machine of the owner (needs the Supabase S3 key and AWS read access to the bucket, incl. `s3:ListBucketVersions`, `s3:GetObjectVersion`):
```bash
export RCLONE_CONFIG_SRC_TYPE=s3 RCLONE_CONFIG_SRC_PROVIDER=Other RCLONE_CONFIG_SRC_REGION=ap-south-1 \
  RCLONE_CONFIG_SRC_FORCE_PATH_STYLE=true \
  RCLONE_CONFIG_SRC_ENDPOINT=https://rryzbijeosprdxpscxsx.storage.supabase.co/storage/v1/s3 \
  RCLONE_CONFIG_SRC_ACCESS_KEY_ID=... RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY=...
export RCLONE_CONFIG_DST_TYPE=s3 RCLONE_CONFIG_DST_PROVIDER=AWS RCLONE_CONFIG_DST_ENV_AUTH=true RCLONE_CONFIG_DST_REGION=ap-south-1
# Dry run first. --ignore-existing: never overwrite a file Storage still has. Files as they were at T:
rclone copy "dst:<BUCKET>/storage/documents" src:documents --ignore-existing \
  --s3-version-at "<T, e.g. 2026-11-20T10:00:00+05:30>" --dry-run -v
# then the same without --dry-run, then: psql "$PROD_DB_URL" -f scripts/restore-check.sql
```
  Drop `--s3-version-at` to restore the latest copies. For one document, add `--include "office/<office_id>/doc/<document_id>/**"`.

**C. Prod project lost (deleted, region outage, account problem)**
1. New Supabase project, **ap-south-1**, Pro, in the Pulsebay Ai org.
2. Download the newest `db/<date>/<HHMM>/` dump, gunzip, then (Supabase "Backup and restore using the CLI"):
```bash
psql --single-transaction --variable ON_ERROR_STOP=1 --file roles.sql --file schema.sql \
  --command 'SET session_replication_role = replica' --file data.sql --dbname "$NEW_DB_URL"
```
   **psql:** any client ≥ 17 (Postgres.app's 18 worked, drill 2026-11-15). Run from a stable machine: the drill took > 16 min the first time and the laptop connection dropped; use `caffeinate -i` on a Mac and add keepalives to the URL: `"$NEW_DB_URL?keepalives=1&keepalives_idle=30&keepalives_interval=10&keepalives_count=6"`. A dropped run commits nothing (one transaction), but its session can stay *idle in transaction* holding locks: end it before retrying (`select pg_terminate_backend(pid) from pg_stat_activity where state = 'idle in transaction';` on the **new** project).
   **Known fixes** (one transaction, so nothing is written until all pass):
   - `permission denied for parameter log_min_messages` (roles.sql) — Supabase's own `GRANT SET ON PARAMETER … TO "supabase_realtime_admin"`, present in every new project: `sed -i '' '/^GRANT SET ON PARAMETER/s/^/-- /' roles.sql` (Mac; `sed -i` on Linux). **Seen in the drill.**
   - `must be member of role "supabase_admin"` (schema.sql): `sed -i '' 's/^ALTER .* OWNER TO "supabase_admin";/-- &/' schema.sql`.
   - `permission denied to grant role "postgres"` (roles.sql): `sed -i '' 's/^GRANT "postgres" TO "cli_login_postgres".*/-- &/' roles.sql`. Re-apply any changes to the `auth`/`storage` schemas (our migrations add storage policies: replay `supabase/migrations` against a scratch project and diff with `scripts/schema-fingerprint.sql` if unsure).
3. Files: the back-fill (B) with `RCLONE_CONFIG_SRC_ENDPOINT` = the new project's S3 endpoint and a new S3 key; no `--s3-version-at` (latest copies).
4. Settings by hand: Auth SMTP (SES), email templates (invite, sign-in), site URL + redirect URLs, storage bucket limits (from the `documents` migration), PITR + compute add-ons.
5. Vercel prod env: new Supabase URL and keys; `DSC_ENC_KEYS` / `DSC_KEY_ID` **unchanged** (same key, from the password manager); `LINK_IP_SALT` unchanged. Redeploy.
6. `scripts/restore-check.sql`, compare counts with the last backup run's notice; prod smoke Regression; re-enable the cron; update the backup environment's `PROD_PROJECT_REF`, S3 key and DB URL.
7. Users: sign-in sessions from the old project are invalid; everyone signs in again (codes by email).

## 4. Restore drill (database part done 2026-11-15; files + timing again ≈ 23 Nov 2026, then monthly)
Last drill: `sdlc/releases/R1/evidence/restore-drill.md`.
Never restore into prod for a drill.
1. Create a throwaway project (ap-south-1). Restore the newest dump into it (C.2), and copy the files (C.3) into its `documents` bucket.
2. Run `scripts/restore-check.sql`; counts must match the backup run's notice and the dump date; section 2 empty.
3. Pick 3 documents at random; download each from the throwaway Storage and open it.
4. Time each step. Record in `sdlc/releases/R1/evidence/restore-drill.md`: date, dump date, counts, time to restore, problems found.
5. **Delete the throwaway project** (it holds real client data).
