-- Feature 15 — activity by document (spec AC-8, AC-9, U1, U2; plan step 3). Holds the schema lock.
--
-- K4 (re-measured 2026-11-01, 201,624 rows in one office): the document filter of 08's activity_feed ORed the entity
-- match with two `data` matches, so no index served it: ≈ 0.5 s for Staff (a scan of the office) and 19.8 s for
-- Limited (08's activity_select helper ran on every row of the office first).
--
-- Rule (architecture.md): "activity of a document" = a UNION ALL of one indexed lookup per reference kind, never an OR,
-- run in private.doc_activity_ids (definer, IDs only, own office) and read back under the viewer's RLS:
--   1. entity_type = 'document' and entity_id = <id>          activity_entity_idx (entity_id, id)   [chore, 25 Oct]
--   2. data->>'document_id' = <id>                              activity_doc_ref_idx (partial)          [new]
--   3. data->'document_ids' ? <id>                              activity_doc_ids_idx (partial GIN)      [new]
-- The branches exclude each other's rows, so no row appears twice. tests/unit/document-refs.test.ts lists the actions
-- whose data carries document_id / document_ids and fails on a new one.
--
-- activity_feed keeps its signature and output. It now picks the page's row IDs first, then shapes those rows with
-- 08's joins unchanged. Without a document filter the ID query is 08's filter text unchanged (same plan for /activity).
-- Rollback: re-run 08's body from 20261002120000_bulk_activity.sql, then drop document_last_activity,
-- private.doc_activity_ids and the two indexes.

create index if not exists activity_doc_ref_idx on public.activity ((data->>'document_id')) where data ? 'document_id';
create index if not exists activity_doc_ids_idx on public.activity using gin ((data->'document_ids')) where data ? 'document_ids';

-- The three lookups run in a SECURITY DEFINER helper that returns only activity row IDs (bigint), for the caller's
-- own office (checked first, from the session, never a parameter). Why: under RLS, Postgres evaluates the policy
-- before any condition built from non-leakproof functions (`->>`, jsonb `?`), so as an invoker query the two `data`
-- lookups can't use their indexes and 08's per-row visibility helper still ran on thousands of rows (Limited timed
-- out at 200k, plan step 3). The callers below then read those IDs back under the viewer's RLS (`id = any(…)`, the
-- primary key), so what a viewer sees is still decided by activity_select alone; an ID alone reveals nothing.
create or replace function private.doc_activity_ids(p_doc uuid)
returns bigint[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(x.id), '{}') from (
    select r.id from public.activity r
     where r.entity_id = p_doc::text and r.entity_type = 'document'
       and r.office_id = (select private.current_office_id())
    union all
    select r.id from public.activity r
     where r.data ? 'document_id' and r.data->>'document_id' = p_doc::text
       and not (r.entity_type = 'document' and r.entity_id = p_doc::text)
       and r.office_id = (select private.current_office_id())
    union all
    select r.id from public.activity r
     where r.data ? 'document_ids' and (r.data->'document_ids') ? p_doc::text
       and not (r.entity_type = 'document' and r.entity_id = p_doc::text)
       and (r.data->>'document_id') is distinct from p_doc::text
       and r.office_id = (select private.current_office_id())
  ) x
$$;
revoke all on function private.doc_activity_ids(uuid) from public;
grant execute on function private.doc_activity_ids(uuid) to authenticated;

create or replace function public.activity_feed(p jsonb)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_uuid      constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_date      constant text := '^\d{4}-\d{2}-\d{2}$';
  v_office    uuid := private.current_office_id();
  v_staff     uuid;
  v_client    uuid;
  v_doc       uuid;
  v_actions   text[];
  v_from      timestamptz;
  v_to        timestamptz;
  v_before_at timestamptz;
  v_before_id bigint;
  v_limit     integer := 50;
  v_ids       bigint[];
  v_rows      jsonb;
  v_n         integer;
