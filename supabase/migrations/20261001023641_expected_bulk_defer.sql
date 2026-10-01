-- Feature 04 follow-up (Raja 2026-10-01, option A): bulk paths generate expected items once per client.
-- Why: 04's per-row plan/registration triggers called generate_expected for every inserted row. A 200-client import
-- chunk (GSTIN + TAN + GST group each) went from 2.85 s to 9.36 s, past the 8 s statement limit for app users, and
-- the nightly import-timing test (02 AC-17) failed (run 36792152274).
-- How: while app.expected_defer is on (set only by the bulk functions below), the four AFTER triggers still waive and
-- restore per row, but instead of generating they note the client. The outermost bulk call then generates for all
-- noted clients in ONE set-based statement (generate_expected_for). A nested bulk call (import → enable group) leaves
-- the flush to the outer one. generate_expected keeps its signature and behaviour, as a wrapper over the new function.
-- Results are unchanged: generation is idempotent and per client covers every active row (the group and registration
-- triggers already generated per client). Test: expected-docs › "bulk paths generate once per client".
-- Measured on dev (rolled back), one 200-client import chunk with GSTIN + GST: 2.85 s without 04's triggers,
-- 9.36 s with them (before), 5.37 s deferring with one call per client, 3.01 s with this set-based flush.
-- Schema lock: 04. Changes 04's triggers and enable_group_core, plus 02's import_clients and create_client.

-- ── Defer helpers ──────────────────────────────────────────────────────────
create or replace function private.expected_deferred()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('app.expected_defer', true), '') = 'on'
$$;

create or replace function private.expected_note_client(p_client uuid)
returns void language plpgsql set search_path = '' as $$
declare v text := coalesce(current_setting('app.expected_clients', true), '');
begin
  if strpos(v, p_client::text) = 0 then
    perform set_config('app.expected_clients', v || p_client::text || ',', true);
  end if;
end $$;

-- Returns whether generation was already deferred (by an outer bulk call); pass it to expected_defer_end.
create or replace function private.expected_defer_begin()
returns boolean language plpgsql set search_path = '' as $$
declare v_outer boolean := private.expected_deferred();
begin
  if not v_outer then
    perform set_config('app.expected_defer', 'on', true);
    perform set_config('app.expected_clients', '', true);
  end if;
  return v_outer;
end $$;

-- Generation for a set of clients (null = the whole office), optionally one plan row. Same rules as before (AC-1,
-- AC-2, AC-5, AC-12); only the client filter takes an array. Documents filed earlier are linked per client, and only
-- when the client has unlinked documents (new clients from an import have none).
create or replace function private.generate_expected_for(p_office uuid, p_clients uuid[], p_row uuid, p_today date,
  out created integer, out linked integer)
language plpgsql security definer set search_path = '' as $$
declare c uuid; v_n integer;
begin
  with cand as (
    select r.office_id, r.client_id, r.id as row_id, r.doc_type_id, p.id as period_id, reg.id as registration_id,
           private.offset_date(p.end_date, r.ask_after_months, r.ask_day) as ask_on,
           private.offset_date(p.end_date, r.overdue_after_months, r.overdue_day) as overdue_from,
           greatest(r.resumed_on, g.resumed_on) as resumed_on
      from public.client_doc_type r
      join public.client_group g on g.id = r.client_group_id and g.state = 'active'
      join public.client c on c.id = r.client_id and c.archived_at is null
      join public.doc_type t on t.id = r.doc_type_id and t.source = 'client' and t.status = 'approved'
      join public.period sp on sp.id = r.start_period_id
      join public.period p on p.office_id = r.office_id and p.kind = private.frequency_kind(r.frequency)
                          and p.start_date >= sp.start_date
      left join public.client_registration reg on t.registration_kind is not null and reg.client_id = r.client_id
                                              and reg.kind = t.registration_kind and reg.active
     where r.office_id = p_office and r.state = 'active' and r.frequency <> 'as_needed'
       and r.ask_after_months is not null
       and (p_clients is null or r.client_id = any (p_clients)) and (p_row is null or r.id = p_row)
       and (t.registration_kind is null or reg.id is not null)
  )
  insert into public.expected_doc (office_id, client_id, client_doc_type_id, doc_type_id, period_id, registration_id, ask_on, overdue_from)
  select office_id, client_id, row_id, doc_type_id, period_id, registration_id, ask_on, overdue_from
    from cand
   where ask_on <= p_today and (resumed_on is null or overdue_from > resumed_on)
  on conflict on constraint expected_doc_key do nothing;
  get diagnostics created = row_count;
  if p_clients is null then
    linked := private.link_unlinked_documents(p_office, null);
  else
    linked := 0;
    foreach c in array p_clients loop
      if exists (select 1 from public.document d
                  where d.client_id = c and d.expected_doc_id is null and d.archived_at is null) then
        v_n := private.link_unlinked_documents(p_office, c);
        linked := linked + v_n;
      end if;
    end loop;
  end if;
