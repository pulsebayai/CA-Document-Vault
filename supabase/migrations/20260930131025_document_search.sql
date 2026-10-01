-- 03b step 2: document search (spec AC-5…AC-11).
-- Read-only migration exception (Raja 2026-09-29, option A): this migration adds exactly two SECURITY INVOKER
-- functions. It creates or alters no table, column, policy, trigger or existing function, so it can be applied
-- while 04 holds the schema lock and replays on staging/prod in any order relative to 04's migrations.
--
-- Both functions:
--   * run as the caller (SECURITY INVOKER), so RLS on document / client / staff_user decides what is visible;
--   * take one jsonb argument (text travels in the POST body, never a URL) and bind every value — the user's text
--     is only ever an ILIKE operand, with \ % _ escaped;
--   * for Limited users, add `client_id = any(<clients the user can see>)` on top of RLS, so the planner can use
--     the client index instead of evaluating can_see_client per document (RLS stays the enforcement);
--   * write nothing (no activity; STABLE).
--   * treat a missing remark or file (hard copy) as '' — a NULL ILIKE would otherwise make "no word fails" true.
-- The input parsing and the matching predicate are written out in both functions on purpose: the exception
-- allows no shared helper. The RLS test "each facet count equals the number of results" keeps them in step.
--
-- Input (all keys optional):
--   text              split on whitespace → first 5 words, each cut to 50 chars; every word must match (AND) the
--                     remark or the current file name (partial) or the DOC-ID (prefix) — case-insensitive (OR)
--   filters           client_id, group_id, doc_type_id, fy_id, period_id, registration_id, received_as, channel,
--                     received_by, from, to (received_on, inclusive), status, state ('classified' | 'inbox')
--   include_archived  default false
--   sort              'received' (default) | 'added' | 'docid'  ·  page (1-based)  ·  page_size (1–50, default 50)

-- ── Results ─────────────────────────────────────────────────────────────────
create or replace function public.search_documents(p jsonb)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  f          jsonb := coalesce(p->'filters', '{}'::jsonb);
  v_office   uuid := (select private.current_office_id());
  v_limited  boolean := (select private.has_role(array['limited']::public.staff_role[]));
  v_visible  uuid[];
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
  v_period   uuid := nullif(f->>'period_id', '')::uuid;
  v_reg      uuid := nullif(f->>'registration_id', '')::uuid;
  v_as       public.received_as := nullif(f->>'received_as', '')::public.received_as;
  v_channel  public.doc_channel := nullif(f->>'channel', '')::public.doc_channel;
  v_by       uuid := nullif(f->>'received_by', '')::uuid;
  v_from     date := nullif(f->>'from', '')::date;
  v_to       date := nullif(f->>'to', '')::date;
  v_status   public.document_status := nullif(f->>'status', '')::public.document_status;
  v_result   jsonb;
begin
  if v_sort not in ('received', 'added', 'docid') then
    raise exception 'INVALID_SORT' using errcode = '22023';
  end if;
  if v_state is not null and v_state not in ('classified', 'inbox') then
    raise exception 'INVALID_FILTER: state' using errcode = '22023';
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
           d.status, d.remark, v.file_name, d.archived_at, d.created_at
      from public.document d
      left join public.document_version v on v.id = d.current_version_id
      left join public.client c           on c.id = d.client_id
      left join public.doc_type t         on t.id = d.doc_type_id
      left join public.doc_group gr       on gr.id = t.doc_group_id
      left join public.period pr          on pr.id = d.period_id
      left join public.staff_user s       on s.id = d.received_by
     where d.office_id = v_office
       and (v_archived or d.archived_at is null)
       and (not v_limited or d.client_id is null or d.client_id = any (v_visible))
       and (v_client is null  or d.client_id = v_client)
       and (v_group is null   or t.doc_group_id = v_group)
       and (v_type is null    or d.doc_type_id = v_type)
       and (v_fy is null      or pr.financial_year_id = v_fy)
       and (v_period is null  or d.period_id = v_period)
       and (v_reg is null     or d.registration_id = v_reg)
       and (v_as is null      or d.received_as = v_as)
       and (v_channel is null or d.channel = v_channel)
       and (v_by is null      or d.received_by = v_by)
       and (v_from is null    or d.received_on >= v_from)
       and (v_to is null      or d.received_on <= v_to)
       and (v_status is null  or d.status = v_status)
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
  )
  select jsonb_build_object(
           'total', coalesce(max(r.total), 0),
           'rows', coalesce(jsonb_agg(to_jsonb(r) - 'total' - 'rn' - 'fy_code' order by r.rn)
                              filter (where r.rn > (v_page - 1) * v_size and r.rn <= v_page * v_size), '[]'::jsonb))
    into v_result
    from ranked r;
  return v_result;
