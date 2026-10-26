-- Feature 10 step 11 — maintenance (spec "Privacy", "Reliability"; plan deviations: sweep moved to step 11).
--   1. link_attempt keeps 7 days: private.purge_link_attempts(), run daily by pg_cron ('link-attempts-daily',
--      19:00 UTC = 00:30 IST). The table holds hashed IPs only; rows are throttle evidence, not records.
--   2. orphan_objects: stored files in the documents bucket that no document_version points at (an upload whose
--      registration never happened — a closed tab, a refused link upload, a failed save in 03), older than
--      p_older_than_hours. Service role only. The server's storage sweep (/api/cron/storage-sweep, Vercel Cron)
--      removes them through the Storage API (storage.objects refuses SQL deletes). Covers 03's orphans too.

-- ── 1 ─────────────────────────────────────────────────────────────────────
create or replace function private.purge_link_attempts()
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from public.link_attempt where at < now() - interval '7 days';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function private.purge_link_attempts() from public, anon, authenticated;

-- Tests and the R1 checklist call it through the service role.
create or replace function public.purge_link_attempts()
returns integer language sql security definer set search_path = '' as $$ select private.purge_link_attempts() $$;
revoke all on function public.purge_link_attempts() from public, anon, authenticated;
grant execute on function public.purge_link_attempts() to service_role;

select cron.schedule('link-attempts-daily', '0 19 * * *', 'select private.purge_link_attempts()');

-- ── 2 ─────────────────────────────────────────────────────────────────────
create index if not exists link_attempt_at_idx on public.link_attempt (at);

-- p_office (optional) narrows the list to one office's files (tests; a per-office check before a sweep).
create or replace function public.orphan_objects(p_older_than_hours integer default 24, p_limit integer default 500,
  p_office uuid default null)
returns table (name text, created_at timestamptz) language sql stable security definer set search_path = '' as $$
  select o.name, o.created_at
    from storage.objects o
   where o.bucket_id = 'documents'
     and o.name ~ '^office/[0-9a-f-]{36}/doc/[0-9a-f-]{36}/[0-9a-f-]{36}\.[a-z]+$'
     and (p_office is null or o.name like 'office/' || p_office::text || '/%')
     and o.created_at < now() - make_interval(hours => greatest(coalesce(p_older_than_hours, 24), 0))
     and not exists (select 1 from public.document_version v where v.storage_path = o.name)
   order by o.created_at
   limit least(greatest(coalesce(p_limit, 500), 1), 1000)
$$;
revoke all on function public.orphan_objects(integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.orphan_objects(integer, integer, uuid) to service_role;
