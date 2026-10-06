-- Feature 05 — migration B, part 2 of 3: private helpers (section 5 of the reviewed migration B; SQL gate approved by
-- Raja 2026-10-02 13:30). Split from one file only because a single 56 KB apply call kept being cut off.

-- ── 5. Private helpers (SECURITY INVOKER unless noted: RLS and the caller's role apply) ─────────────────
-- The pending rows of p_type's item = proposed rows with the same group + name (case-insensitive; spaces were
-- collapsed by create_proposed_type), earliest first (the survivor). p_lock: lock them, in id order, so two
-- decisions on one item queue up instead of deadlocking; the second then finds nothing pending.
create or replace function private.type_item(p_type uuid, p_lock boolean)
returns uuid[] language plpgsql set search_path = '' as $$
declare r public.doc_type; v uuid[];
begin
  select * into r from public.doc_type where id = p_type and office_id = private.current_office_id();
  if not found then raise exception 'NOT_FOUND: document type' using errcode = 'P0002'; end if;
  if r.status = 'proposed' then
    if p_lock then
      perform 1 from public.doc_type t
        where t.office_id = r.office_id and t.doc_group_id = r.doc_group_id and lower(t.name) = lower(r.name)
          and t.status = 'proposed'
        order by t.id for update;
    end if;
    select array_agg(t.id order by t.created_at, t.id) into v from public.doc_type t
     where t.office_id = r.office_id and t.doc_group_id = r.doc_group_id and lower(t.name) = lower(r.name)
       and t.status = 'proposed';
    if v is not null and p_type = any (v) then return v; end if;
    select * into r from public.doc_type where id = p_type;
  end if;
  if r.decided_at is not null then
    raise exception 'ALREADY_DECIDED: %', r.decided_by using errcode = 'P0001';
  end if;
  raise exception 'NOT_PROPOSED: this type is not waiting for a decision' using errcode = 'P0001';
end $$;

-- Documents of the item whose period doesn't fit p_kind (03's PERIOD_KIND rule).
create or replace function private.period_conflicts(p_rows uuid[], p_kind public.period_kind)
returns table (document_id uuid, doc_code text) language sql stable set search_path = '' as $$
  select d.id, d.doc_code
    from public.document d join public.period p on p.id = d.period_id
   where d.doc_type_id = any (p_rows)
     and not (p_kind in ('month', 'none')
              or (p_kind = 'quarter' and p.kind in ('quarter', 'year'))
              or (p_kind = 'year' and p.kind = 'year'))
   order by d.doc_code
$$;

-- Adds an approved type to a client's plan if it isn't there in any state (spec S1): the type's default schedule
-- from the earliest still-open period (04); the client group row is created or re-enabled as in 03's propose
-- (assigned to the incharge). The new row takes p_state, the proposing row's state before the decision, so a paused or
-- removed row stays so (AC-4). Archived clients are skipped (no plan changes on archived clients). Returns whether a
-- plan row was added.
create or replace function private.plan_add_type(p_client uuid, p_type uuid, p_state public.plan_state)
returns boolean language plpgsql set search_path = '' as $$
declare
  v_office uuid := private.current_office_id();
  v_staff  uuid := private.current_staff_id();
  t public.doc_type;
  v_incharge uuid;
  v_group uuid;
  v_state public.plan_state;
  v_plan uuid;
