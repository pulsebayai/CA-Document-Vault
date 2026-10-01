-- Feature 04 step 7 (deviation D5) — Clients list: overdue / due-today counts per client and the "Has overdue"
-- filter (spec AC-15, mockup 03). Schema lock: 04.
--
-- public.search_clients (02; also called by 03b with p_query, p_limit, p_offset) gains:
--   * input  p_has_overdue boolean default false — only clients with at least one overdue item;
--   * output overdue bigint, due_today bigint (before total).
-- Adding a parameter and output columns changes the signature, so the function is dropped and re-created (same
-- body otherwise, still SECURITY INVOKER, search_path = '', same grants). Every existing call uses named
-- arguments with defaults, so 02's and 03b's calls keep working.
--
-- Counts follow the screens (src/lib/expected/shape.ts + schedule.ts):
--   pending items whose plan row and group are not paused (paused = On hold, not counted);
--   overdue   = office today >= overdue_from;
--   due today = office today  = overdue_from - 1 (the "due by" date).
-- "Today" is private.office_today(office): the date in India, or the test clock in an is_test office (D1).
-- expected_doc RLS (can_see_client) applies, so a Limited user only ever counts items of clients they can see.
-- Index used: expected_doc (client_id, status) from 20260930120658_expected_docs.

drop function public.search_clients(text, public.client_type, uuid, boolean, integer, integer);

create function public.search_clients(
  p_query text default null,
  p_client_type public.client_type default null,
  p_incharge_id uuid default null,
  p_include_archived boolean default false,
  p_limit integer default 50,
  p_offset integer default 0,
  p_has_overdue boolean default false
)
returns table (
  id uuid, code text, name text, client_type public.client_type, pan text, incharge_id uuid, incharge_name text,
  groups text[], paused_groups text[], archived boolean, overdue bigint, due_today bigint, total bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select nullif(btrim(coalesce(p_query, '')), '') as t
  ), p as (
    select t,
      '%' || replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat,
      nullif(regexp_replace(upper(coalesce(t, '')), '[^A-Z0-9]', '', 'g'), '') as ident
    from q
  ), d as (
    select private.office_today((select private.current_office_id())) as today
  )
  select c.id, c.code, c.name, c.client_type, c.pan, c.incharge_id, s.full_name,
    coalesce((select array_agg(g.name order by g.sort, g.name) from public.client_group cg
                join public.doc_group g on g.id = cg.doc_group_id
               where cg.client_id = c.id and cg.state = 'active'), '{}'),
    coalesce((select array_agg(g.name order by g.sort, g.name) from public.client_group cg
                join public.doc_group g on g.id = cg.doc_group_id
               where cg.client_id = c.id and cg.state = 'paused'), '{}'),
    c.archived_at is not null,
    x.overdue,
    x.due_today,
    count(*) over ()
  from public.client c
  join public.staff_user s on s.id = c.incharge_id
  cross join p
  cross join d
  cross join lateral (
    select count(*) filter (where e.overdue_from <= d.today) as overdue,
           count(*) filter (where e.overdue_from = d.today + 1) as due_today
      from public.expected_doc e
      join public.client_doc_type r on r.id = e.client_doc_type_id
      join public.client_group g on g.id = r.client_group_id
     where e.client_id = c.id
       and e.status = 'pending'
       and r.state <> 'paused'
       and g.state <> 'paused'
  ) x
  where c.office_id = (select private.current_office_id())
    and (p_include_archived or c.archived_at is null)
    and (p_client_type is null or c.client_type = p_client_type)
    and (p_incharge_id is null or c.incharge_id = p_incharge_id)
    and (not coalesce(p_has_overdue, false) or x.overdue > 0)
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

revoke all on function public.search_clients(text, public.client_type, uuid, boolean, integer, integer, boolean) from public, anon;
grant execute on function public.search_clients(text, public.client_type, uuid, boolean, integer, integer, boolean) to authenticated;
