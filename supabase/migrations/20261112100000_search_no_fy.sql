-- R1 feedback round 2 (Sankar, 2026-11-12): the FY filter offers "No financial year".
-- Replaces search_documents and search_document_facets (same signatures, bodies from 13's 20261031100100_custody_b)
-- with ONE change each: a new filter key `no_fy` (boolean) keeps only documents with no period, i.e. no financial year
-- (undated types and untagged documents; FY is derived from the period). `no_fy` and `fy_id` are exclusive: the app
-- never sends both; if both arrive, no row matches (a document with no period has no FY). An older caller that never
-- sends `no_fy` gets exactly the old result. Grants are unchanged by CREATE OR REPLACE.

-- ── search_documents ──
create or replace function public.search_documents(p jsonb)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  f          jsonb := coalesce(p->'filters', '{}'::jsonb);
  v_office   uuid := (select private.current_office_id());
  v_limited  boolean := (select private.has_role(array['limited']::public.staff_role[]));
  v_visible  uuid[];
  v_me       uuid := (select private.current_staff_id());
  v_words    text[];
  v_sort     text := coalesce(nullif(p->>'sort', ''), 'received');
  v_state    text := nullif(f->>'state', '');
  v_size     integer := least(greatest(coalesce((p->>'page_size')::integer, 50), 1), 50);
  v_page     integer := greatest(coalesce((p->>'page')::integer, 1), 1);
  v_archived boolean := coalesce((p->>'include_archived')::boolean, false);
  -- Filters (casts reject malformed values with a Postgres error).
  v_client   uuid := nullif(f->>'client_id', '')::uuid;
  v_group    uuid := nullif(f->>'group_id', '')::uuid;
  v_type     uuid := nullif(f->>'doc_type_id', '')::uuid;
  v_fy       uuid := nullif(f->>'fy_id', '')::uuid;
  v_no_fy    boolean := coalesce((f->>'no_fy')::boolean, false); -- R1 feedback round 2
  v_period   uuid := nullif(f->>'period_id', '')::uuid;
  v_reg      uuid := nullif(f->>'registration_id', '')::uuid;
  v_as       public.received_as := nullif(f->>'received_as', '')::public.received_as;
  v_channel  public.doc_channel := nullif(f->>'channel', '')::public.doc_channel;
  v_by       uuid := nullif(f->>'received_by', '')::uuid;
  v_from     date := nullif(f->>'from', '')::date;
  v_to       date := nullif(f->>'to', '')::date;
  v_status   public.document_status := nullif(f->>'status', '')::public.document_status;
  v_return   text := nullif(f->>'return', ''); -- 13: to_place | in_office | ready | dispatched (07: ready | dispatched)
  v_held     boolean := case when lower(coalesce(f->>'held', '')) in ('true', '1') then true end; -- 13
  v_today    date := (select private.office_today(private.current_office_id())); -- 13
  v_format   text := nullif(f->>'format', ''); -- 11: not_preferred
  v_ret      boolean := case when lower(coalesce(f->>'returnable', '')) in ('true', '1') then true end; -- 12
  v_result   jsonb;
begin
  if v_as = 'original' then v_as := 'hard_copy'; v_ret := true; end if; -- 12: legacy filter = hard copy + returnable
  if v_sort not in ('received', 'added', 'docid') then
    raise exception 'INVALID_SORT' using errcode = '22023';
  end if;
  if v_state is not null and v_state not in ('classified', 'inbox') then
    raise exception 'INVALID_FILTER: state' using errcode = '22023';
  end if;
  if v_return is not null and v_return not in ('to_place', 'in_office', 'ready', 'dispatched') then -- 13
    raise exception 'INVALID_FILTER: return' using errcode = '22023';
  end if;
  if v_format is not null and v_format <> 'not_preferred' then
    raise exception 'INVALID_FILTER: format' using errcode = '22023';
  end if;
  if v_office is null then
    return jsonb_build_object('total', 0, 'rows', '[]'::jsonb);
  end if;

  select (array_agg(left(w, 50) order by i))[1:5] into v_words
    from unnest(regexp_split_to_array(btrim(coalesce(p->>'text', '')), '\s+')) with ordinality as x(w, i)
   where w <> '';

  if v_limited then
    select coalesce(array_agg(c.id), '{}') into v_visible
      from public.client c where c.office_id = v_office and private.can_see_client(c.id);
  end if;

  with m as (
    select d.id, d.doc_code, d.fy_code, d.client_id, c.name as client_name, c.code as client_code,
           d.doc_type_id, t.name as type_name, t.doc_group_id as group_id, gr.name as group_name,
           d.period_id, pr.code as period_code, pr.label as period_label, d.registration_id,
           d.received_as, d.channel, d.received_on, d.received_by, s.full_name as received_by_name,
           d.status, d.remark, v.file_name, d.archived_at, d.created_at,
           d.reviewed_at, rv.full_name as reviewed_by_name, d.correction_reason,
           dp.dispatched_on, dp.method as dispatch_method,
           d.format_ok, d.format_preferred, -- 11: the badge
           d.returnable, d.correction_kind, -- 12
           private.custody_state(di.id is not null, d.archived_at is not null, d.client_id is not null and d.doc_type_id is not null,
                                 d.received_as, d.returnable, d.custody, d.status) as return_state, -- 13
           d.custody, d.in_office_at, -- 13
           private.custody_held(di.id is not null, d.archived_at is not null, d.returnable, d.custody, d.in_office_at, v_today) as held -- 13
      from public.document d
      left join public.document_version v on v.id = d.current_version_id
      left join public.client c           on c.id = d.client_id
      left join public.doc_type t         on t.id = d.doc_type_id
      left join public.doc_group gr       on gr.id = t.doc_group_id
      left join public.period pr          on pr.id = d.period_id
      left join public.staff_user s       on s.id = d.received_by
      left join public.staff_user rv      on rv.id = d.reviewed_by
      left join public.dispatch_item di   on di.document_id = d.id and di.removed_at is null
      left join public.dispatch dp        on dp.id = di.dispatch_id
     where d.office_id = v_office
       and (v_archived or d.archived_at is null)
       and (not v_limited or d.client_id is null or d.client_id = any (v_visible)
            or (d.doc_type_id is null and d.created_by = v_me))
       and (v_client is null  or d.client_id = v_client)
       and (v_ret is null     or d.returnable = v_ret) -- 12
       and (v_held is null    or private.custody_held(di.id is not null, d.archived_at is not null, d.returnable, d.custody,
                                                      d.in_office_at, v_today)) -- 13
       and (v_group is null   or t.doc_group_id = v_group)
       and (v_type is null    or d.doc_type_id = v_type)
       and (v_fy is null      or pr.financial_year_id = v_fy)
       and (not v_no_fy       or d.period_id is null) -- R1 feedback round 2
       and (v_period is null  or d.period_id = v_period)
       and (v_reg is null     or d.registration_id = v_reg)
       and (v_as is null      or d.received_as = v_as)
       and (v_channel is null or d.channel = v_channel)
       and (v_by is null      or d.received_by = v_by)
       and (v_from is null    or d.received_on >= v_from)
       and (v_to is null      or d.received_on <= v_to)
       and (v_status is null  or d.status = v_status)
       and (v_format is null  or d.format_ok = false) -- 11
       and (v_state is null
            or (v_state = 'classified' and d.client_id is not null and d.doc_type_id is not null)
            or (v_state = 'inbox' and (d.client_id is null or d.doc_type_id is null)))
       and not exists (
         select 1 from unnest(coalesce(v_words, '{}')) as w(word)
          cross join lateral (select replace(replace(replace(w.word, '\', '\\'), '%', '\%'), '_', '\_') as e) q
          where not (coalesce(d.remark, '') ilike '%' || q.e || '%'
                     or coalesce(v.file_name, '') ilike '%' || q.e || '%'
                     or d.doc_code ilike q.e || '%'))
  ), ranked as (
    select m.*, count(*) over () as total,
           row_number() over (order by
             case when v_sort = 'received' then m.received_on end desc nulls last,
             case when v_sort = 'docid' then m.fy_code end desc,
             case when v_sort = 'docid' then (regexp_replace(m.doc_code, '^.*-', ''))::bigint end desc,
             m.created_at desc, m.id) as rn
      from m
     where (v_return is null or m.return_state = v_return)
  )
  select jsonb_build_object(
           'total', coalesce(max(r.total), 0),
           'rows', coalesce(jsonb_agg(to_jsonb(r) - 'total' - 'rn' - 'fy_code' order by r.rn)
                              filter (where r.rn > (v_page - 1) * v_size and r.rn <= v_page * v_size), '[]'::jsonb))
    into v_result
    from ranked r;
  return v_result;
end $$;

-- ── search_document_facets ──
create or replace function public.search_document_facets(p jsonb)
returns table (facet text, value text, label text, n integer)
language plpgsql stable security invoker set search_path = '' as $$
declare
  f          jsonb := coalesce(p->'filters', '{}'::jsonb);
  v_office   uuid := (select private.current_office_id());
  v_limited  boolean := (select private.has_role(array['limited']::public.staff_role[]));
  v_visible  uuid[];
  v_me       uuid := (select private.current_staff_id());
  v_words    text[];
  v_state    text := nullif(f->>'state', '');
  v_archived boolean := coalesce((p->>'include_archived')::boolean, false);
  v_client   uuid := nullif(f->>'client_id', '')::uuid;
  v_group    uuid := nullif(f->>'group_id', '')::uuid;
  v_type     uuid := nullif(f->>'doc_type_id', '')::uuid;
  v_fy       uuid := nullif(f->>'fy_id', '')::uuid;
  v_no_fy    boolean := coalesce((f->>'no_fy')::boolean, false); -- R1 feedback round 2
  v_period   uuid := nullif(f->>'period_id', '')::uuid;
  v_reg      uuid := nullif(f->>'registration_id', '')::uuid;
  v_as       public.received_as := nullif(f->>'received_as', '')::public.received_as;
  v_channel  public.doc_channel := nullif(f->>'channel', '')::public.doc_channel;
  v_by       uuid := nullif(f->>'received_by', '')::uuid;
  v_from     date := nullif(f->>'from', '')::date;
  v_to       date := nullif(f->>'to', '')::date;
  v_status   public.document_status := nullif(f->>'status', '')::public.document_status;
  v_return   text := nullif(f->>'return', ''); -- 13: to_place | in_office | ready | dispatched (07: ready | dispatched)
  v_held     boolean := case when lower(coalesce(f->>'held', '')) in ('true', '1') then true end; -- 13
  v_today    date := (select private.office_today(private.current_office_id())); -- 13
  v_format   text := nullif(f->>'format', ''); -- 11: not_preferred
  v_ret      boolean := case when lower(coalesce(f->>'returnable', '')) in ('true', '1') then true end; -- 12
begin
  if v_as = 'original' then v_as := 'hard_copy'; v_ret := true; end if; -- 12: legacy filter = hard copy + returnable
  if v_state is not null and v_state not in ('classified', 'inbox') then
    raise exception 'INVALID_FILTER: state' using errcode = '22023';
  end if;
  if v_return is not null and v_return not in ('to_place', 'in_office', 'ready', 'dispatched') then -- 13
    raise exception 'INVALID_FILTER: return' using errcode = '22023';
  end if;
  if v_format is not null and v_format <> 'not_preferred' then
    raise exception 'INVALID_FILTER: format' using errcode = '22023';
  end if;
  if v_office is null then
    return;
  end if;

  select (array_agg(left(w, 50) order by i))[1:5] into v_words
    from unnest(regexp_split_to_array(btrim(coalesce(p->>'text', '')), '\s+')) with ordinality as x(w, i)
   where w <> '';

  if v_limited then
    select coalesce(array_agg(c.id), '{}') into v_visible
      from public.client c where c.office_id = v_office and private.can_see_client(c.id);
  end if;

  return query
  with m as (
    select t.doc_group_id as group_id, d.received_as, d.channel, d.received_by, d.status, d.format_ok,
           private.custody_state(di.id is not null, d.archived_at is not null, d.client_id is not null and d.doc_type_id is not null,
                                 d.received_as, d.returnable, d.custody, d.status) as return_state, -- 13
           d.custody, d.in_office_at, -- 13
           private.custody_held(di.id is not null, d.archived_at is not null, d.returnable, d.custody, d.in_office_at, v_today) as held, -- 13
           (v_group is null   or t.doc_group_id = v_group) as ok_group,
           (v_as is null      or d.received_as = v_as)     as ok_as,
           (v_channel is null or d.channel = v_channel)    as ok_channel,
           (v_by is null      or d.received_by = v_by)     as ok_by,
           (v_status is null  or d.status = v_status)      as ok_status,
           (v_return is null  or private.custody_state(di.id is not null, d.archived_at is not null,
                d.client_id is not null and d.doc_type_id is not null, d.received_as, d.returnable, d.custody, d.status) = v_return) as ok_return, -- 13
           (v_format is null  or d.format_ok = false)      as ok_format -- 11
      from public.document d
      left join public.document_version v on v.id = d.current_version_id
      left join public.doc_type t         on t.id = d.doc_type_id
      left join public.period pr          on pr.id = d.period_id
      left join public.dispatch_item di   on di.document_id = d.id and di.removed_at is null
     where d.office_id = v_office
       and (v_archived or d.archived_at is null)
       and (not v_limited or d.client_id is null or d.client_id = any (v_visible)
            or (d.doc_type_id is null and d.created_by = v_me))
       and (v_client is null  or d.client_id = v_client)
       and (v_ret is null     or d.returnable = v_ret) -- 12
       and (v_held is null    or private.custody_held(di.id is not null, d.archived_at is not null, d.returnable, d.custody,
                                                      d.in_office_at, v_today)) -- 13
       and (v_type is null    or d.doc_type_id = v_type)
       and (v_fy is null      or pr.financial_year_id = v_fy)
       and (not v_no_fy       or d.period_id is null) -- R1 feedback round 2
       and (v_period is null  or d.period_id = v_period)
       and (v_reg is null     or d.registration_id = v_reg)
       and (v_from is null    or d.received_on >= v_from)
       and (v_to is null      or d.received_on <= v_to)
       and (v_state is null
            or (v_state = 'classified' and d.client_id is not null and d.doc_type_id is not null)
            or (v_state = 'inbox' and (d.client_id is null or d.doc_type_id is null)))
       and not exists (
         select 1 from unnest(coalesce(v_words, '{}')) as w(word)
          cross join lateral (select replace(replace(replace(w.word, '\', '\\'), '%', '\%'), '_', '\_') as e) q
          where not (coalesce(d.remark, '') ilike '%' || q.e || '%'
                     or coalesce(v.file_name, '') ilike '%' || q.e || '%'
                     or d.doc_code ilike q.e || '%'))
  ), counts as (
    select 'group'::text as facet, m.group_id::text as value, count(*)::integer as n from m
     where m.group_id is not null and m.ok_as and m.ok_channel and m.ok_by and m.ok_status and m.ok_return and m.ok_format group by m.group_id
    union all
    select 'received_as', m.received_as::text, count(*)::integer from m
     where m.ok_group and m.ok_channel and m.ok_by and m.ok_status and m.ok_return and m.ok_format group by m.received_as
    union all
    select 'channel', m.channel::text, count(*)::integer from m
     where m.ok_group and m.ok_as and m.ok_by and m.ok_status and m.ok_return and m.ok_format group by m.channel
    union all
    select 'received_by', m.received_by::text, count(*)::integer from m
     where m.ok_group and m.ok_as and m.ok_channel and m.ok_status and m.ok_return and m.ok_format group by m.received_by
    union all
    select 'status', m.status::text, count(*)::integer from m
     where m.ok_group and m.ok_as and m.ok_channel and m.ok_by and m.ok_return and m.ok_format group by m.status
    union all
    select 'return', m.return_state, count(*)::integer from m
     where m.return_state is not null and m.ok_group and m.ok_as and m.ok_channel and m.ok_by and m.ok_status and m.ok_format
     group by m.return_state
    union all
    -- 11 (spec AC-21): flagged documents; hidden at 0 like every facet value.
    select 'format', 'not_preferred', count(*)::integer from m
     where m.format_ok = false and m.ok_group and m.ok_as and m.ok_channel and m.ok_by and m.ok_status and m.ok_return
    having count(*) > 0
  )
  select c.facet, c.value,
         case c.facet
           when 'group' then (select g.name from public.doc_group g where g.id = c.value::uuid)
           when 'received_by' then (select s.full_name || case when s.status = 'deactivated' then ' (inactive)' else '' end
                                      from public.staff_user s where s.id = c.value::uuid)
           else c.value
         end,
         c.n
    from counts c
   order by c.facet, c.n desc, c.value;
end $$;
