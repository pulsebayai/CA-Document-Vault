-- 13-hard-copy-custody · migration B (spec AC-1 … AC-18; plan step 3).
-- New: set_custody, undo_custody, log_receipt, custody_metric, private.custody_state / custody_held.
-- Replaced (copied from 12's migration B, 20261030100100; only the lines marked "13" change):
--   public.create_dispatch      implied custody steps (S2)
--   public.search_documents     Custody filter (to_place · in_office · ready · dispatched), held, custody per row
--   public.search_document_facets  the same Custody values
--   public.today_items          to_place / held counts and rows on request; Ready = stored step
-- 07's undo_dispatch_item needs no change: the document keeps its Ready step when it comes out of a packet.

-- ── 13: the Custody value of a document (one rule for search, facets and the TS mirror in state.ts) ──────────────
-- dispatched (live packet) · ready (returnable, marked ready, a review decision taken) · in_office (any other custody
-- step) · to_place (a filed hard copy with a review decision and no step) · null. Archived and Untagged: null.
create function private.custody_state(p_dispatched boolean, p_archived boolean, p_filed boolean, p_received_as public.received_as,
  p_returnable boolean, p_custody public.custody_step, p_status public.document_status)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_dispatched then 'dispatched'
    when p_archived or not p_filed or p_received_as <> 'hard_copy' then null
    when p_custody = 'ready' and p_returnable and p_status in ('reviewed', 'needs_correction') then 'ready'
    when p_custody is not null then 'in_office'
    when p_status in ('reviewed', 'needs_correction') then 'to_place'
  end
$$;
revoke all on function private.custody_state(boolean, boolean, boolean, public.received_as, boolean, public.custody_step, public.document_status) from public, anon;
grant execute on function private.custody_state(boolean, boolean, boolean, public.received_as, boolean, public.custody_step, public.document_status) to authenticated, service_role;

-- 13 (spec AC-10): a returnable document in office (or ready) for more than 30 office days, not in a live packet.
create function private.custody_held(p_dispatched boolean, p_archived boolean, p_returnable boolean, p_custody public.custody_step,
  p_in_office_at timestamptz, p_today date)
returns boolean language sql immutable set search_path = '' as $$
  select not p_dispatched and not p_archived and p_returnable and p_custody is not null
         and (p_in_office_at at time zone 'Asia/Kolkata')::date < p_today - 30
$$;
revoke all on function private.custody_held(boolean, boolean, boolean, public.custody_step, timestamptz, date) from public, anon;
grant execute on function private.custody_held(boolean, boolean, boolean, public.custody_step, timestamptz, date) to authenticated, service_role;

-- ── create_dispatch ──
create or replace function public.create_dispatch(p jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_office    uuid := private.current_office_id();
  v_staff     uuid := private.current_staff_id();
  v_client    uuid := nullif(p->>'client_id', '')::uuid;
  v_ids       uuid[];
  v_on        date := nullif(p->>'dispatched_on', '')::date;
  v_method    public.dispatch_method := nullif(p->>'method', '')::public.dispatch_method;
  v_courier   text := nullif(btrim(coalesce(p->>'courier_name', '')), '');
  v_tracking  text := nullif(btrim(coalesce(p->>'tracking_no', '')), '');
  v_recipient text := btrim(coalesce(p->>'recipient_name', ''));
  v_today     date := (now() at time zone 'Asia/Kolkata')::date;
  v_found     integer := 0;
  v_latest    date;
  d           record;
  v_id        uuid;
begin
  if v_staff is null then raise exception 'ROLE_REQUIRED: sign in as active staff' using errcode = '42501'; end if;
  select coalesce(array_agg(distinct x::uuid), '{}') into v_ids
    from jsonb_array_elements_text(case when jsonb_typeof(p->'document_ids') = 'array' then p->'document_ids' else '[]'::jsonb end) x;
  if cardinality(v_ids) = 0 then raise exception 'NO_DOCUMENTS: tick at least one original' using errcode = '23514'; end if;
  if v_on is null then raise exception 'DATE_REQUIRED: give the date dispatched' using errcode = '23514'; end if;
  if v_on > v_today then raise exception 'DATE_FUTURE: the dispatch date cannot be in the future' using errcode = '23514'; end if;
  if v_method is null then raise exception 'METHOD_REQUIRED: choose how it was dispatched' using errcode = '23514'; end if;
  if length(v_recipient) not between 1 and 120 then
    raise exception 'RECIPIENT_REQUIRED: give the recipient''s name (up to 120 characters)' using errcode = '23514';
  end if;
  if v_method <> 'courier' then v_courier := null; v_tracking := null; end if;
  if v_client is null or not exists (select 1 from public.client c where c.id = v_client) then
    raise exception 'NOT_FOUND: client' using errcode = 'P0002';
  end if;
  -- Lock the originals in a stable order: two packets for the same original serialise here.
  for d in select x.id, x.doc_code, x.client_id, x.doc_type_id, x.received_as, x.returnable, x.status, x.archived_at, x.received_on
             from public.document x where x.id = any (v_ids) order by x.id for update loop
    v_found := v_found + 1;
    if d.client_id is distinct from v_client or d.doc_type_id is null or not d.returnable -- 12 (was: received_as = original)
       or d.archived_at is not null or d.status not in ('reviewed', 'needs_correction') then
      raise exception 'NOT_ELIGIBLE: % is not a ready original of this client', d.doc_code using errcode = '23514';
    end if;
    if exists (select 1 from public.dispatch_item i where i.document_id = d.id and i.removed_at is null) then
      raise exception 'ALREADY_DISPATCHED: % is already dispatched', d.doc_code using errcode = '23514';
    end if;
    v_latest := greatest(v_latest, d.received_on);
  end loop;
  if v_found < cardinality(v_ids) then raise exception 'NOT_FOUND: document' using errcode = 'P0002'; end if;
  if v_on < v_latest then
    raise exception 'DATE_BEFORE_RECEIVED: the dispatch date is before a ticked original was received' using errcode = '23514';
  end if;

  perform set_config('app.dispatch_write', 'on', true);
  insert into public.dispatch (office_id, client_id, dispatched_on, method, courier_name, tracking_no, recipient_name, created_by)
    values (v_office, v_client, v_on, v_method, v_courier, v_tracking, v_recipient, v_staff)
    returning id into v_id;
  insert into public.dispatch_item (office_id, dispatch_id, document_id)
    select v_office, v_id, x from unnest(v_ids) x;
  perform set_config('app.dispatch_write', '', true);

  -- 13 (spec S2): a reviewed returnable copy nobody marked Ready still dispatches; the steps it skipped are recorded
  -- now, by the dispatcher, marked implied. A document already Ready is left as it is.
  perform private.begin_doc_write();
  for d in select x.id, x.custody from public.document x where x.id = any (v_ids) order by x.id loop
    continue when d.custody = 'ready';
    perform set_config('app.doc_custody', d.id::text, true);
    if d.custody is null then
      insert into public.document_custody (office_id, document_id, step, implied, actor_id) values (v_office, d.id, 'in_office', true, v_staff);
    end if;
    insert into public.document_custody (office_id, document_id, step, implied, actor_id) values (v_office, d.id, 'ready', true, v_staff);
    update public.document x
       set custody = 'ready', in_office_at = coalesce(x.in_office_at, now()),
           in_office_by = case when x.custody is null then v_staff else x.in_office_by end,
           ready_at = now(), ready_by = v_staff
     where x.id = d.id;
  end loop;
  perform set_config('app.doc_custody', '', true);

  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, v_staff, 'dispatch.created', 'dispatch', v_id::text,
            jsonb_build_object('client_id', v_client, 'document_ids', to_jsonb(v_ids), 'method', v_method));
  return jsonb_build_object('id', v_id);
end $$;

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

-- ── today_items ──
create or replace function public.today_items(p_scope text, p_show text default null, p_page integer default 0,
  p_limit integer default 30)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_office uuid := private.current_office_id();
  v_me uuid := private.current_staff_id();
  v_today date;
  v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_page integer := greatest(coalesce(p_page, 0), 0);
  v jsonb;
begin
  if p_scope is null or p_scope not in ('mine', 'everyone') then
    raise exception 'BAD_SCOPE: scope is mine or everyone' using errcode = '22023';
  end if;
  if p_show is not null and p_show not in ('overdue', 'due_week', 'to_review', 'ready', 'requested', 'to_place', 'held') then -- 13
    raise exception 'BAD_SHOW: show is overdue, due_week, to_review, ready, requested, to_place or held' using errcode = '22023';
  end if;
  v_today := private.office_today(v_office);

  with base as (
    select e.id, e.client_id, e.overdue_from, r.reminders, t.name as type_name, dg.name as group_name, dg.sort as group_sort,
           p.label as period_label, p.start_date, reg.kind as reg_kind,
           case when reg.kind = 'gstin' then coalesce(reg.state_code, substr(reg.number, 1, 2)) end as state_code,
           case when e.overdue_from <= v_today then 'overdue'
                when e.overdue_from = v_today + 1 then 'due_today' else 'due_week' end as kind,
           case when e.overdue_from <= v_today then v_today - e.overdue_from + 1 end as days_late
      from public.expected_doc e
      join public.client c on c.id = e.client_id and c.archived_at is null
      join public.client_doc_type r on r.id = e.client_doc_type_id
      join public.client_group g on g.id = r.client_group_id
      join public.doc_type t on t.id = e.doc_type_id
      join public.doc_group dg on dg.id = t.doc_group_id
      join public.period p on p.id = e.period_id
      left join public.client_registration reg on reg.id = e.registration_id
     where e.office_id = v_office and e.status = 'pending'
       and r.state <> 'paused' and g.state <> 'paused'
       and e.overdue_from <= v_today + 7
       and (p_scope = 'everyone' or coalesce(r.assigned_staff_id, g.assigned_staff_id, c.incharge_id) = v_me)
  ), docs_all as (
    select d.id, d.client_id, d.doc_code, d.received_as, d.returnable, d.received_on, -- 12: returnable
           (d.reviewed_at at time zone 'Asia/Kolkata')::date as reviewed_on, rv.full_name as reviewed_by,
           d.status = 'needs_correction' as needs_correction,
           t.name as type_name, dg.name as group_name, p.label as period_label,
           -- 13: Ready is the stored step; To place = a filed hard copy with a review decision and no step.
           case when d.status = 'received' then 'to_review'
                when d.custody = 'ready' then 'ready'
                when d.custody is null then 'to_place' end as kind,
           (d.in_office_at at time zone 'Asia/Kolkata')::date as in_office_on, -- 13
           d.returnable and d.custody is not null and (d.in_office_at at time zone 'Asia/Kolkata')::date < v_today - 30
             and not exists (select 1 from public.dispatch_item di where di.document_id = d.id and di.removed_at is null) as held -- 13
      from public.document d
      join public.client c on c.id = d.client_id and c.archived_at is null
      join public.doc_type t on t.id = d.doc_type_id
      join public.doc_group dg on dg.id = t.doc_group_id
      left join public.period p on p.id = d.period_id
      left join public.staff_user rv on rv.id = d.reviewed_by
      left join public.client_doc_type r on r.client_id = d.client_id and r.doc_type_id = d.doc_type_id and r.state = 'active'
      left join public.client_group g on g.client_id = d.client_id and g.doc_group_id = t.doc_group_id and g.state = 'active'
     where d.office_id = v_office and d.archived_at is null
       and d.client_id is not null and d.doc_type_id is not null
       and (d.status = 'received'
            or (d.returnable and d.custody = 'ready' and d.status in ('reviewed', 'needs_correction') -- 13 (was: derived from 12's returnable)
                and not exists (select 1 from public.dispatch_item di where di.document_id = d.id and di.removed_at is null))
            or (d.received_as = 'hard_copy' and d.custody is null and d.status in ('reviewed', 'needs_correction')) -- 13: to place
            or (d.returnable and d.custody is not null and (d.in_office_at at time zone 'Asia/Kolkata')::date < v_today - 30
                and not exists (select 1 from public.dispatch_item di where di.document_id = d.id and di.removed_at is null))) -- 13: held
       and (p_scope = 'everyone' or coalesce(r.assigned_staff_id, g.assigned_staff_id, c.incharge_id) = v_me
            -- 10 AC-13: a client's link upload is also its requester's (D1: received_by = the requester).
            or (d.channel = 'upload_link' and d.received_by = v_me))
  ), docs as (
    -- 13: one row per document and list (a document held > 30 days also keeps its own row: Ready, or none when in office).
    select a.id, a.client_id, a.doc_code, a.received_as, a.returnable, a.received_on, a.reviewed_on, a.reviewed_by,
           a.needs_correction, a.type_name, a.group_name, a.period_label, a.kind, a.in_office_on
      from docs_all a where a.kind is not null
    union all
    select a.id, a.client_id, a.doc_code, a.received_as, a.returnable, a.received_on, a.reviewed_on, a.reviewed_by,
           a.needs_correction, a.type_name, a.group_name, a.period_label, 'held', a.in_office_on
      from docs_all a where a.held
  ), asks as (
    -- 10 AC-17: open ad-hoc requested items; Mine = the request's sender (who asked chases it). Overdue once the
    -- needed-by date has passed; due this week when it falls within 7 days; anything else is only counted (D7).
    select i.id, q.client_id, i.needed_by, i.note, i.created_at, t.name as type_name, dg.name as group_name,
           dg.sort as group_sort, p.label as period_label,
           case when i.needed_by < v_today then 'overdue' when i.needed_by <= v_today + 7 then 'due_week' end as due
      from public.upload_request_item i
      join public.upload_request q on q.id = i.request_id
      join public.client c on c.id = q.client_id and c.archived_at is null
      join public.doc_type t on t.id = i.doc_type_id
      join public.doc_group dg on dg.id = t.doc_group_id
      left join public.period p on p.id = i.period_id
     where i.office_id = v_office and i.kind = 'ad_hoc' and i.status = 'open'
       and (p_scope = 'everyone' or q.created_by = v_me)
  ), shown_asks as (
    select * from asks where due is not null and (p_show is null or p_show = 'requested')
  ), shown as (
    select * from base
     where (p_show is null or (p_show = 'overdue' and kind = 'overdue') or (p_show = 'due_week' and kind <> 'overdue'))
       and p_show is distinct from 'requested'
  ), shown_docs as (
    -- 13 (Sidambara 2026-10-31): To place / held rows only when chosen; the default list keeps To review + Ready.
    select * from docs where ((p_show is null and kind in ('to_review', 'ready')) or p_show = kind) and p_show is distinct from 'requested'
  ), card as (
    select x.client_id,
           (select count(*) from base b where b.client_id = x.client_id and b.kind = 'overdue') as n_overdue,
           (select count(*) from base b where b.client_id = x.client_id and b.kind <> 'overdue') as n_week,
           (select count(*) from docs k where k.client_id = x.client_id and k.kind = 'to_review') as n_review,
           (select count(*) from docs k where k.client_id = x.client_id and k.kind = 'ready') as n_ready,
           (select count(*) from docs k where k.client_id = x.client_id and k.kind = 'to_place') as n_to_place, -- 13
           (select count(*) from docs k where k.client_id = x.client_id and k.kind = 'held') as n_held, -- 13
           (select count(*) from asks a where a.client_id = x.client_id and a.due is not null) as n_asks,
           (select count(*) from asks a where a.client_id = x.client_id and a.due = 'overdue') as n_asks_late
      from (select client_id from shown union select client_id from shown_docs union select client_id from shown_asks) x
  ), ordered as (
    select k.*, cl.name, cl.incharge_id,
           row_number() over (order by k.n_overdue desc, lower(cl.name), cl.id) as rn  -- 06's order (AC-17)
      from card k join public.client cl on cl.id = k.client_id
  ), page as (
    select * from ordered where rn > v_page * v_limit and rn <= (v_page + 1) * v_limit
  ), hist as (
    select s.id,
           h.n as reminded, h.last_on, h.last_by, h.last_channel
      from shown s
      cross join lateral (
        select count(*) as n,
               (array_agg(f.sent_on order by f.sent_on desc, f.sent_at desc))[1] as last_on,
               (array_agg(st.full_name order by f.sent_on desc, f.sent_at desc))[1] as last_by,
               (array_agg(f.channel::text order by f.sent_on desc, f.sent_at desc))[1] as last_channel
          from public.follow_up_item fi
          join public.follow_up f on f.id = fi.follow_up_id
          join public.staff_user st on st.id = f.sent_by
         where fi.expected_doc_id = s.id and f.status in ('sent', 'suppressed', 'opened', 'logged')
      ) h
     where s.client_id in (select client_id from page)
  )
  select jsonb_build_object(
    'today', v_today,
    'counts', jsonb_build_object(
      'overdue', (select count(*) from base where kind = 'overdue'),
      'due_week', (select count(*) from base where kind <> 'overdue'),
      'to_review', (select count(*) from docs where kind = 'to_review'),
      'ready', (select count(*) from docs where kind = 'ready'),
      'to_place', (select count(*) from docs where kind = 'to_place'), -- 13
      'held', (select count(*) from docs where kind = 'held'), -- 13
      'requested', (select count(*) from asks),
      'requested_later', (select count(*) from asks where due is null)),
    'clients', (select count(*) from ordered),
    'has_more', exists (select 1 from ordered where rn > (v_page + 1) * v_limit),
    'cards', coalesce((
      select jsonb_agg(jsonb_build_object(
               'client_id', pg.client_id, 'name', pg.name,
               'incharge', (select s.full_name from public.staff_user s where s.id = pg.incharge_id),
               'assignees', coalesce((
                  select jsonb_agg(jsonb_build_object('group', dg.name, 'name', s.full_name) order by dg.sort, dg.name)
                    from public.client_group g
                    join public.doc_group dg on dg.id = g.doc_group_id
                    join public.staff_user s on s.id = g.assigned_staff_id
                   where g.client_id = pg.client_id and g.state = 'active'), '[]'::jsonb),
               'overdue', pg.n_overdue, 'due_week', pg.n_week, 'to_review', pg.n_review, 'ready', pg.n_ready, 'to_place', pg.n_to_place, 'held', pg.n_held, -- 13
               'requested', pg.n_asks, 'requested_overdue', pg.n_asks_late,
               'rows',
                 coalesce((
                  select jsonb_agg(jsonb_build_object(
                           'expected_doc_id', s.id, 'kind', s.kind, 'group', s.group_name, 'type', s.type_name,
                           'period', s.period_label, 'reg_kind', s.reg_kind, 'state_code', s.state_code,
                           'overdue_from', s.overdue_from, 'days_late', s.days_late, 'reminders', s.reminders,
                           'reminded', h.reminded, 'last_reminded_on', h.last_on, 'last_reminded_by', h.last_by,
                           'last_channel', h.last_channel)
                         order by case s.kind when 'overdue' then 0 when 'due_today' then 1 else 2 end,
                                  s.overdue_from, s.group_sort, s.type_name, s.start_date, s.id)
                    from shown s join hist h on h.id = s.id
                   where s.client_id = pg.client_id), '[]'::jsonb)
                 || coalesce((
                  select jsonb_agg(jsonb_build_object(
                           'item_id', a.id, 'kind', 'requested', 'due', a.due, 'group', a.group_name, 'type', a.type_name,
                           'period', a.period_label, 'needed_by', a.needed_by, 'note', a.note)
                         order by case a.due when 'overdue' then 0 else 1 end, a.needed_by, a.group_sort, a.type_name, a.created_at)
                    from shown_asks a
                   where a.client_id = pg.client_id), '[]'::jsonb)
                 || coalesce((
                  select jsonb_agg(jsonb_build_object(
                           'document_id', k.id, 'kind', k.kind, 'doc_code', k.doc_code, 'group', k.group_name,
                           'type', k.type_name, 'period', k.period_label, 'received_as', k.received_as, 'returnable', k.returnable, -- 12
                           'received_on', k.received_on, 'reviewed_on', k.reviewed_on, 'reviewed_by', k.reviewed_by,
                           'needs_correction', k.needs_correction, 'in_office_on', k.in_office_on) -- 13
                         order by case k.kind when 'to_review' then 0 else 1 end, k.received_on, k.doc_code)
                    from shown_docs k
                   where k.client_id = pg.client_id), '[]'::jsonb))
             order by pg.rn)
        from page pg), '[]'::jsonb))
    into v;
  return v;
end $$;

-- ── set_custody (spec AC-1 … AC-3, AC-9): one or many documents, one step; each done or skipped with a reason ──────
create function public.set_custody(p_ids uuid[], p_step text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_staff  uuid := private.current_staff_id();
  v_done   uuid[] := '{}';
  v_skip   jsonb := '[]'::jsonb;
  v_reason text;
  v_id     uuid;
  d        public.document;
begin
  if v_staff is null then raise exception 'ROLE_REQUIRED: sign in as active staff' using errcode = '42501'; end if;
  if p_step is null or p_step not in ('in_office', 'ready') then
    raise exception 'STEP_INVALID: in_office or ready' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_ids), 0) > 200 then
    raise exception 'TOO_MANY: up to 200 documents at a time' using errcode = '22023';
  end if;
  perform private.begin_doc_write();
  foreach v_id in array coalesce(p_ids, '{}') loop
    v_reason := null;
    begin
      select * into d from public.document x where x.id = v_id for update; -- RLS: an invisible document is not found
      if not found then v_reason := 'NOT_FOUND';
      elsif d.archived_at is not null then v_reason := 'ARCHIVED';
      elsif d.client_id is null or d.doc_type_id is null then v_reason := 'NOT_CLASSIFIED';
      elsif d.received_as <> 'hard_copy' then v_reason := 'SOFT_COPY';
      elsif d.status = 'received' then v_reason := 'NOT_REVIEWED';
      elsif p_step = 'in_office' and d.custody is not null then v_reason := 'ALREADY';
      elsif p_step = 'ready' and not d.returnable then v_reason := 'NOT_RETURNABLE';
      elsif p_step = 'ready' and d.custody is null then v_reason := 'NOT_IN_OFFICE';
      elsif p_step = 'ready' and d.custody = 'ready' then v_reason := 'ALREADY';
      else
        perform set_config('app.doc_custody', v_id::text, true);
        insert into public.document_custody (office_id, document_id, step, implied, actor_id)
          values (d.office_id, v_id, p_step::public.custody_event, false, v_staff);
        if p_step = 'in_office' then
          update public.document set custody = 'in_office', in_office_at = now(), in_office_by = v_staff where id = v_id;
        else
          update public.document set custody = 'ready', ready_at = now(), ready_by = v_staff where id = v_id;
        end if;
        perform set_config('app.doc_custody', '', true);
        insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
          values (d.office_id, v_staff, 'document.' || p_step, 'document', v_id::text,
                  jsonb_build_object('client_id', d.client_id, 'doc_type_id', d.doc_type_id));
        v_done := v_done || v_id;
      end if;
    exception when others then
      v_reason := coalesce(nullif(split_part(sqlerrm, ':', 1), ''), 'ERROR');
    end;
    if v_reason is not null then
      v_skip := v_skip || jsonb_build_object('id', v_id, 'reason', v_reason);
    end if;
  end loop;
  return jsonb_build_object('done', to_jsonb(v_done), 'skipped', v_skip);
end $$;
revoke all on function public.set_custody(uuid[], text) from public, anon;
grant execute on function public.set_custody(uuid[], text) to authenticated;

-- ── undo_custody (spec AC-4, S3): Ready → In office → not placed; no reason; never while in a live packet ──────────
create function public.undo_custody(p_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_staff uuid := private.current_staff_id();
  d       public.document;
begin
  if v_staff is null then raise exception 'ROLE_REQUIRED: sign in as active staff' using errcode = '42501'; end if;
  select * into d from public.document x where x.id = p_id for update;
  if not found then raise exception 'NOT_FOUND: document' using errcode = 'P0002'; end if;
  if d.archived_at is not null then raise exception 'ARCHIVED: unarchive the document before changing it' using errcode = 'P0001'; end if;
  if d.custody is null then raise exception 'NOT_IN_CUSTODY: this document is not marked in office' using errcode = 'P0001'; end if;
  if exists (select 1 from public.dispatch_item i where i.document_id = p_id and i.removed_at is null) then
    raise exception 'DISPATCHED: undo the dispatch first' using errcode = 'P0001';
  end if;
  perform private.begin_doc_write();
  perform set_config('app.doc_custody', p_id::text, true);
  insert into public.document_custody (office_id, document_id, step, implied, actor_id)
    values (d.office_id, p_id, case when d.custody = 'ready' then 'undo_ready' else 'undo_in_office' end::public.custody_event, false, v_staff);
  if d.custody = 'ready' then
    update public.document set custody = 'in_office', ready_at = null, ready_by = null where id = p_id;
  else
    update public.document set custody = null, in_office_at = null, in_office_by = null where id = p_id;
  end if;
  perform set_config('app.doc_custody', '', true);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (d.office_id, v_staff, 'document.custody_undone', 'document', p_id::text,
            jsonb_build_object('client_id', d.client_id, 'doc_type_id', d.doc_type_id, 'step', d.custody::text));
end $$;
revoke all on function public.undo_custody(uuid) from public, anon;
grant execute on function public.undo_custody(uuid) to authenticated;

-- ── log_receipt (spec AC-13 … AC-15, Q1, Q2): N hard copies with no file through 03's create_document, all or nothing ──
create function public.log_receipt(p jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_staff  uuid := private.current_staff_id();
  v_client uuid := nullif(p->>'client_id', '')::uuid;
  v_count  integer := case when coalesce(p->>'count', '') ~ '^[0-9]{1,3}$' then (p->>'count')::integer end;
  v_name   text := nullif(btrim(coalesce(p->>'handed_over_name', '')), '');
  v_code   text;
  v_docs   jsonb := '[]'::jsonb;
  v_body   jsonb;
  i        integer;
begin
  if v_staff is null then raise exception 'ROLE_REQUIRED: sign in as active staff' using errcode = '42501'; end if;
  if v_client is null then raise exception 'CLIENT_REQUIRED: choose the client' using errcode = '23514'; end if;
  if v_count is null or v_count not between 1 and 20 then
    raise exception 'COUNT_INVALID: how many must be 1 to 20' using errcode = '23514';
  end if;
  if v_name is null or length(v_name) > 120 then
    raise exception 'HANDED_OVER_REQUIRED: say who handed it over (up to 120 characters)' using errcode = '23514';
  end if;
  select c.code into v_code from public.client c where c.id = v_client; -- RLS: Limited sees only their clients
  if not found then raise exception 'NOT_FOUND: client' using errcode = 'P0002'; end if;
  v_body := jsonb_strip_nulls(jsonb_build_object(
    'client_id', v_client, 'doc_type_id', nullif(p->>'doc_type_id', ''), 'period_id', nullif(p->>'period_id', ''),
    'received_as', 'hard_copy', 'returnable', coalesce((p->>'returnable')::boolean, false), 'handed_over_name', v_name,
    'received_on', nullif(p->>'received_on', ''), 'channel', coalesce(nullif(p->>'channel', ''), 'hand_delivery'),
    'remark', nullif(btrim(coalesce(p->>'remark', '')), '')));
  for i in 1 .. v_count loop
    v_docs := v_docs || jsonb_build_array(public.create_document(v_body));
  end loop;
  return jsonb_build_object('client_code', v_code,
    'documents', (select jsonb_agg(jsonb_build_object('id', x->>'id', 'doc_code', x->>'doc_code') order by n)
                    from jsonb_array_elements(v_docs) with ordinality as e(x, n)));
end $$;
revoke all on function public.log_receipt(jsonb) from public, anon;
grant execute on function public.log_receipt(jsonb) to authenticated;

-- ── custody_metric (spec AC-18; success metrics 1 and 2): Admin/Manager ─────────────────────────────────────────────
create function public.custody_metric(p_from date, p_to date)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_office uuid := private.current_office_id();
  v_today  date;
  v        jsonb;
begin
  if not private.has_role(array['admin', 'manager']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: Admin or Manager only' using errcode = '42501';
  end if;
  v_today := private.office_today(v_office);
  with rv as (
    select d.id, (d.reviewed_at at time zone 'Asia/Kolkata')::date as reviewed_on
      from public.document d
     where d.office_id = v_office and d.archived_at is null and d.received_as = 'hard_copy'
       and d.client_id is not null and d.doc_type_id is not null and d.status in ('reviewed', 'needs_correction')
       and (d.reviewed_at at time zone 'Asia/Kolkata')::date between p_from and p_to
  ), placed as (
    select r.id from rv r
     where exists (
       select 1 from public.document_custody h
        where h.document_id = r.id and h.step = 'in_office' and not h.implied
          and (select count(*) from generate_series(r.reviewed_on + 1, (h.at at time zone 'Asia/Kolkata')::date, interval '1 day') g
                where extract(isodow from g) < 6) <= 2)
  ), sent as (
    select dp.dispatched_on - (max(h.at) at time zone 'Asia/Kolkata')::date as days
      from public.dispatch_item i
      join public.dispatch dp on dp.id = i.dispatch_id
      join public.document_custody h on h.document_id = i.document_id and h.step = 'ready' and not h.implied
     where i.office_id = v_office and i.removed_at is null and dp.dispatched_on between p_from and p_to
     group by i.id, dp.dispatched_on
  )
  select jsonb_build_object(
    'reviewed', (select count(*) from rv),
    'placed_2d', (select count(*) from placed),
    'ready_to_dispatched_median_days', (select percentile_cont(0.5) within group (order by days) from sent),
    'held_now', (select count(*) from public.document d
                  where d.office_id = v_office
                    and private.custody_held(exists (select 1 from public.dispatch_item di where di.document_id = d.id and di.removed_at is null),
                                             d.archived_at is not null, d.returnable, d.custody, d.in_office_at, v_today)))
    into v;
  return v;
end $$;
revoke all on function public.custody_metric(date, date) from public, anon;
grant execute on function public.custody_metric(date, date) to authenticated;
