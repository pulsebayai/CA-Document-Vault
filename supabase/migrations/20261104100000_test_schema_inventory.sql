-- Feature 18 (spec X1, AC-2, AC-3): the database's own list of what a cross-firm test must cover.
-- Names, kinds and flags only — never row data. Service role only (like 04's expected_job_info), read by
-- tests/rls/cross-firm/guard.test.ts, which fails when an object here has no case in coverage.ts.

create or replace function public.test_schema_inventory()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'tables', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', c.relname,
        'rls', c.relrowsecurity,
        'office_id', exists (select 1 from pg_catalog.pg_attribute a
                              where a.attrelid = c.oid and a.attname = 'office_id' and not a.attisdropped),
        'policies', (select coalesce(jsonb_agg(distinct p.cmd order by p.cmd), '[]'::jsonb)
                       from pg_catalog.pg_policies p where p.schemaname = 'public' and p.tablename = c.relname),
        'anon', pg_catalog.has_table_privilege('anon', c.oid, 'select,insert,update,delete'),
        -- columns staff (authenticated) may write, so cross-firm inserts and updates are built from writable columns only
        'insert_cols', (select coalesce(jsonb_agg(a.attname order by a.attnum), '[]'::jsonb) from pg_catalog.pg_attribute a
                         where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                           and pg_catalog.has_column_privilege('authenticated', c.oid, a.attnum, 'insert')),
        'update_cols', (select coalesce(jsonb_agg(a.attname order by a.attnum), '[]'::jsonb) from pg_catalog.pg_attribute a
                         where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                           and pg_catalog.has_column_privilege('authenticated', c.oid, a.attnum, 'update')),
        'fks', (select coalesce(jsonb_agg(jsonb_build_object(
                    'columns', (select jsonb_agg(a.attname order by k.ord)
                                  from unnest(f.conkey) with ordinality k(attnum, ord)
                                  join pg_catalog.pg_attribute a on a.attrelid = f.conrelid and a.attnum = k.attnum),
                    'references', r.relname) order by f.conname), '[]'::jsonb)
                  from pg_catalog.pg_constraint f
                  join pg_catalog.pg_class r on r.oid = f.confrelid
                  join pg_catalog.pg_namespace rn on rn.oid = r.relnamespace
                 where f.conrelid = c.oid and f.contype = 'f' and rn.nspname = 'public')
      ) order by c.relname), '[]'::jsonb)
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
    ),
    'views', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', c.relname,
        'security_invoker', coalesce('security_invoker=true' = any (c.reloptions), false),
        'anon', pg_catalog.has_table_privilege('anon', c.oid, 'select')
      ) order by c.relname), '[]'::jsonb)
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('v', 'm')
    ),
    'functions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'schema', n.nspname,
        'name', p.proname,
        'args', pg_catalog.pg_get_function_identity_arguments(p.oid),
        'definer', p.prosecdef,
        'trigger', p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype,
        'anon', pg_catalog.has_function_privilege('anon', p.oid, 'execute'),
        'authenticated', pg_catalog.has_function_privilege('authenticated', p.oid, 'execute'),
        'service_role', pg_catalog.has_function_privilege('service_role', p.oid, 'execute')
      ) order by n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)), '[]'::jsonb)
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private') and p.prokind = 'f'
       -- objects owned by an extension (none in public/private today) are not ours to cover
       and not exists (select 1 from pg_catalog.pg_depend d where d.objid = p.oid and d.deptype = 'e')
       -- public functions callable by nobody but the owner, and private non-definer helpers, run only inside
       -- covered callers with the caller's rights; the guard lists definers + everything an app role can call
       and (p.prosecdef or (n.nspname = 'public' and (
             pg_catalog.has_function_privilege('anon', p.oid, 'execute')
          or pg_catalog.has_function_privilege('authenticated', p.oid, 'execute')
          or pg_catalog.has_function_privilege('service_role', p.oid, 'execute'))))
    ),
    'realtime', (
      select coalesce(jsonb_agg(t.tablename order by t.tablename), '[]'::jsonb)
        from pg_catalog.pg_publication_tables t where t.pubname = 'supabase_realtime'
    ),
    'storage', jsonb_build_object(
      'policies', (select count(*) from pg_catalog.pg_policies p where p.schemaname = 'storage'),
      'public_buckets', (select coalesce(jsonb_agg(b.id order by b.id), '[]'::jsonb) from storage.buckets b where b.public)
    )
  )
$$;

revoke all on function public.test_schema_inventory() from public, anon, authenticated;
grant execute on function public.test_schema_inventory() to service_role;

-- Found by the inventory on its first run (plan Deviations D1): six of 02's private trigger functions still carry
-- PostgreSQL's default EXECUTE for PUBLIC. A trigger function can't be called directly and `private` isn't exposed by
-- PostgREST, so nothing was reachable; revoked anyway so the guard's "no anon-executable function" rule holds without
-- an exception. Firing a trigger doesn't check EXECUTE, so behaviour is unchanged.
revoke all on function private.client_before_write(), private.client_doc_type_before_write(),
  private.client_group_before_write(), private.contact_before_write(), private.doc_type_before_write(),
  private.registration_before_write() from public, anon, authenticated;
