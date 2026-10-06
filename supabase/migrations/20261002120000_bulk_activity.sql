-- Feature 08 — bulk review, Activity feed, activity visibility (spec AC-3, AC-5 … AC-11).
-- No schema lock. Approved exceptions (Raja 2026-10-02): additive-only (08's own functions) plus the scoped
-- replacement of `activity_select` (intent Q3a). No table, column, index, trigger or other policy changes.
-- The file name's timestamp is replaced by the version apply_migration assigns.
--
-- Rollback (restores 01's policy; the new functions are harmless if left):
--   drop policy activity_select on public.activity;
--   create policy activity_select on public.activity for select to authenticated
--     using (office_id = (select private.current_office_id()));

-- ── 1. Which client an activity row is about (AC-11) ──────────────────────────────────────────────────────────────
-- data.client_id when present (even if malformed → no client); else the entity's client. Definer so the policy
-- can look up entities the reader might not see itself; tenant-first: only rows of the caller's office resolve.
-- No exception blocks (they cost a subtransaction per row): IDs are checked with a regex before any cast.
create or replace function private.activity_client(p_entity_type text, p_entity_id text, p_data jsonb)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare
  v_office uuid := private.current_office_id();
  v_uuid   constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_raw    text;
  v_id     uuid;
  v_client uuid;
begin
  if v_office is null then return null; end if;
  if p_data ? 'client_id' then
    v_raw := p_data->>'client_id';
    if v_raw is null or v_raw !~ v_uuid then return null; end if;
    return v_raw::uuid;
  end if;
  if p_entity_id is null or p_entity_id !~ v_uuid then return null; end if;
  v_id := p_entity_id::uuid;
  case p_entity_type
    when 'client'          then select x.id        into v_client from public.client x          where x.id = v_id and x.office_id = v_office;
    when 'document'        then select x.client_id into v_client from public.document x        where x.id = v_id and x.office_id = v_office;
    when 'expected_doc'    then select x.client_id into v_client from public.expected_doc x    where x.id = v_id and x.office_id = v_office;
    when 'follow_up'       then select x.client_id into v_client from public.follow_up x       where x.id = v_id and x.office_id = v_office;
    when 'dispatch'        then select x.client_id into v_client from public.dispatch x        where x.id = v_id and x.office_id = v_office;
    when 'client_group'    then select x.client_id into v_client from public.client_group x    where x.id = v_id and x.office_id = v_office;
    when 'client_doc_type' then select x.client_id into v_client from public.client_doc_type x where x.id = v_id and x.office_id = v_office;
    else return null;
  end case;
  return v_client;
end $$;

revoke all on function private.activity_client(text, text, jsonb) from public, anon;
grant execute on function private.activity_client(text, text, jsonb) to authenticated;

-- ── 2. activity_select (replaced; scoped exception) ───────────────────────────────────────────────────────────────
-- Admin/Manager/Staff: the whole office (unchanged). Limited: rows they wrote, or rows whose client they can see.
-- The role test comes first and is an initplan, so Staff+ never call the per-row helper.
drop policy activity_select on public.activity;
create policy activity_select on public.activity for select to authenticated
  using (
    office_id = (select private.current_office_id())
    and (
      (select not private.has_role(array['limited']::public.staff_role[]))
      or actor_id = (select private.current_staff_id())
      or private.can_see_client(private.activity_client(entity_type, entity_id, data))
    )
  );

-- ── 3. review_documents (AC-3, AC-4) ──────────────────────────────────────────────────────────────────────────────
-- Loops 07's review_document per distinct ID (input order). Eligibility is read under the caller's RLS first, so
-- an invisible ID is "not_found"; a race (someone reviews in between) is caught per ID in its own sub-transaction,
-- so one document never undoes the others. Unknown errors still abort the call (a bug, not a skip reason).
create or replace function public.review_documents(p_ids uuid[])
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_ids    uuid[];
  v_id     uuid;
  d        record;
  v_reason text;
  v_out    jsonb := '[]'::jsonb;
begin
  if private.current_staff_id() is null then
    raise exception 'ROLE_REQUIRED: sign in as active staff' using errcode = '42501';
  end if;
  select coalesce(array_agg(s.id order by s.ord), '{}') into v_ids
    from (select u.id, min(u.ord) as ord from unnest(coalesce(p_ids, '{}')) with ordinality as u(id, ord)
           where u.id is not null group by u.id) s;
  if cardinality(v_ids) > 200 then
    raise exception 'TOO_MANY: at most 200 documents per call' using errcode = '22023';
  end if;

  foreach v_id in array v_ids loop
    select x.status, x.archived_at, x.client_id, x.doc_type_id into d from public.document x where x.id = v_id;
    v_reason := case
      when not found then 'not_found'
      when d.archived_at is not null then 'archived'
      when d.client_id is null or d.doc_type_id is null then 'in_inbox'
      when d.status = 'reviewed' then 'already_reviewed'
      when d.status = 'needs_correction' then 'needs_correction'
    end;
    if v_reason is null then
      begin
        perform public.review_document(v_id, 'reviewed', null);
      exception when others then
        v_reason := case
          when sqlerrm like 'ALREADY_REVIEWED%' then 'already_reviewed'
          when sqlerrm like 'NOT_CLASSIFIED%' then 'in_inbox'
          when sqlerrm like 'ARCHIVED%' then 'archived'
          when sqlerrm like 'NOT_FOUND%' then 'not_found'
        end;
        if v_reason is null then raise; end if;
      end;
    end if;
    v_out := v_out || jsonb_build_object(
      'id', v_id, 'result', case when v_reason is null then 'reviewed' else 'skipped' end, 'reason', v_reason);
  end loop;
  return v_out;
end $$;

revoke all on function public.review_documents(uuid[]) from public, anon;
grant execute on function public.review_documents(uuid[]) to authenticated;

-- ── 4. activity_feed (AC-5, AC-7 … AC-10) ─────────────────────────────────────────────────────────────────────────
-- One page, newest first by (created_at, id), with display fields joined under the caller's RLS (a client or
-- document the reader can't see comes back with null name/ID). Sign-ins only when `actions` asks for them.
-- Dates are IST calendar days, inclusive. Keyset: `before` = the last row's { at, id } from the previous page.
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

  with page as (
    select a.*
      from public.activity a
     where a.office_id = v_office
       and (v_staff is null or a.actor_id = v_staff)
       and ((v_actions is null and a.action <> 'auth.signed_in') or a.action = any(v_actions))
       and (v_from is null or a.created_at >= v_from)
       and (v_to is null or a.created_at < v_to)
       and (v_before_at is null or (a.created_at, a.id) < (v_before_at, v_before_id))
       and (v_client is null or private.activity_client(a.entity_type, a.entity_id, a.data) = v_client)
       and (v_doc is null
            or (a.entity_type = 'document' and a.entity_id = v_doc::text)
            or (a.data->'document_ids') ? v_doc::text
            or a.data->>'document_id' = v_doc::text)
     order by a.created_at desc, a.id desc
     limit v_limit + 1
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