begin
  if v_office is null then
    raise exception 'ROLE_REQUIRED: sign in as active staff' using errcode = '42501';
  end if;
  p := coalesce(p, '{}'::jsonb);
  if jsonb_typeof(p) <> 'object' then raise exception 'INVALID_FILTER: p' using errcode = '22023'; end if;

  if p ? 'staff_id' and p->>'staff_id' is not null then
    if p->>'staff_id' !~ v_uuid then raise exception 'INVALID_FILTER: staff_id' using errcode = '22023'; end if;
    v_staff := (p->>'staff_id')::uuid;
  end if;
  if p ? 'client_id' and p->>'client_id' is not null then
    if p->>'client_id' !~ v_uuid then raise exception 'INVALID_FILTER: client_id' using errcode = '22023'; end if;
    v_client := (p->>'client_id')::uuid;
  end if;
  if p ? 'document_id' and p->>'document_id' is not null then
    if p->>'document_id' !~ v_uuid then raise exception 'INVALID_FILTER: document_id' using errcode = '22023'; end if;
    v_doc := (p->>'document_id')::uuid;
  end if;
  if p ? 'actions' and jsonb_typeof(p->'actions') <> 'null' then
    if jsonb_typeof(p->'actions') <> 'array'
       or exists (select 1 from jsonb_array_elements(p->'actions') e where jsonb_typeof(e) <> 'string'
                                                                        or length(e #>> '{}') not between 1 and 64) then
      raise exception 'INVALID_FILTER: actions' using errcode = '22023';
    end if;
    select array_agg(e #>> '{}') into v_actions from jsonb_array_elements(p->'actions') e;
    v_actions := coalesce(v_actions, '{}');
  end if;
  if p ? 'from' and p->>'from' is not null then
    if p->>'from' !~ v_date then raise exception 'INVALID_FILTER: from' using errcode = '22023'; end if;
    v_from := (p->>'from')::date::timestamp at time zone 'Asia/Kolkata';
  end if;
  if p ? 'to' and p->>'to' is not null then
    if p->>'to' !~ v_date then raise exception 'INVALID_FILTER: to' using errcode = '22023'; end if;
    v_to := ((p->>'to')::date + 1)::timestamp at time zone 'Asia/Kolkata';
  end if;
  if p ? 'before' and jsonb_typeof(p->'before') <> 'null' then
    if jsonb_typeof(p->'before') <> 'object' or jsonb_typeof(p->'before'->'id') <> 'number'
       or coalesce(p->'before'->>'at', '') !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$' then
      raise exception 'INVALID_FILTER: before' using errcode = '22023';
    end if;
    v_before_at := (p->'before'->>'at')::timestamptz;
    v_before_id := (p->'before'->>'id')::bigint;
  end if;
  if p ? 'limit' and jsonb_typeof(p->'limit') <> 'null' then
    if jsonb_typeof(p->'limit') <> 'number' then raise exception 'INVALID_FILTER: limit' using errcode = '22023'; end if;
    v_limit := greatest(1, least(100, (p->>'limit')::numeric::integer));
  end if;

  -- 1. The page's row IDs (+ one, to know whether there is a next page).
  if v_doc is null then
    -- 08's filter, unchanged (the /activity page and client filter).
    select array_agg(x.id order by x.created_at desc, x.id desc) into v_ids from (
      select a.id, a.created_at
        from public.activity a
       where a.office_id = v_office
         and (v_staff is null or a.actor_id = v_staff)
         and ((v_actions is null and a.action <> 'auth.signed_in') or a.action = any(v_actions))
         and (v_from is null or a.created_at >= v_from)
         and (v_to is null or a.created_at < v_to)
         and (v_before_at is null or (a.created_at, a.id) < (v_before_at, v_before_id))
         and (v_client is null or private.activity_client(a.entity_type, a.entity_id, a.data) = v_client)
       order by a.created_at desc, a.id desc
       limit v_limit + 1) x;
  else
    -- 15 (K4): one indexed lookup per reference kind; only the document's own rows reach activity_select.
    select array_agg(x.id order by x.created_at desc, x.id desc) into v_ids from (
      select a.id, a.created_at
        from public.activity a
       where a.id = any(private.doc_activity_ids(v_doc))
         and a.office_id = v_office
         and (v_staff is null or a.actor_id = v_staff)
         and ((v_actions is null and a.action <> 'auth.signed_in') or a.action = any(v_actions))
         and (v_from is null or a.created_at >= v_from)
         and (v_to is null or a.created_at < v_to)
         and (v_before_at is null or (a.created_at, a.id) < (v_before_at, v_before_id))
         and (v_client is null or private.activity_client(a.entity_type, a.entity_id, a.data) = v_client)
       order by a.created_at desc, a.id desc
       limit v_limit + 1) x;
  end if;

  -- 2. Shape those rows: 08's joins and output, unchanged.
  with page as (
    select a.* from public.activity a where a.id = any(coalesce(v_ids, '{}'))
  ), shaped as (
    select pg.id, pg.created_at, pg.action, pg.entity_type, pg.entity_id, pg.data, pg.actor_id,
           private.activity_client(pg.entity_type, pg.entity_id, pg.data) as client_ref,
           case
             when pg.entity_type = 'document' and pg.entity_id ~ v_uuid then pg.entity_id::uuid
             when pg.data->>'document_id' ~ v_uuid then (pg.data->>'document_id')::uuid
           end as document_ref,
           case when pg.data->>'doc_type_id' ~ v_uuid then (pg.data->>'doc_type_id')::uuid end as type_ref
      from page pg
  ), joined as (
    select s.id, s.created_at, s.action, s.entity_type, s.entity_id, s.data, s.actor_id,
           st.full_name as actor_name, c.id as client_id, c.name as client_name,
           d.id as document_id, d.doc_code, t.name as doc_type_name, g.name as doc_group_name,
           row_number() over (order by s.created_at desc, s.id desc) as n
      from shaped s
      left join public.staff_user st on st.id = s.actor_id
      left join public.client c on c.id = s.client_ref
      left join public.document d on d.id = s.document_ref
      left join public.doc_type t on t.id = coalesce(d.doc_type_id, s.type_ref)
      left join public.doc_group g on g.id = t.doc_group_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', j.id, 'at', j.created_at, 'action', j.action, 'entity_type', j.entity_type, 'entity_id', j.entity_id,
           'data', j.data, 'actor_id', j.actor_id, 'actor_name', j.actor_name,
           'client_id', j.client_id, 'client_name', j.client_name,
           'document_id', j.document_id, 'doc_code', j.doc_code,
           'doc_type_name', j.doc_type_name, 'doc_group_name', j.doc_group_name) order by j.n)
           filter (where j.n <= v_limit), '[]'::jsonb),
         count(*)
    into v_rows, v_n
    from joined j;

  return jsonb_build_object(
    'rows', v_rows,
    'next', case when v_n > v_limit then jsonb_build_object('at', v_rows->(v_limit - 1)->'at', 'id', v_rows->(v_limit - 1)->'id') end);
end $$;

revoke all on function public.activity_feed(jsonb) from public, anon;
grant execute on function public.activity_feed(jsonb) to authenticated;

-- 15 (U2, AC-5, AC-9): the latest event the viewer may see, per document, for a page of ≤ 50 documents. The same
-- lookups as activity_feed (private.doc_activity_ids), LIMIT 1 each document; RLS (activity_select) decides what the viewer sees, so the
-- row is exactly the first one activity_feed shows for that document. Documents with no visible event are absent.
-- The type name is the document's own (it is the row's subject on the All documents tab), read under RLS.
create or replace function public.document_last_activity(p_ids uuid[])
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_office uuid := private.current_office_id();
  v_out    jsonb;