end $$;

-- Unchanged signature and behaviour (one client or the whole office): 04's triggers and the daily job call this.
create or replace function private.generate_expected(p_office uuid, p_client uuid, p_row uuid, p_today date,
  out created integer, out linked integer)
language plpgsql security definer set search_path = '' as $$
begin
  select g.created, g.linked into created, linked
    from private.generate_expected_for(p_office, case when p_client is null then null else array[p_client] end, p_row, p_today) g;
end $$;

-- The outermost call generates for the noted clients in one statement per office. Tenant first: a signed-in user's
-- call covers only their own office's clients (the service role / migrations: each client's own office).
create or replace function private.expected_defer_end(p_outer boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_list text; v_me uuid := private.current_office_id(); o record;
begin
  if p_outer then return; end if;
  v_list := coalesce(current_setting('app.expected_clients', true), '');
  perform set_config('app.expected_defer', 'off', true);
  perform set_config('app.expected_clients', '', true);
  if v_list = '' then return; end if;
  for o in
    select c.office_id, array_agg(c.id) as clients
      from public.client c
     where c.id = any (string_to_array(trim(trailing ',' from v_list), ',')::uuid[])
       and ((select auth.uid()) is null or c.office_id = v_me)
     group by c.office_id
  loop
    perform private.generate_expected_for(o.office_id, o.clients, null, private.office_today(o.office_id));
  end loop;
end $$;

-- ── Triggers: generate now, or note the client while deferred ─────────────────
-- Row (R1 version + defer).
create or replace function private.client_doc_type_after_expected()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  if (select auth.uid()) is not null and new.office_id is distinct from private.current_office_id() then return null; end if;
  if tg_op = 'UPDATE' then
    if new.state = 'removed' and old.state <> 'removed' then
      select array_agg(id) into v_ids from public.expected_doc where client_doc_type_id = new.id and status = 'pending';
      perform private.auto_waive(v_ids, 'removed_from_plan');
    elsif old.state = 'removed' and new.state <> 'removed'
          and exists (select 1 from public.client_group g where g.id = new.client_group_id and g.state <> 'removed') then
      select array_agg(id) into v_ids from public.expected_doc
       where client_doc_type_id = new.id and status = 'waived' and waived_code = 'removed_from_plan';
      perform private.restore_removed_items(v_ids, private.office_today(new.office_id));
    end if;
    if new.start_period_id is not null and new.start_period_id is distinct from old.start_period_id then
      select array_agg(e.id) into v_ids
        from public.expected_doc e join public.period p on p.id = e.period_id
       where e.client_doc_type_id = new.id and e.status = 'pending'
         and p.start_date < (select sp.start_date from public.period sp where sp.id = new.start_period_id);
      perform private.auto_waive(v_ids, 'before_start');
    end if;
    if new.ask_after_months is not null
       and (new.ask_after_months, new.ask_day, new.overdue_after_months, new.overdue_day)
           is distinct from (old.ask_after_months, old.ask_day, old.overdue_after_months, old.overdue_day) then
      update public.expected_doc e
         set ask_on = private.offset_date(p.end_date, new.ask_after_months, new.ask_day),
             overdue_from = private.offset_date(p.end_date, new.overdue_after_months, new.overdue_day)
        from public.period p
       where p.id = e.period_id and e.client_doc_type_id = new.id and e.status = 'pending';
    end if;
  end if;
  if new.state = 'active' then
    if private.expected_deferred() then
      perform private.expected_note_client(new.client_id);
    else
      perform private.generate_expected(new.office_id, new.client_id, new.id, private.office_today(new.office_id));
    end if;
  end if;
  return null;
end $$;

-- Group (R1 version + defer).
create or replace function private.client_group_after_expected()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  if (select auth.uid()) is not null and new.office_id is distinct from private.current_office_id() then return null; end if;
  if new.state = 'removed' and old.state <> 'removed' then
    select array_agg(e.id) into v_ids from public.expected_doc e join public.client_doc_type r on r.id = e.client_doc_type_id
     where r.client_group_id = new.id and e.status = 'pending';
    perform private.auto_waive(v_ids, 'removed_from_plan');
  else
    if old.state = 'removed' and new.state <> 'removed' then
      select array_agg(e.id) into v_ids from public.expected_doc e join public.client_doc_type r on r.id = e.client_doc_type_id
       where r.client_group_id = new.id and r.state <> 'removed' and e.status = 'waived' and e.waived_code = 'removed_from_plan';
      perform private.restore_removed_items(v_ids, private.office_today(new.office_id));
    end if;
    if new.state = 'active' and old.state <> 'active' then
      if private.expected_deferred() then
        perform private.expected_note_client(new.client_id);
      else
        perform private.generate_expected(new.office_id, new.client_id, null, private.office_today(new.office_id));
      end if;
    end if;
  end if;
  return null;
end $$;

create or replace function private.client_registration_after_expected()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  if (select auth.uid()) is not null and new.office_id is distinct from private.current_office_id() then return null; end if;
  if new.active and (tg_op = 'INSERT' or not old.active) then
    if private.expected_deferred() then
      perform private.expected_note_client(new.client_id);
    else
      perform private.generate_expected(new.office_id, new.client_id, null, private.office_today(new.office_id));
    end if;
  elsif tg_op = 'UPDATE' and old.active and not new.active then
    select array_agg(id) into v_ids from public.expected_doc where registration_id = new.id and status = 'pending';
    perform private.auto_waive(v_ids, 'registration_inactive');
  end if;
  return null;
end $$;

create or replace function private.client_after_expected()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and new.office_id is distinct from private.current_office_id() then return null; end if;
  if old.archived_at is not null and new.archived_at is null then
    if private.expected_deferred() then
      perform private.expected_note_client(new.id);
    else
      perform private.generate_expected(new.office_id, new.id, null, private.office_today(new.office_id));
    end if;
  end if;
  return null;
end $$;

-- ── Bulk functions: defer, then generate once per client ───────────────────────
-- 04's enable_group_core (AC-3 start period), unchanged except the defer wrapper.
create or replace function private.enable_group_core(p_client_id uuid, p_doc_group_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_office uuid := private.current_office_id(); v_incharge uuid; v_group uuid; v_today date; v_outer boolean;
begin
  select c.incharge_id into v_incharge from public.client c
    where c.id = p_client_id and c.office_id = v_office and c.archived_at is null;
  if not found then raise exception 'NOT_FOUND: client' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.doc_group g where g.id = p_doc_group_id and g.office_id = v_office and g.active) then
    raise exception 'NOT_FOUND: group' using errcode = 'P0002';
  end if;
  v_today := private.office_today(v_office);
  v_outer := private.expected_defer_begin();
  perform set_config('app.plan_bulk', 'on', true);
  insert into public.client_group (office_id, client_id, doc_group_id, assigned_staff_id, state)
    values (v_office, p_client_id, p_doc_group_id, v_incharge, 'active')
    on conflict (client_id, doc_group_id) do update
      set state = case when public.client_group.state = 'removed' then 'active'::public.plan_state else public.client_group.state end
    returning id into v_group;
  update public.client_doc_type
     set state = state_before_disable, state_before_disable = null
   where client_group_id = v_group and state_before_disable is not null;
  insert into public.client_doc_type (office_id, client_id, doc_type_id, client_group_id, frequency,
      ask_after_months, ask_day, overdue_after_months, overdue_day, reminders, start_period_id, state)
    select v_office, p_client_id, t.id, v_group, t.default_frequency,
           t.ask_after_months, t.ask_day, t.overdue_after_months, t.overdue_day, t.reminders,
           private.earliest_open_period(v_office, t.default_frequency, t.overdue_after_months, t.overdue_day, v_today), 'active'
      from public.doc_type t
     where t.doc_group_id = p_doc_group_id and t.office_id = v_office
       and t.source = 'client' and t.active and t.status = 'approved'
    on conflict (client_id, doc_type_id) do nothing;
  perform set_config('app.plan_bulk', 'off', true);
  perform private.expected_defer_end(v_outer);
  return v_group;
end $$;

-- 02's import_clients, unchanged except the defer wrapper around the row loop.
create or replace function public.import_clients(p_rows jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_office uuid := private.current_office_id();
  r jsonb; i bigint; reg jsonb; g text;
  v_id uuid; v_code text;
  v_out jsonb := '[]'::jsonb;
  v_ids jsonb := '[]'::jsonb;
  v_outer boolean;
begin
  if not private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: Limited users cannot import clients' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'IMPORT_FORMAT: rows must be an array' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 200 then
    raise exception 'IMPORT_TOO_MANY: at most 200 rows per call' using errcode = '22023';
  end if;
  v_outer := private.expected_defer_begin();
  for r, i in select e.value, e.ordinality from jsonb_array_elements(p_rows) with ordinality as e(value, ordinality) loop
    insert into public.client (office_id, name, client_type, pan, previous_reference, email, mobile, incharge_id)
      values (v_office, btrim(r->>'name'), (r->>'client_type')::public.client_type,
              nullif(btrim(r->>'pan'), ''), nullif(btrim(r->>'previous_reference'), ''),
              nullif(btrim(r->>'email'), ''), nullif(btrim(r->>'mobile'), ''), (r->>'incharge_id')::uuid)
      returning id, code into v_id, v_code;
    for reg in select * from jsonb_array_elements(coalesce(r->'registrations', '[]'::jsonb)) loop
      insert into public.client_registration (office_id, client_id, kind, number)
        values (v_office, v_id, (reg->>'kind')::public.registration_kind, btrim(reg->>'number'));
    end loop;
    for g in select * from jsonb_array_elements_text(coalesce(r->'group_ids', '[]'::jsonb)) loop
      perform private.enable_group_core(v_id, g::uuid);
    end loop;
    v_out := v_out || jsonb_build_array(jsonb_build_object('row', i, 'client_id', v_id, 'code', v_code));
    v_ids := v_ids || jsonb_build_array(v_id);
  end loop;
  perform private.expected_defer_end(v_outer);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, private.current_staff_id(), 'client.imported', 'client', null,
            jsonb_build_object('count', jsonb_array_length(v_ids), 'client_ids', v_ids));
  return v_out;
end $$;

-- 02's create_client, unchanged except the defer wrapper (registrations + groups → one generation).
create or replace function public.create_client(p jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_office uuid := private.current_office_id();
  v_id uuid; v_code text; reg jsonb; g text;
  v_groups jsonb := '[]'::jsonb; v_regs integer := 0; v_fields jsonb;
  v_outer boolean;
begin
  if not private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: Limited users cannot add clients' using errcode = '42501';
  end if;
  v_outer := private.expected_defer_begin();
  insert into public.client (office_id, name, client_type, pan, previous_reference, email, mobile, incharge_id)
    values (v_office, btrim(p->>'name'), (p->>'client_type')::public.client_type,
            nullif(btrim(p->>'pan'), ''), nullif(btrim(p->>'previous_reference'), ''),
            nullif(btrim(p->>'email'), ''), nullif(btrim(p->>'mobile'), ''), (p->>'incharge_id')::uuid)
    returning id, code into v_id, v_code;
  for reg in select * from jsonb_array_elements(coalesce(p->'registrations', '[]'::jsonb)) loop
    insert into public.client_registration (office_id, client_id, kind, number)
      values (v_office, v_id, (reg->>'kind')::public.registration_kind, btrim(reg->>'number'));
    v_regs := v_regs + 1;
  end loop;
  for g in select distinct * from jsonb_array_elements_text(coalesce(p->'group_ids', '[]'::jsonb)) loop
    perform private.enable_group_core(v_id, g::uuid);
    v_groups := v_groups || to_jsonb(g);
  end loop;
  perform private.expected_defer_end(v_outer);
  -- Field names only (AC-23): which optional fields were filled, never their values.
  select coalesce(jsonb_agg(k order by k), '[]'::jsonb) into v_fields
    from unnest(array['pan', 'previous_reference', 'email', 'mobile']) k where nullif(btrim(p->>k), '') is not null;
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, private.current_staff_id(), 'client.created', 'client', v_id::text,
            jsonb_build_object('fields', v_fields, 'registrations', v_regs, 'group_ids', v_groups));
  return jsonb_build_object('id', v_id, 'code', v_code);
end $$;

-- ── Grants ────────────────────────────────────────────────────────────────
revoke all on function private.expected_deferred(), private.expected_note_client(uuid),
  private.expected_defer_begin(), private.expected_defer_end(boolean),
  private.generate_expected_for(uuid, uuid[], uuid, date) from public, anon, authenticated;
-- The invoker bulk functions (enable_group_core, import_clients, create_client) run as the user.
grant execute on function private.expected_deferred(), private.expected_defer_begin(), private.expected_defer_end(boolean)
  to authenticated;
-- create or replace keeps the existing grants of the redefined functions.