end $$;

-- ── Facets ──────────────────────────────────────────────────────────────────
-- (facet, value, label, n) for group · received_as · channel · received_by · status. A facet counts the visible
-- documents that match the text and every filter except its own; values with no documents are not returned.
create or replace function public.search_document_facets(p jsonb)
returns table (facet text, value text, label text, n integer)
language plpgsql stable security invoker set search_path = '' as $$
declare
  f          jsonb := coalesce(p->'filters', '{}'::jsonb);
  v_office   uuid := (select private.current_office_id());
  v_limited  boolean := (select private.has_role(array['limited']::public.staff_role[]));
  v_visible  uuid[];
  v_words    text[];
  v_state    text := nullif(f->>'state', '');
  v_archived boolean := coalesce((p->>'include_archived')::boolean, false);
  v_client   uuid := nullif(f->>'client_id', '')::uuid;
  v_group    uuid := nullif(f->>'group_id', '')::uuid;
  v_type     uuid := nullif(f->>'doc_type_id', '')::uuid;
  v_fy       uuid := nullif(f->>'fy_id', '')::uuid;
  v_period   uuid := nullif(f->>'period_id', '')::uuid;
  v_reg      uuid := nullif(f->>'registration_id', '')::uuid;
  v_as       public.received_as := nullif(f->>'received_as', '')::public.received_as;
  v_channel  public.doc_channel := nullif(f->>'channel', '')::public.doc_channel;
  v_by       uuid := nullif(f->>'received_by', '')::uuid;
  v_from     date := nullif(f->>'from', '')::date;
  v_to       date := nullif(f->>'to', '')::date;
  v_status   public.document_status := nullif(f->>'status', '')::public.document_status;
begin
  if v_state is not null and v_state not in ('classified', 'inbox') then
    raise exception 'INVALID_FILTER: state' using errcode = '22023';
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
    select t.doc_group_id as group_id, d.received_as, d.channel, d.received_by, d.status,
           (v_group is null   or t.doc_group_id = v_group) as ok_group,
           (v_as is null      or d.received_as = v_as)     as ok_as,
           (v_channel is null or d.channel = v_channel)    as ok_channel,
           (v_by is null      or d.received_by = v_by)     as ok_by,
           (v_status is null  or d.status = v_status)      as ok_status
      from public.document d
      left join public.document_version v on v.id = d.current_version_id
      left join public.doc_type t         on t.id = d.doc_type_id
      left join public.period pr          on pr.id = d.period_id
     where d.office_id = v_office
       and (v_archived or d.archived_at is null)
       and (not v_limited or d.client_id is null or d.client_id = any (v_visible))
       and (v_client is null  or d.client_id = v_client)
       and (v_type is null    or d.doc_type_id = v_type)
       and (v_fy is null      or pr.financial_year_id = v_fy)
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
     where m.group_id is not null and m.ok_as and m.ok_channel and m.ok_by and m.ok_status group by m.group_id
    union all
    select 'received_as', m.received_as::text, count(*)::integer from m
     where m.ok_group and m.ok_channel and m.ok_by and m.ok_status group by m.received_as
    union all
    select 'channel', m.channel::text, count(*)::integer from m
     where m.ok_group and m.ok_as and m.ok_by and m.ok_status group by m.channel
    union all
    select 'received_by', m.received_by::text, count(*)::integer from m
     where m.ok_group and m.ok_as and m.ok_channel and m.ok_status group by m.received_by
    union all
    select 'status', m.status::text, count(*)::integer from m
     where m.ok_group and m.ok_as and m.ok_channel and m.ok_by group by m.status
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

revoke all on function public.search_documents(jsonb), public.search_document_facets(jsonb) from public, anon;
grant execute on function public.search_documents(jsonb), public.search_document_facets(jsonb) to authenticated;
