-- 12-intake-review-fixes · migration B (spec AC-11, AC-13, AC-21, AC-24, AC-27; plan step 3).
-- Existing functions replaced, each copied from its latest definition; only the lines marked "12" are new.
--   public.review_document      <- 20261001123125_review_and_dispatch.sql (07)  + p_kind (dropped and recreated)
--   public.undo_review          <- 20261001123125_review_and_dispatch.sql (07)  Staff+
--   public.create_dispatch      <- 20261001123125_review_and_dispatch.sql (07)  returnable, not 'original'
--   public.search_documents     <- 20261026113420_format_reads.sql (11)         returnable filter + legacy as=original
--   public.search_document_facets <- 20261026113420_format_reads.sql (11)
--   public.today_items          <- 20261025190409_upload_links_review_10b.sql (10)
--   public.search_clients       <- 20261001053022_clients_overdue.sql (04)       + p_mine (dropped and recreated)

-- ── review_document ──────────────────────────────────────────────────────────────────────────────────────
drop function public.review_document(uuid, text, text);
create function public.review_document(p_id uuid, p_outcome text, p_reason text default null, p_kind text default null)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  d        public.document;
  v_staff  uuid := private.current_staff_id();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_staff is null then raise exception 'ROLE_REQUIRED: sign in as active staff' using errcode = '42501'; end if;
  if p_outcome is null or p_outcome not in ('reviewed', 'needs_correction') then
    raise exception 'OUTCOME_INVALID: reviewed or needs_correction' using errcode = '22023';
  end if;
  if p_outcome = 'needs_correction' and (v_reason is null or length(v_reason) > 500) then
    raise exception 'REASON_REQUIRED: give a reason of 1–500 characters' using errcode = '23514';
  end if;
  -- 12 (spec AC-21): wrong file | wrong details. Optional for older callers (no kind stored); ignored for 'reviewed'.
  if p_outcome = 'needs_correction' and p_kind is not null and p_kind not in ('file', 'details') then
    raise exception 'KIND_INVALID: file or details' using errcode = '22023';
  end if;
  select * into d from public.document where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: document' using errcode = 'P0002'; end if;
  if d.client_id is null or d.doc_type_id is null then
    raise exception 'NOT_CLASSIFIED: file the document (client and type) before reviewing it' using errcode = 'P0001';
  end if;
  if d.archived_at is not null then raise exception 'ARCHIVED: unarchive the document before changing it' using errcode = 'P0001'; end if;
  if p_outcome = 'reviewed' and d.status = 'reviewed' then
    raise exception 'ALREADY_REVIEWED: this document has already been reviewed' using errcode = 'P0001';
  end if;
  perform private.begin_doc_write();
  perform set_config('app.doc_review', p_id::text, true);
  update public.document
     set status = p_outcome::public.document_status, reviewed_by = v_staff, reviewed_at = now(),
         correction_reason = case when p_outcome = 'needs_correction' then v_reason end,
         correction_kind = case when p_outcome = 'needs_correction' then p_kind::public.correction_kind end -- 12
   where id = p_id;
  insert into public.document_review (office_id, document_id, outcome, reason, actor_id, correction_kind)
    values (d.office_id, p_id, p_outcome::public.review_outcome, case when p_outcome = 'needs_correction' then v_reason end, v_staff,
            case when p_outcome = 'needs_correction' then p_kind::public.correction_kind end); -- 12
  perform set_config('app.doc_review', '', true);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (d.office_id, v_staff, 'document.' || p_outcome, 'document', p_id::text,
            jsonb_strip_nulls(jsonb_build_object('client_id', d.client_id, 'doc_type_id', d.doc_type_id,
              'kind', case when p_outcome = 'needs_correction' then p_kind end))); -- 12
end $$;


revoke all on function public.review_document(uuid, text, text, text) from public, anon;
grant execute on function public.review_document(uuid, text, text, text) to authenticated;

-- ── undo_review ──
create or replace function public.undo_review(p_id uuid, p_reason text)
returns void language plpgsql security invoker set search_path = '' as $$
declare d public.document; v_staff uuid := private.current_staff_id(); v_reason text := btrim(coalesce(p_reason, ''));
begin
  -- 12 (spec AC-24): Staff can undo a review too; Limited can't. Undoing a dispatch stays Admin/Manager.
  if not private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: only Admin, Manager or Staff can undo a review' using errcode = '42501';
  end if;
  if length(v_reason) not between 1 and 500 then
    raise exception 'REASON_REQUIRED: give a reason of 1–500 characters' using errcode = '23514';
  end if;
  select * into d from public.document where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: document' using errcode = 'P0002'; end if;
  if d.archived_at is not null then raise exception 'ARCHIVED: unarchive the document before changing it' using errcode = 'P0001'; end if;
  if d.status = 'received' then raise exception 'NOT_REVIEWED: this document is still to review' using errcode = 'P0001'; end if;
  perform private.begin_doc_write();
  perform set_config('app.doc_review', p_id::text, true);
  update public.document set status = 'received', reviewed_by = null, reviewed_at = null, correction_reason = null,
    correction_kind = null where id = p_id; -- 12
  insert into public.document_review (office_id, document_id, outcome, reason, actor_id)
    values (d.office_id, p_id, 'undone', v_reason, v_staff);
  perform set_config('app.doc_review', '', true);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (d.office_id, v_staff, 'document.review_undone', 'document', p_id::text,
            jsonb_build_object('client_id', d.client_id, 'from', d.status));
