-- Feature 10 step 13 — fixes from the pre-PR review of 10b (plan.md Deviations, step 13).
--   I-1  create_document_for_item refuses a client / type / period / registration other than the item's
--        (ITEM_MISMATCH) instead of overwriting them silently.
--   I-2  05's merge of a proposed type re-points ad-hoc items that ask for it to the target type and re-checks them
--        (doc_type trigger), so a received item doesn't reopen after its documents move to the approved type.
--   N-6  Send again re-checks that a carried item's type can still be requested.
--   N-2/3/4  today_items: 06's card order is restored (expected overdue only, AC-17 "order unchanged"); cards gain
--        requested_overdue for the badge.

-- ── 1 ─────────────────────────────────────────────────────────────────────
create or replace function public.create_document_for_item(p_item uuid, p jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare i public.upload_request_item; v_client uuid; v_res jsonb;
begin
  select * into i from public.upload_request_item where id = p_item;   -- RLS: only items of visible clients
  if not found then raise exception 'NOT_FOUND: requested document' using errcode = 'P0002'; end if;
  select q.client_id into v_client from public.upload_request q where q.id = i.request_id;
  if i.kind <> 'ad_hoc' or i.status not in ('open', 'received') then  -- D4: a received item still takes files
    raise exception 'ITEM_STATE: this requested document was cancelled' using errcode = 'P0001';
  end if;
  -- Review 10b I-1: what the form sent must be what was requested; nothing is silently changed.
  if (nullif(p->>'client_id', '') is not null and (p->>'client_id')::uuid is distinct from v_client)
     or (nullif(p->>'doc_type_id', '') is not null and (p->>'doc_type_id')::uuid is distinct from i.doc_type_id)
     or (i.period_id is not null and nullif(p->>'period_id', '') is not null and (p->>'period_id')::uuid is distinct from i.period_id)
     or (i.registration_id is not null and nullif(p->>'registration_id', '') is not null
         and (p->>'registration_id')::uuid is distinct from i.registration_id) then
    raise exception 'ITEM_MISMATCH: a requested document is filed with the client, type and period that were requested' using errcode = '22023';
  end if;
  v_res := public.create_document(coalesce(p, '{}'::jsonb) || jsonb_build_object(
    'client_id', v_client, 'doc_type_id', i.doc_type_id,
    'period_id', coalesce(i.period_id::text, nullif(p->>'period_id', '')),
    'registration_id', coalesce(i.registration_id::text, nullif(p->>'registration_id', ''))));
  perform private.link_document_to_item((v_res->>'id')::uuid, p_item);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (i.office_id, private.current_staff_id(), 'upload_request_item.filed', 'upload_request_item', p_item::text,
            jsonb_build_object('client_id', v_client, 'document_id', v_res->>'id'));
  return v_res;
end $$;

-- ── 2 ─────────────────────────────────────────────────────────────────────
create or replace function private.doc_type_after_mapped()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_item uuid;
begin
  perform set_config('app.upload_write', 'on', true);
  for v_item in
    update public.upload_request_item set doc_type_id = new.mapped_to_id
     where office_id = new.office_id and kind = 'ad_hoc' and doc_type_id = new.id
    returning id
  loop
    perform private.recompute_request_item(v_item);
  end loop;
  perform set_config('app.upload_write', '', true);
  return null;
end $$;
revoke all on function private.doc_type_after_mapped() from public, anon, authenticated;
create trigger doc_type_after_mapped after update of status on public.doc_type
  for each row when (new.status = 'mapped' and old.status is distinct from 'mapped' and new.mapped_to_id is not null)
  execute function private.doc_type_after_mapped();

-- ── 3 ─────────────────────────────────────────────────────────────────────
create or replace function private.insert_upload_request(p_client uuid, p_follow_up uuid, p_token_hash text,
  p_items jsonb, p_replaces uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_office uuid := private.current_office_id(); v_me uuid := private.current_staff_id();
  v_id uuid; v_exp timestamptz; e jsonb; n_s int := 0; n_a int := 0; n_c int := 0;
begin
  if v_office is null or v_me is null
     or not exists (select 1 from public.client where id = p_client and office_id = v_office and archived_at is null)
     or not private.can_see_client(p_client) then
    raise exception 'NOT_FOUND: client' using errcode = 'P0002';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'BAD_TOKEN_HASH' using errcode = '22023';
  end if;
  if p_follow_up is not null and not exists (
       select 1 from public.follow_up f where f.id = p_follow_up and f.client_id = p_client and f.sent_by = v_me) then
    raise exception 'NOT_FOUND: follow-up' using errcode = 'P0002';
  end if;
  if p_replaces is not null then
    -- Review I1: "Send again" revokes the old link, so it follows the matrix row "Revoke an upload link someone
    -- else sent": your own link, or Admin/Manager. Checked before anything is written.
    if not exists (select 1 from public.upload_request q where q.id = p_replaces and q.office_id = v_office
                     and (q.created_by = v_me or private.has_role(array['admin', 'manager']::public.staff_role[]))) then
      raise exception 'NOT_FOUND: the request to replace' using errcode = 'P0002';
    end if;
  end if;
  v_exp := private.upload_expires_at(v_office);
  insert into public.upload_request (office_id, client_id, token_hash, created_by, expires_at, follow_up_id)
    values (v_office, p_client, p_token_hash, v_me, v_exp, p_follow_up)
    returning id into v_id;
  for e in select * from jsonb_array_elements(p_items) loop
    if e->>'kind' = 'scheduled' then
      insert into public.upload_request_item (office_id, request_id, kind, expected_doc_id)
        values (v_office, v_id, 'scheduled', (e->>'expected_doc_id')::uuid);
      n_s := n_s + 1;
    elsif e->>'kind' = 'carry' then
      -- Step 9: the item keeps its identity (and any documents linked to it) and moves to the new request.
      if p_replaces is null then
        raise exception 'ITEM_STATE: only Send again can carry a requested document over' using errcode = 'P0001';
      end if;
      -- Review 10b N-6: a carried item's type must still be one the client can be asked for.
      if not exists (select 1 from public.upload_request_item ci join public.doc_type t on t.id = ci.doc_type_id
                      where ci.id = (e->>'item_id')::uuid and t.active and t.source = 'client'
                        and (t.status = 'approved' or (t.status = 'proposed' and t.proposed_for_client_id = p_client))) then
        raise exception 'ITEM_STATE: a requested document''s type is no longer offered; cancel it and request it again' using errcode = 'P0001';
      end if;
      perform set_config('app.upload_write', 'on', true);
      update public.upload_request_item set request_id = v_id
       where id = (e->>'item_id')::uuid and request_id = p_replaces and office_id = v_office
         and kind = 'ad_hoc' and status = 'open';
      if not found then
        raise exception 'ITEM_STATE: a requested document changed meanwhile; refresh and try again' using errcode = 'P0001';
      end if;
      perform set_config('app.upload_write', '', true);
      n_c := n_c + 1;
    else
      insert into public.upload_request_item (office_id, request_id, kind, doc_type_id, period_id, registration_id,
          needed_by, note)
        values (v_office, v_id, 'ad_hoc', (e->>'doc_type_id')::uuid, nullif(e->>'period_id', '')::uuid,
                nullif(e->>'registration_id', '')::uuid, nullif(e->>'needed_by', '')::date, nullif(e->>'note', ''));
      n_a := n_a + 1;
    end if;
  end loop;
  if p_replaces is not null then
    perform set_config('app.upload_write', 'on', true);
    update public.upload_request
       set revoked_at = coalesce(revoked_at, now()), revoked_by = coalesce(revoked_by, v_me), replaced_by = v_id
     where id = p_replaces and office_id = v_office and client_id = p_client and replaced_by is null;
    if not found then
      raise exception 'NOT_FOUND: the request to replace' using errcode = 'P0002';
    end if;
    perform set_config('app.upload_write', '', true);
  end if;
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, v_me, 'upload_request.created', 'upload_request', v_id::text, jsonb_strip_nulls(jsonb_build_object(
      'client_id', p_client, 'follow_up_id', p_follow_up, 'scheduled', n_s, 'ad_hoc', n_a + n_c, 'replaces', p_replaces)));
  return jsonb_build_object('request_id', v_id, 'expires_at', v_exp);
end $$;

-- ── 4 ─────────────────────────────────────────────────────────────────────
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
    select d.id, d.client_id, d.doc_code, d.received_as, d.received_on,
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
            or (d.received_as = 'original' and d.status in ('reviewed', 'needs_correction')
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
                           'type', k.type_name, 'period', k.period_label, 'received_as', k.received_as,
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
