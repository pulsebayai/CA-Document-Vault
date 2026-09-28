-- 02 step 7: Clients list search (spec AC-7, AC-12, NFR performance).
-- One SECURITY INVOKER function so RLS decides visibility (Limited users see only their clients), search
-- text travels in the POST body (never the URL), and user input is never spliced into a PostgREST filter.
-- Matches name / previous reference / code (case-insensitive, partial) and PAN / GSTIN (identifier
-- characters only, partial). LIKE wildcards in the input are escaped, so "%" matches a literal percent.
create or replace function public.search_clients(
  p_query            text    default null,
  p_client_type      public.client_type default null,
  p_incharge_id      uuid    default null,
  p_include_archived boolean default false,
  p_limit            integer default 50,
  p_offset           integer default 0)
returns table (
  id uuid, code text, name text, client_type public.client_type, pan text,
  incharge_id uuid, incharge_name text, groups text[], paused_groups text[], archived boolean, total bigint)
language sql stable security invoker set search_path = '' as $$
  with q as (
    select nullif(btrim(coalesce(p_query, '')), '') as t
  ), p as (
    select t,
      '%' || replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat,
      nullif(regexp_replace(upper(coalesce(t, '')), '[^A-Z0-9]', '', 'g'), '') as ident
    from q
  )
  select c.id, c.code, c.name, c.client_type, c.pan, c.incharge_id, s.full_name,
    coalesce((select array_agg(g.name order by g.sort, g.name) from public.client_group cg
                join public.doc_group g on g.id = cg.doc_group_id
               where cg.client_id = c.id and cg.state = 'active'), '{}'),
    coalesce((select array_agg(g.name order by g.sort, g.name) from public.client_group cg
                join public.doc_group g on g.id = cg.doc_group_id
               where cg.client_id = c.id and cg.state = 'paused'), '{}'),
    c.archived_at is not null,
    count(*) over ()
  from public.client c
  join public.staff_user s on s.id = c.incharge_id
  cross join p
  where c.office_id = (select private.current_office_id())
    and (p_include_archived or c.archived_at is null)
    and (p_client_type is null or c.client_type = p_client_type)
    and (p_incharge_id is null or c.incharge_id = p_incharge_id)
    and (p.t is null
      or c.name ilike p.pat
      or c.previous_reference ilike p.pat
      or c.code ilike p.pat
      or (p.ident is not null and (
            c.pan like '%' || p.ident || '%'
         or exists (select 1 from public.client_registration r
                     where r.client_id = c.id and r.number like '%' || p.ident || '%'))))
  order by c.archived_at is not null, lower(c.name), c.code
  limit least(greatest(coalesce(p_limit, 50), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.search_clients(text, public.client_type, uuid, boolean, integer, integer) from public, anon;
grant execute on function public.search_clients(text, public.client_type, uuid, boolean, integer, integer) to authenticated;
