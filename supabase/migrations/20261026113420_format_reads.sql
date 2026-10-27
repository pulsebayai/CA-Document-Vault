-- 11-file-type-rules · migration B: what reads the format check (spec AC-9, AC-12, AC-13, AC-21, AC-22, AC-24; plan step 6).
-- Four existing functions are replaced with the same signatures and grants; only the marked 11 lines are new.
-- Nothing here refuses a file: 10's check order, caps, throttles and refusals in link_register are unchanged.

-- 03b's search (20261001123125, 07's version): filter format = not_preferred; rows carry the check for the badge.
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
  v_result   jsonb;
begin
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
           case when di.id is not null then 'dispatched'
                when d.received_as = 'original' and d.client_id is not null and d.doc_type_id is not null
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

-- 03b's facets (20261001123125): a 'format' facet; every other facet respects the format filter (03b AC-7).
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
begin
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
                when d.received_as = 'original' and d.client_id is not null and d.doc_type_id is not null
                     and d.archived_at is null and d.status in ('reviewed', 'needs_correction') then 'ready' end as return_state,
           (v_group is null   or t.doc_group_id = v_group) as ok_group,
           (v_as is null      or d.received_as = v_as)     as ok_as,
           (v_channel is null or d.channel = v_channel)    as ok_channel,
           (v_by is null      or d.received_by = v_by)     as ok_by,
           (v_status is null  or d.status = v_status)      as ok_status,
           (v_return is null  or (case when di.id is not null then 'dispatched'
                when d.received_as = 'original' and d.client_id is not null and d.doc_type_id is not null
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

-- 10's link_open (20261025163857): each item gains `preferred` when a preference applies to this client.
create or replace function public.link_open(p_token_hash text, p_ip_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.upload_request; v_items jsonb;
begin
  r := private.link_request(p_token_hash, p_ip_hash);
  if r.id is null then return jsonb_build_object('active', false); end if;
  select coalesce(jsonb_agg(x.j order by x.sort, x.created_at), '[]'::jsonb) into v_items from (
    select it.created_at, case it.kind when 'scheduled' then 0 else 1 end as sort,
           jsonb_strip_nulls(jsonb_build_object(
             'id', it.id, 'kind', it.kind,
             'group', g.name, 'type', t.name, 'period', p.label,
             'state_code', case when t.registration_kind = 'gstin' then reg.state_code end,
             'reg_kind', t.registration_kind,
             'needed_by', it.needed_by, 'note', it.note,
             -- 11 (spec AC-9, AC-12): the formats this item prefers; absent with no preference or a client exception.
             'preferred', case when t.preferred_formats is not null and not exists (
                            select 1 from public.client_doc_type x
                             where x.office_id = r.office_id and x.client_id = r.client_id and x.doc_type_id = t.id and x.any_format)
                          then to_jsonb(t.preferred_formats) end,
             'received', case when it.kind = 'scheduled' then e.status = 'received' else it.status = 'received' end,
             'files', (select count(*) from public.document d where d.upload_request_item_id = it.id and d.archived_at is null
                        and d.client_id = r.client_id and d.doc_type_id = coalesce(e.doc_type_id, it.doc_type_id)))) as j
      from public.upload_request_item it
      left join public.expected_doc e on e.id = it.expected_doc_id
      join public.doc_type t on t.id = coalesce(e.doc_type_id, it.doc_type_id)
      join public.doc_group g on g.id = t.doc_group_id
      left join public.period p on p.id = coalesce(e.period_id, it.period_id)
      left join public.client_registration reg on reg.id = coalesce(e.registration_id, it.registration_id)
     where it.request_id = r.id
       and ((it.kind = 'scheduled' and e.status in ('pending', 'received'))
         or (it.kind = 'ad_hoc' and it.status in ('open', 'received')))) x;
  return jsonb_build_object(
    'active', true,
    'firm', (select o.name from public.office o where o.id = r.office_id),
    'requester', (select split_part(btrim(s.full_name), ' ', 1) from public.staff_user s where s.id = r.created_by),
    'sent_on', (r.created_at at time zone 'Asia/Kolkata')::date,
    'open_until', ((r.expires_at at time zone 'Asia/Kolkata')::date - 1),
    'files_count', r.files_count, 'max_files', r.max_files, 'bytes_total', r.bytes_total, 'max_bytes', r.max_bytes,
    'items', v_items);
end $$;

-- 10's link_register (20261025163857): `warned` (from the page) on its document.link_upload activity row.
create or replace function public.link_register(p_token_hash text, p_item_id uuid, p_file jsonb, p_ip_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.upload_request; i public.upload_request_item; e public.expected_doc;
  v_path text := p_file->>'storage_path'; v_doc uuid; v_size bigint; v_res jsonb; d public.document;
  v_type uuid; v_period uuid; v_reg uuid; v_ext text; v_name text;
begin
  r := private.link_request(p_token_hash, p_ip_hash);
  if r.id is null then return jsonb_build_object('error', 'NOT_ACTIVE'); end if;  -- keeps the AC-9 log row
  select * into r from public.upload_request where id = r.id for update;  -- review I6: caps under the row lock
  i := private.link_item(r.id, p_item_id);
  v_doc := private.document_id_from_path(v_path, r.office_id);   -- PATH: must be under the link's own office
  v_ext := substring(v_path from '\.([a-z]+)$');
  if not private.link_ext_allowed(v_ext) then
    raise exception 'FILE_TYPE_NOT_ALLOWED: send PDF, JPG, PNG, HEIC, Excel, CSV or Word files' using errcode = '22023';
  end if;
  select * into d from public.document where id = v_doc;
  if d.id is not null then
    if d.upload_request_item_id = i.id then
      return jsonb_build_object('document_id', d.id, 'doc_code', d.doc_code, 'duplicate', true);
    end if;
    raise exception 'DUPLICATE: this file is already registered' using errcode = '23505';
  end if;
  select (o.metadata->>'size')::bigint into v_size from storage.objects o where o.bucket_id = 'documents' and o.name = v_path;
  if v_size is null then raise exception 'OBJECT_MISSING: the uploaded file was not found in storage' using errcode = '23514'; end if;
  if r.files_count >= r.max_files or r.bytes_total + v_size > r.max_bytes then
    raise exception 'CAP_REACHED: this link has received the maximum number of files' using errcode = '54000';
  end if;
  if i.kind = 'scheduled' then
    select * into e from public.expected_doc where id = i.expected_doc_id;
    v_type := e.doc_type_id; v_period := e.period_id; v_reg := e.registration_id;
  else
    v_type := i.doc_type_id; v_period := i.period_id; v_reg := i.registration_id;
  end if;
  -- Review B1: the stored name always ends in the stored object's extension, whatever name the browser sent
  -- ("invoice.exe" becomes "invoice.pdf"), so a download can never save as another type. 03's checks still apply.
  v_name := btrim(regexp_replace(coalesce(p_file->>'file_name', ''), '\.[^./\\]*$', ''), ' .');
  if v_name = '' then v_name := 'file'; end if;
  v_name := left(v_name, 170) || '.' || v_ext;
  -- 03's own filing path with the requester's identity (link_request set the JWT claims). NB: create_document is
  -- invoker, but called from this definer function it runs as the owner, so RLS policies do NOT apply here; the
  -- office, link, item and can_see_client checks above are the authorisation. Triggers that read auth.uid() see
  -- the requester.
  perform set_config('app.link_register', 'on', true);
  v_res := public.create_document(jsonb_build_object(
    'client_id', r.client_id, 'doc_type_id', v_type, 'period_id', v_period, 'registration_id', v_reg,
    'received_as', 'soft_copy', 'channel', 'upload_link',
    'file', jsonb_build_object('storage_path', v_path, 'file_name', v_name)));
  perform set_config('app.link_register', '', true);
  perform private.begin_doc_write();
  update public.document set upload_request_item_id = i.id where id = (v_res->>'id')::uuid;
  perform set_config('app.upload_write', 'on', true);
  update public.upload_request set files_count = files_count + 1, bytes_total = bytes_total + v_size where id = r.id;
  perform set_config('app.upload_write', '', true);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (r.office_id, null, 'document.link_upload', 'document', v_res->>'id',
            jsonb_build_object('client_id', r.client_id, 'request_id', r.id, 'item_id', i.id,
                               -- 11 (spec AC-13): did the page warn about the format? Untrusted; metric only.
                               'warned', case when jsonb_typeof(p_file->'warned') = 'boolean' then (p_file->>'warned')::boolean else false end));
  -- D6: one bell notification to the requester per link per day (IDs only; text built at display time).
  if not exists (select 1 from public.notification n
                  where n.kind = 'link_upload' and n.entity_id = r.id
                    and (n.created_at at time zone 'Asia/Kolkata')::date = (now() at time zone 'Asia/Kolkata')::date) then
    perform private.notify(array[r.created_by], 'link_upload', 'upload_request', r.id, jsonb_build_object('request_id', r.id));
  end if;
  return jsonb_build_object('document_id', v_res->>'id', 'doc_code', v_res->>'doc_code', 'duplicate', false);
end $$;

-- Settings › Collection, "Preferred formats" (spec AC-24, S7). Admin/Manager, like 10's link_metric.
create or replace function public.format_metric(p_from date, p_to date)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_office uuid := private.current_office_id(); v jsonb;
begin
  if not private.has_role(array['admin', 'manager']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: only Admin or Manager can see the collection figures' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'BAD_WINDOW: from must be on or before to' using errcode = '22023';
  end if;
  with docs as (
    -- Filed in the window (IST day), not archived, and a preference applied when filed.
    select d.id, d.created_at, d.format_ok, d.channel = 'upload_link' as via_link
      from public.document d
     where d.office_id = v_office and d.classified_at is not null and d.archived_at is null and d.format_ok is not null
       and (d.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to
  ), links as (
    select k.*,
           coalesce((select (a.data->>'warned')::boolean from public.activity a
                      where a.office_id = v_office and a.action = 'document.link_upload' and a.entity_id::text = k.id::text
                      limit 1), false) as warned,
           (select min(r.created_at) from public.document_review r
             where r.document_id = k.id and r.outcome in ('reviewed', 'needs_correction')) as first_review
      from docs k where k.via_link
  )
  select jsonb_build_object(
    'applied', jsonb_build_object(
      'link', jsonb_build_object('total', (select count(*) from docs where via_link),
                                 'preferred', (select count(*) from docs where via_link and format_ok)),
      'staff', jsonb_build_object('total', (select count(*) from docs where not via_link),
                                  'preferred', (select count(*) from docs where not via_link and format_ok))),
    'warned', jsonb_build_object('total', (select count(*) from links where warned),
                                 'switched', (select count(*) from links where warned and format_ok),
                                 'anyway', (select count(*) from links where warned and not format_ok)),
    'flagged_review_hours_median', (select round((percentile_cont(0.5) within group (
                                      order by extract(epoch from first_review - created_at) / 3600.0))::numeric, 1)
                                     from links where not format_ok and first_review is not null),
    'exceptions', coalesce((select jsonb_agg(jsonb_build_object('type_id', e.doc_type_id, 'type', e.name, 'n', e.n) order by e.n desc, e.name)
                              from (select x.doc_type_id, t.name, count(*)::integer as n
                                      from public.client_doc_type x join public.doc_type t on t.id = x.doc_type_id
                                     where x.office_id = v_office and x.any_format
                                     group by x.doc_type_id, t.name order by count(*) desc, t.name limit 5) e), '[]'::jsonb))
    into v;
  return v;
end $$;
revoke all on function public.format_metric(date, date) from public, anon;
grant execute on function public.format_metric(date, date) to authenticated;
