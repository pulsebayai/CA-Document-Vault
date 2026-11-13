-- chore prod-backups (2026-11-13): run on a database right after a restore (PITR, daily backup or a dump
-- restored into a new project), with psql or the SQL editor. Read-only. Lists what the runbook's file
-- back-fill must fix and the counts to record in the restore record.
-- Usage: psql "$DB_URL" -f scripts/restore-check.sql

-- 1. Counts to compare with the source (or with the last backup run's notice).
select 'offices' as what, count(*) from public.office
union all select 'clients', count(*) from public.client
union all select 'documents', count(*) from public.document
union all select 'document versions', count(*) from public.document_version
union all select 'storage objects (documents bucket)', count(*) from storage.objects where bucket_id = 'documents'
union all select 'auth users', count(*) from auth.users
order by 1;

-- 2. Document versions whose file Storage does not know about. Expected 0. Any row here: run the runbook's
--    file back-fill (copy from the backup with --ignore-existing), then run this file again.
select v.office_id, v.document_id, v.id as version_id, v.storage_path, v.uploaded_at
  from public.document_version v
 where not exists (select 1 from storage.objects o where o.bucket_id = 'documents' and o.name = v.storage_path)
 order by v.uploaded_at;

-- 3. Newest activity: the restore point actually reached (compare with the target time).
select max(uploaded_at) as newest_document_version from public.document_version;