begin
  if exists (select 1 from public.client_doc_type where client_id = p_client and doc_type_id = p_type) then return false; end if;
  select * into t from public.doc_type where id = p_type and office_id = v_office;
  select c.incharge_id into v_incharge from public.client c
   where c.id = p_client and c.office_id = v_office and c.archived_at is null;
  if not found then return false; end if;
  select g.id, g.state into v_group, v_state from public.client_group g
   where g.client_id = p_client and g.doc_group_id = t.doc_group_id;
  if v_group is null then
    insert into public.client_group (office_id, client_id, doc_group_id, assigned_staff_id, state)
      values (v_office, p_client, t.doc_group_id, v_incharge, 'active') returning id into v_group;
    insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
      values (v_office, v_staff, 'client_group.enabled', 'client_group', v_group::text,
              jsonb_build_object('client_id', p_client, 'doc_group_id', t.doc_group_id));
  elsif v_state = 'removed' then
    update public.client_group set state = 'active' where id = v_group;
    insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
      values (v_office, v_staff, 'client_group.enabled', 'client_group', v_group::text,
              jsonb_build_object('client_id', p_client, 'doc_group_id', t.doc_group_id));
  end if;
  insert into public.client_doc_type (office_id, client_id, doc_type_id, client_group_id, frequency,
      ask_after_months, ask_day, overdue_after_months, overdue_day, reminders, start_period_id, state)
    values (v_office, p_client, t.id, v_group, t.default_frequency, t.ask_after_months, t.ask_day,
            t.overdue_after_months, t.overdue_day, t.reminders,
            private.earliest_open_period(v_office, t.default_frequency, t.overdue_after_months, t.overdue_day,
                                         private.office_today(v_office)), coalesce(p_state, 'active'))
    returning id into v_plan;
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, v_staff, 'client_doc_type.added', 'client_doc_type', v_plan::text,
            jsonb_build_object('client_id', p_client, 'doc_type_id', t.id));
  return true;
end $$;

-- Merges proposed rows into an approved target (AC-5, AC-6): plan rows removed and the target added; every
-- document (archived included) moved with app.type_merge, one document.type_merged row each; the proposed name
-- becomes an alias; the rows are retired. private.link_moved links the moved documents. Callers have locked the
-- rows and checked role, target and period fit. Returns { documents, clients, plan_added, received, plan_removed }.
create or replace function private.merge_rows(p_rows uuid[], p_target uuid, p_comment text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_office  uuid := private.current_office_id();
  v_staff   uuid := private.current_staff_id();
  v_clients uuid[];
  v_name    text;
  v_before  integer;
  v_after   integer;
  v_docs    integer := 0;
  v_added   integer := 0;
  v_removed integer;
  v_states  jsonb;
  v_ids     uuid[] := '{}';
  v_moved   uuid[];
  r uuid;
  c uuid;
begin
  select array_agg(distinct t.proposed_for_client_id) into v_clients from public.doc_type t where t.id = any (p_rows);
  select t.name into v_name from public.doc_type t where t.id = p_rows[1]; -- the earliest row's spelling
  -- Each client's proposed plan row state before the decision (a client has one row per item: names are unique per
  -- group per client). 'active' wins if, unusually, there are several.
  select jsonb_object_agg(client_id, st) into v_states from (
    select r2.client_id, (array_agg(r2.state order by r2.state))[1]::text as st
      from public.client_doc_type r2 where r2.doc_type_id = any (p_rows) group by r2.client_id) x;
  select count(*) into v_before from public.expected_doc
   where doc_type_id = p_target and client_id = any (v_clients) and status = 'received';

  with removed as (
    update public.client_doc_type set state = 'removed'
     where doc_type_id = any (p_rows) and state <> 'removed'
    returning id, client_id)
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    select v_office, v_staff, 'client_doc_type.removed', 'client_doc_type', id::text,
           jsonb_build_object('fields', jsonb_build_array('state'), 'client_id', client_id)
      from removed;
  get diagnostics v_removed = row_count;
  foreach c in array v_clients loop
    if private.plan_add_type(c, p_target, coalesce((v_states->>c::text)::public.plan_state, 'active')) then
      v_added := v_added + 1;
    end if;
  end loop;

  foreach r in array p_rows loop
    perform private.begin_doc_write();
    perform set_config('app.type_merge', r::text, true);
    with moved as (
      update public.document set doc_type_id = p_target
       where office_id = v_office and doc_type_id = r
      returning id, client_id),
    logged as (
      insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
        select v_office, v_staff, 'document.type_merged', 'document', id::text,
               jsonb_build_object('client_id', client_id, 'from_type_id', r, 'to_type_id', p_target)
          from moved)
    select coalesce(array_agg(id), '{}') into v_moved from moved;
    v_ids := v_ids || v_moved;
  end loop;
  perform set_config('app.type_merge', '', true);
  v_docs := cardinality(v_ids);
  perform private.link_moved(v_ids); -- 04's linking, set-based (the AFTER trigger skipped these rows)

  update public.doc_type t set aliases = t.aliases || v_name
   where t.id = p_target and lower(t.name) <> lower(v_name)
     and not exists (select 1 from unnest(t.aliases) a where lower(a) = lower(v_name));

  perform set_config('app.type_decision', 'on', true);
  update public.doc_type set status = 'mapped', active = false, mapped_to_id = p_target,
      decided_by = v_staff, decided_at = now(), decision_comment = p_comment
   where id = any (p_rows);
  perform set_config('app.type_decision', '', true);

  select count(*) into v_after from public.expected_doc
   where doc_type_id = p_target and client_id = any (v_clients) and status = 'received';
  return jsonb_build_object('documents', v_docs, 'clients', cardinality(v_clients), 'plan_added', v_added,
                            'received', v_after - v_before, 'plan_removed', v_removed);
