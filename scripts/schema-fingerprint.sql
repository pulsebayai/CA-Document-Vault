-- Chore ci-speed step 0: a fingerprint of everything the app's migrations own, so a database rebuilt from
-- supabase/migrations/ can be compared with hosted dev (or staging) object by object.
-- One row per object: kind | name | md5 of its definition. Run the same file on both and diff the output.
-- Scope: schemas public + private, storage buckets and policies, pg_cron jobs, extensions. Not covered: auth
-- settings and hooks (dashboard config; check by hand on staging/prod). Platform-owned schemas
-- (auth, storage internals, realtime …) are left out: their versions differ between hosts by design.
with s as (select oid, nspname from pg_namespace where nspname in ('public', 'private'))
select kind, name, md5(def) as hash from (
  -- functions (definition incl. security/search_path/volatility) and their EXECUTE grants
  select 'function' kind, s.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' name,
         pg_get_functiondef(p.oid) def
  from pg_proc p join s on s.oid = p.pronamespace where p.prokind in ('f', 'p')
  union all
  select 'function_acl', s.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         coalesce((select string_agg(a::text, ',' order by a::text) from unnest(p.proacl) a), '<default>')
  from pg_proc p join s on s.oid = p.pronamespace where p.prokind in ('f', 'p')
  union all
  -- tables / views: kind, RLS flags, grants
  select 'relation', s.nspname || '.' || c.relname,
         c.relkind::text || ' rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity || ' acl=' ||
         coalesce((select string_agg(a::text, ',' order by a::text) from unnest(c.relacl) a), '<default>')
  from pg_class c join s on s.oid = c.relnamespace where c.relkind in ('r', 'p', 'v', 'm')
  union all
  select 'view', s.nspname || '.' || c.relname, pg_get_viewdef(c.oid)
  from pg_class c join s on s.oid = c.relnamespace where c.relkind in ('v', 'm')
  union all
  -- columns: type, nullability, default, generated, column grants
  select 'column', s.nspname || '.' || c.relname || '.' || a.attname,
         format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull || ' gen=' || a.attgenerated::text ||
         ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ' acl=' ||
         coalesce((select string_agg(x::text, ',' order by x::text) from unnest(a.attacl) x), '')
  from pg_attribute a join pg_class c on c.oid = a.attrelid join s on s.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attnum > 0 and not a.attisdropped and c.relkind in ('r', 'p', 'v', 'm')
  union all
  select 'constraint', s.nspname || '.' || c.relname || '.' || k.conname, pg_get_constraintdef(k.oid)
  from pg_constraint k join pg_class c on c.oid = k.conrelid join s on s.oid = c.relnamespace
  union all
  select 'index', s.nspname || '.' || i.relname, pg_get_indexdef(i.oid)
  from pg_index x join pg_class i on i.oid = x.indexrelid join s on s.oid = i.relnamespace
  union all
  select 'policy', s.nspname || '.' || c.relname || '.' || p.polname,
         p.polcmd::text || ' permissive=' || p.polpermissive || ' roles=' ||
         (select string_agg(coalesce(r.rolname, 'public'), ',' order by r.rolname) from unnest(p.polroles) pr left join pg_roles r on r.oid = pr) ||
         ' using=' || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' check=' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
  from pg_policy p join pg_class c on c.oid = p.polrelid join s on s.oid = c.relnamespace
  union all
  -- Storage policies: architecture.md requires none for app roles (files only via server-signed URLs), so any
  -- row here on staging/prod is a finding. Dev had none on 2026-10-27.
  select 'storage_policy', c.relname || '.' || p.polname,
         p.polcmd::text || ' roles=' || (select string_agg(coalesce(r.rolname, 'public'), ',' order by r.rolname) from unnest(p.polroles) pr left join pg_roles r on r.oid = pr) ||
         ' using=' || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' check=' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
  from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'storage'
  union all
  -- triggers on app tables, including app triggers on storage.objects / auth.users if any
  select 'trigger', n.nspname || '.' || c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  join pg_proc f on f.oid = t.tgfoid join pg_namespace fn on fn.oid = f.pronamespace
  where not t.tgisinternal and (n.nspname in ('public', 'private') or fn.nspname in ('public', 'private'))
  union all
  select 'type', s.nspname || '.' || t.typname,
         coalesce((select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid), t.typtype::text)
  from pg_type t join s on s.oid = t.typnamespace where t.typtype in ('e', 'd')
  union all
  select 'sequence', s.nspname || '.' || c.relname,
         coalesce((select string_agg(a::text, ',' order by a::text) from unnest(c.relacl) a), '<default>')
  from pg_class c join s on s.oid = c.relnamespace where c.relkind = 'S'
  union all
  select 'bucket', b.id, b.public::text || ' ' || coalesce(b.file_size_limit::text, '') || ' ' || coalesce(array_to_string(b.allowed_mime_types, ','), '')
  from storage.buckets b
  union all
  select 'cron', j.jobname, j.schedule || ' ' || j.command || ' active=' || j.active from cron.job j
  union all
  select 'extension', e.extname, n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace
) x
order by kind, name;