begin
  if v_office is null then
    raise exception 'ROLE_REQUIRED: sign in as active staff' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_ids), 0) > 50 then
    raise exception 'TOO_MANY: up to 50 documents at a time' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'document_id', d.id, 'id', l.id, 'at', l.created_at, 'action', l.action, 'entity_type', l.entity_type,
           'entity_id', l.entity_id, 'data', l.data, 'actor_id', l.actor_id, 'actor_name', st.full_name,
           'doc_type_name', t.name, 'doc_group_name', g.name)), '[]'::jsonb)
    into v_out
    from (select distinct x as id from unnest(coalesce(p_ids, '{}')) x) d
    cross join lateral (
      select a.id, a.created_at, a.action, a.entity_type, a.entity_id, a.data, a.actor_id
        from public.activity a
       where a.id = any(private.doc_activity_ids(d.id))
         and a.office_id = v_office and a.action <> 'auth.signed_in'
       order by a.created_at desc, a.id desc
       limit 1
    ) l
    left join public.staff_user st on st.id = l.actor_id
    left join public.document doc on doc.id = d.id
    left join public.doc_type t on t.id = doc.doc_type_id
    left join public.doc_group g on g.id = t.doc_group_id;
  return v_out;
end $$;

revoke all on function public.document_last_activity(uuid[]) from public, anon;
grant execute on function public.document_last_activity(uuid[]) to authenticated;