end $$;

create or replace function private.decision_comment(p_comment text)
returns text language plpgsql immutable set search_path = '' as $$
declare v text := nullif(btrim(coalesce(p_comment, '')), '');
begin
  if length(v) > 500 then raise exception 'COMMENT_TOO_LONG: a comment has at most 500 characters' using errcode = '23514'; end if;
  return v;
end $$;

create or replace function private.require_decider()
returns void language plpgsql stable set search_path = '' as $$
begin
  if not private.has_role(array['admin', 'manager']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: only Admin or Manager can decide proposed types' using errcode = '42501';
  end if;
end $$;

-- An approved, active, client-source type of this office that isn't part of the item.
create or replace function private.merge_target(p_target uuid, p_rows uuid[])
returns public.doc_type language plpgsql set search_path = '' as $$
declare t public.doc_type;
begin
  select * into t from public.doc_type
   where id = p_target and office_id = private.current_office_id() for share;
  if not found or t.status <> 'approved' or not t.active or t.source <> 'client' or t.id = any (p_rows) then
    raise exception 'TARGET_INVALID: merge into an approved, active type collected from the client' using errcode = '23514';
  end if;
  return t;
end $$;

-- Merge core (AC-5 … AC-7, AC-14, AC-13).
create or replace function private.decide_merge(p_type uuid, p_target uuid, p_comment text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_comment text;
  v_rows uuid[];
  t public.doc_type;
  v_bad integer;
  v_res jsonb;
begin
  perform private.require_decider();
  v_comment := private.decision_comment(p_comment);
  v_rows := private.type_item(p_type, true);
  t := private.merge_target(p_target, v_rows);
  select count(*) into v_bad from private.period_conflicts(v_rows, t.period_kind);
  if v_bad > 0 then
    raise exception 'PERIOD_KIND: % documents don''t fit a % type', v_bad, t.period_kind using errcode = '23514';
  end if;
  v_res := private.merge_rows(v_rows, t.id, v_comment);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (private.current_office_id(), private.current_staff_id(), 'doc_type.merged', 'doc_type', v_rows[1]::text,
            jsonb_build_object('doc_type_ids', to_jsonb(v_rows), 'target_id', t.id, 'documents', v_res->'documents',
                               'clients', v_res->'clients', 'plan_rows', jsonb_build_object('removed', v_res->'plan_removed',
                               'added', v_res->'plan_added')));
  perform private.notify((select array_agg(distinct x.proposed_by) from public.doc_type x where x.id = any (v_rows)),
                         'type_decision', 'doc_type', v_rows[1],
                         jsonb_build_object('decision', 'merged', 'doc_type_id', v_rows[1], 'target_id', t.id));
  return v_res - 'plan_removed';
end $$;

-- Approve / Edit & approve core (AC-2 … AC-4). edits = 02's add-type fields; absent keys keep the survivor's value.
create or replace function private.decide_approve(p jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_office  uuid := private.current_office_id();
  v_staff   uuid := private.current_staff_id();
  v_type    uuid := nullif(p->>'type_id', '')::uuid;
  e         jsonb := coalesce(p->'edits', '{}'::jsonb);
  v_comment text;
  v_rows    uuid[];
  s public.doc_type;
  n public.doc_type;
  v_id      uuid;
  v_bad     integer;
  v_res     jsonb := jsonb_build_object('documents', 0, 'clients', 1, 'plan_added', 0, 'received', 0, 'plan_removed', 0);
  v_before  integer;
  v_after   integer;
  v_old_name text;
  v_docs    integer;
  v_clients integer;
begin
  perform private.require_decider();
  v_comment := private.decision_comment(p->>'comment');
  v_rows := private.type_item(v_type, true);
  select count(*) into v_docs from public.document d where d.doc_type_id = any (v_rows);
  select count(distinct t.proposed_for_client_id) into v_clients from public.doc_type t where t.id = any (v_rows);
  select * into s from public.doc_type where id = v_rows[1];
  v_old_name := s.name;
  n := s;
  if e ? 'name' then n.name := btrim(regexp_replace(coalesce(e->>'name', ''), '\s+', ' ', 'g')); end if;
  if e ? 'doc_group_id' then n.doc_group_id := (e->>'doc_group_id')::uuid; end if;
  if e ? 'period_kind' then n.period_kind := (e->>'period_kind')::public.period_kind; end if;
  if e ? 'default_frequency' then n.default_frequency := (e->>'default_frequency')::public.frequency; end if;
  if e ? 'ask_after_months' then n.ask_after_months := (e->>'ask_after_months')::smallint; end if;
  if e ? 'ask_day' then n.ask_day := (e->>'ask_day')::smallint; end if;
  if e ? 'overdue_after_months' then n.overdue_after_months := (e->>'overdue_after_months')::smallint; end if;
  if e ? 'overdue_day' then n.overdue_day := (e->>'overdue_day')::smallint; end if;
  if e ? 'registration_kind' then n.registration_kind := (e->>'registration_kind')::public.registration_kind; end if;
  if e ? 'reminders' then n.reminders := coalesce((e->>'reminders')::boolean, false); end if;
  if e ? 'aliases' then
    n.aliases := coalesce((select array_agg(distinct btrim(x)) from jsonb_array_elements_text(e->'aliases') x
                            where btrim(x) <> ''), '{}');
  end if;
  if lower(n.name) <> lower(v_old_name)
     and not exists (select 1 from unnest(n.aliases) a where lower(a) = lower(v_old_name)) then
    n.aliases := n.aliases || v_old_name; -- renamed: the proposed name stays findable (AC-3)
  end if;
  if length(n.name) not between 1 and 120 then
    raise exception 'NAME_INVALID: a type name has 1–120 characters' using errcode = '23514';
  end if;
  if not exists (select 1 from public.doc_group g where g.id = n.doc_group_id and g.office_id = v_office and g.active) then
    raise exception 'NOT_FOUND: group' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.doc_type t where t.office_id = v_office and t.doc_group_id = n.doc_group_id
              and lower(t.name) = lower(n.name) and t.status = 'approved') then
    raise exception 'DUPLICATE_TYPE: an approved type with this name already exists in this group' using errcode = '23505';
  end if;
  select count(*) into v_bad from private.period_conflicts(v_rows, n.period_kind);
  if v_bad > 0 then
    raise exception 'PERIOD_KIND: % documents don''t fit a % type', v_bad, n.period_kind using errcode = '23514';
  end if;

  if n.doc_group_id = s.doc_group_id then
    -- Same group: the survivor itself becomes the approved type.
    perform set_config('app.type_decision', 'on', true);
    update public.doc_type set name = n.name, aliases = n.aliases, period_kind = n.period_kind,
        default_frequency = n.default_frequency, ask_after_months = n.ask_after_months, ask_day = n.ask_day,
        overdue_after_months = n.overdue_after_months, overdue_day = n.overdue_day,
        registration_kind = n.registration_kind, reminders = n.reminders,
        status = 'approved', active = true, proposed_for_client_id = null,
        decided_by = v_staff, decided_at = now(), decision_comment = v_comment
     where id = s.id;
    perform set_config('app.type_decision', '', true);
    v_id := s.id;
    select count(*) into v_before from public.expected_doc where doc_type_id = v_id and status = 'received';
    -- AC-4: the survivor's plan row takes the approved schedule (state kept; 04's triggers generate if active).
    with changed as (
      update public.client_doc_type r
         set frequency = n.default_frequency, ask_after_months = n.ask_after_months, ask_day = n.ask_day,
             overdue_after_months = n.overdue_after_months, overdue_day = n.overdue_day, reminders = n.reminders,
             start_period_id = case when n.default_frequency = 'as_needed' then r.start_period_id
                                    else private.earliest_open_period(v_office, n.default_frequency, n.overdue_after_months,
                                                                      n.overdue_day, private.office_today(v_office)) end
       where r.doc_type_id = v_id
         and (r.frequency, r.ask_after_months, r.ask_day, r.overdue_after_months, r.overdue_day, r.reminders)
             is distinct from
             (n.default_frequency, n.ask_after_months, n.ask_day, n.overdue_after_months, n.overdue_day, n.reminders)
      returning r.id, r.client_id)
    insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
      select v_office, v_staff, 'client_doc_type.updated', 'client_doc_type', id::text,
             jsonb_build_object('fields', jsonb_build_array('frequency', 'schedule', 'reminders', 'start_period_id'),
                                'client_id', client_id)
        from changed;
    select count(*) into v_after from public.expected_doc where doc_type_id = v_id and status = 'received';
    if cardinality(v_rows) > 1 then
      v_res := private.merge_rows(v_rows[2:], v_id, v_comment);
    end if;
    v_res := jsonb_set(v_res, '{received}', to_jsonb((v_res->>'received')::integer + v_after - v_before));
  else
    -- Group change: plan rows can't move (02), so a new approved type in the new group takes the whole item.
    insert into public.doc_type (office_id, doc_group_id, code, name, aliases, period_kind, default_frequency, source,
        ask_after_months, ask_day, overdue_after_months, overdue_day, registration_kind, reminders, status, proposed_by, active)
      values (v_office, n.doc_group_id, 't_' || replace(gen_random_uuid()::text, '-', ''), n.name, n.aliases, n.period_kind,
              n.default_frequency, 'client', n.ask_after_months, n.ask_day, n.overdue_after_months, n.overdue_day,
              n.registration_kind, n.reminders, 'approved', s.proposed_by, true)
      returning id into v_id;
    perform set_config('app.type_decision', 'on', true);
    update public.doc_type set decided_by = v_staff, decided_at = now(), decision_comment = v_comment where id = v_id;
    perform set_config('app.type_decision', '', true);
    -- The proposed name is the new type's own name or already an alias; merge_rows won't add it twice.
    v_res := private.merge_rows(v_rows, v_id, v_comment);
  end if;

  v_res := v_res || jsonb_build_object('documents', v_docs, 'clients', v_clients);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, v_staff, 'doc_type.approved', 'doc_type', v_rows[1]::text,
            jsonb_build_object('doc_type_ids', to_jsonb(v_rows), 'type_id', v_id, 'documents', v_res->'documents',
                               'clients', v_res->'clients', 'plan_rows', jsonb_build_object('removed', v_res->'plan_removed',
                               'added', v_res->'plan_added'), 'fields',
                               (select coalesce(jsonb_agg(k), '[]') from jsonb_object_keys(e) k)));
  perform private.notify((select array_agg(distinct x.proposed_by) from public.doc_type x where x.id = any (v_rows)),
                         'type_decision', 'doc_type', v_rows[1],
                         jsonb_strip_nulls(jsonb_build_object('decision', 'approved', 'doc_type_id', v_rows[1],
                           'target_id', case when v_id <> v_rows[1] then v_id end)));
  return (v_res - 'plan_removed') || jsonb_build_object('type_id', v_id);
end $$;

revoke all on function private.type_item(uuid, boolean), private.period_conflicts(uuid[], public.period_kind),
  private.plan_add_type(uuid, uuid, public.plan_state), private.merge_rows(uuid[], uuid, text), private.decision_comment(text),
  private.require_decider(), private.merge_target(uuid, uuid[]), private.decide_merge(uuid, uuid, text),
  private.decide_approve(jsonb) from public, anon;
grant execute on function private.type_item(uuid, boolean), private.period_conflicts(uuid[], public.period_kind),
  private.plan_add_type(uuid, uuid, public.plan_state), private.merge_rows(uuid[], uuid, text), private.decision_comment(text),
  private.require_decider(), private.merge_target(uuid, uuid[]), private.decide_merge(uuid, uuid, text),
  private.decide_approve(jsonb) to authenticated;