end $$;


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
  v_return   text := nullif(f->>'return', ''); -- 07: ready | dispatched
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
  if v_return is not null and v_return not in ('ready', 'dispatched') then
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
           case when di.id is not null then 'dispatched'
                when d.returnable and d.client_id is not null and d.doc_type_id is not null
                     and d.archived_at is null and d.status in ('reviewed', 'needs_correction') then 'ready' end as return_state
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
  v_return   text := nullif(f->>'return', ''); -- 07: ready | dispatched
  v_format   text := nullif(f->>'format', ''); -- 11: not_preferred
  v_ret      boolean := case when lower(coalesce(f->>'returnable', '')) in ('true', '1') then true end; -- 12
begin
  if v_as = 'original' then v_as := 'hard_copy'; v_ret := true; end if; -- 12: legacy filter = hard copy + returnable
  if v_state is not null and v_state not in ('classified', 'inbox') then
    raise exception 'INVALID_FILTER: state' using errcode = '22023';
  end if;
  if v_return is not null and v_return not in ('ready', 'dispatched') then
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
           case when di.id is not null then 'dispatched'
                when d.returnable and d.client_id is not null and d.doc_type_id is not null
                     and d.archived_at is null and d.status in ('reviewed', 'needs_correction') then 'ready' end as return_state,
           (v_group is null   or t.doc_group_id = v_group) as ok_group,
           (v_as is null      or d.received_as = v_as)     as ok_as,
           (v_channel is null or d.channel = v_channel)    as ok_channel,
           (v_by is null      or d.received_by = v_by)     as ok_by,
           (v_status is null  or d.status = v_status)      as ok_status,
           (v_return is null  or (case when di.id is not null then 'dispatched'
                when d.returnable and d.client_id is not null and d.doc_type_id is not null
                     and d.archived_at is null and d.status in ('reviewed', 'needs_correction') then 'ready' end) = v_return) as ok_return,
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
  if p_show is not null and p_show not in ('overdue', 'due_week', 'to_review', 'ready', 'requested') then
    raise exception 'BAD_SHOW: show is overdue, due_week, to_review, ready or requested' using errcode = '22023';
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
  ), docs as (
    select d.id, d.client_id, d.doc_code, d.received_as, d.returnable, d.received_on, -- 12: returnable
           (d.reviewed_at at time zone 'Asia/Kolkata')::date as reviewed_on, rv.full_name as reviewed_by,
           d.status = 'needs_correction' as needs_correction,
           t.name as type_name, dg.name as group_name, p.label as period_label,
           case when d.status = 'received' then 'to_review' else 'ready' end as kind
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
            or (d.returnable and d.status in ('reviewed', 'needs_correction') -- 12 (was: received_as = original)
                and not exists (select 1 from public.dispatch_item di where di.document_id = d.id and di.removed_at is null)))
       and (p_scope = 'everyone' or coalesce(r.assigned_staff_id, g.assigned_staff_id, c.incharge_id) = v_me
            -- 10 AC-13: a client's link upload is also its requester's (D1: received_by = the requester).
            or (d.channel = 'upload_link' and d.received_by = v_me))
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
    select * from docs where (p_show is null or p_show = kind) and p_show is distinct from 'requested'
  ), card as (
    select x.client_id,
           (select count(*) from base b where b.client_id = x.client_id and b.kind = 'overdue') as n_overdue,
           (select count(*) from base b where b.client_id = x.client_id and b.kind <> 'overdue') as n_week,
           (select count(*) from docs k where k.client_id = x.client_id and k.kind = 'to_review') as n_review,
           (select count(*) from docs k where k.client_id = x.client_id and k.kind = 'ready') as n_ready,
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
               'overdue', pg.n_overdue, 'due_week', pg.n_week, 'to_review', pg.n_review, 'ready', pg.n_ready,
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
                           'needs_correction', k.needs_correction)
                         order by case k.kind when 'to_review' then 0 else 1 end, k.received_on, k.doc_code)
                    from shown_docs k
                   where k.client_id = pg.client_id), '[]'::jsonb))
             order by pg.rn)
        from page pg), '[]'::jsonb))
    into v;
  return v;
end $$;


-- ── search_clients ──
drop function public.search_clients(text, public.client_type, uuid, boolean, integer, integer, boolean);

create function public.search_clients(
  p_query text default null,
  p_client_type public.client_type default null,
  p_incharge_id uuid default null,
  p_include_archived boolean default false,
  p_limit integer default 50,
  p_offset integer default 0,
  p_has_overdue boolean default false,
  p_mine boolean default false -- 12
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
      join public.client_doc_type pr on pr.id = e.client_doc_type_id
      join public.client_group pg on pg.id = pr.client_group_id
     where e.client_id = c.id
       and c.archived_at is null
       and e.status = 'pending'
       and pr.state <> 'paused'
       and pg.state <> 'paused'
  ) x
  where c.office_id = (select private.current_office_id())
    and (p_include_archived or c.archived_at is null)
    and (p_client_type is null or c.client_type = p_client_type)
    and (p_incharge_id is null or c.incharge_id = p_incharge_id)
    and (not coalesce(p_has_overdue, false) or x.overdue > 0)
    -- 12 (spec AC-27): "My clients" = incharge, or assigned to an active group or plan row (06's effective
    -- assignee). Narrows the list only; RLS decides access as before.
    and (not coalesce(p_mine, false)
         or c.incharge_id = (select private.current_staff_id())
         or exists (select 1 from public.client_group g
                     where g.client_id = c.id and g.state = 'active' and g.assigned_staff_id = (select private.current_staff_id()))
         or exists (select 1 from public.client_doc_type r
                     where r.client_id = c.id and r.state = 'active' and r.assigned_staff_id = (select private.current_staff_id())))
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

revoke all on function public.search_clients(text, public.client_type, uuid, boolean, integer, integer, boolean, boolean) from public, anon;
grant execute on function public.search_clients(text, public.client_type, uuid, boolean, integer, integer, boolean, boolean) to authenticated;

