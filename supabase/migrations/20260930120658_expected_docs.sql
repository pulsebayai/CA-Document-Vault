-- Feature 04 — expected documents & schedule (spec: sdlc/features/04-expected-docs-schedule/spec.md, plan step 2).
-- Tests written first: tests/rls/expected-{docs,plan,metric,perf}.test.ts (contract: tests/support/expected.ts).
-- Additive. Holds the schema lock (roadmap). Replaces two 02 functions (start-period default, AC-3) and
-- reset_test_office (purges the new table). No change to 03's functions: linking is an AFTER trigger on document.
--
-- Sections
--   1. pg_cron · test clock (D1) · resume dates
--   2. expected_doc + document.expected_doc_id, RLS, grants
--   3. Date maths: offset_date / schedule_dates / earliest_open_period / office_today
--   4. Generation + linking (definer helpers; tenant = the row being changed or the cron loop)
--   5. Plan-change triggers (client_doc_type, client_group, client_registration, client) and the document trigger
--   6. Staff actions: waive / undo waive / reopen (invoker + app.expected_write flag, like 03's app.doc_write)
--   7. Metric 1 (collection_metric), the daily job, run_expected_generation (test clock), expected_job_info
--   8. 02 functions: start period = earliest still-open period (AC-3); reset_test_office
--   9. Grants on functions · cron schedule · back-fill

-- ── 1 ─────────────────────────────────────────────────────────────────────
create extension if not exists pg_cron;

-- D1: fixed-date runs in test offices. Honoured only where is_test (checked here and in office_today).
alter table public.office add column test_today date;
alter table public.office add constraint office_test_today_only_test check (test_today is null or is_test);

-- AC-12: "resume continues from the earliest still-open period". Set by trigger when a paused/removed row or
-- group becomes active again; generation skips periods whose overdue date had passed by then. Not granted to users.
alter table public.client_group    add column resumed_on date;
alter table public.client_doc_type add column resumed_on date;

-- ── 2 ─────────────────────────────────────────────────────────────────────
create type public.expected_status as enum ('pending', 'received', 'waived');

create table public.expected_doc (
  id                       uuid primary key default gen_random_uuid(),
  office_id                uuid not null references public.office (id),
  client_id                uuid not null references public.client (id),
  client_doc_type_id       uuid not null references public.client_doc_type (id),
  doc_type_id              uuid not null references public.doc_type (id),
  period_id                uuid not null references public.period (id),
  registration_id          uuid references public.client_registration (id),
  ask_on                   date not null,
  overdue_from             date not null,
  status                   public.expected_status not null default 'pending',
  received_on              date,
  completed_by_document_id uuid references public.document (id),
  waived_reason            text check (waived_reason is null or length(waived_reason) between 1 and 500),
  waived_code              text check (waived_code in ('manual', 'removed_from_plan', 'registration_inactive', 'before_start')),
  waived_by                uuid references public.staff_user (id),
  waived_at                timestamptz,
  reopened_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint expected_doc_key unique nulls not distinct (client_doc_type_id, period_id, registration_id),
  constraint expected_doc_waived check ((status = 'waived') = (waived_code is not null)),
  constraint expected_doc_received check ((status = 'received') = (received_on is not null)),
  constraint expected_doc_dates check (overdue_from >= ask_on)
);
create index expected_doc_office_status_idx on public.expected_doc (office_id, status, overdue_from);
create index expected_doc_client_status_idx on public.expected_doc (client_id, status);
create index expected_doc_match_idx on public.expected_doc (client_id, doc_type_id, period_id);
create index expected_doc_period_idx on public.expected_doc (period_id);
create index expected_doc_doc_type_idx on public.expected_doc (doc_type_id);
create index expected_doc_registration_idx on public.expected_doc (registration_id);
create index expected_doc_completed_by_idx on public.expected_doc (completed_by_document_id);
create index expected_doc_waived_by_idx on public.expected_doc (waived_by);

alter table public.document add column expected_doc_id uuid references public.expected_doc (id);
create index document_expected_doc_idx on public.document (expected_doc_id);

-- Only the vault's functions change expected documents (AC-17). App roles reach UPDATE only inside
-- waive/undo/reopen, which set app.expected_write; definer helpers run as the owner.
create or replace function private.expected_before_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') and coalesce(current_setting('app.expected_write', true), '') <> 'on' then
    raise exception 'permission denied: expected documents change only through the vault''s functions' using errcode = '42501';
  end if;
  if (new.id, new.office_id, new.client_id, new.client_doc_type_id, new.doc_type_id, new.period_id)
     is distinct from (old.id, old.office_id, old.client_id, old.client_doc_type_id, old.doc_type_id, old.period_id)
     or new.registration_id is distinct from old.registration_id or new.created_at <> old.created_at then
    raise exception 'IMMUTABLE: an expected document keeps its client, type, period and registration' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger expected_doc_before_update before update on public.expected_doc
  for each row execute function private.expected_before_update();
create trigger expected_doc_no_delete before delete on public.expected_doc
  for each row execute function private.forbid_delete_unless_purge();

alter table public.expected_doc enable row level security;
-- AC-17: visible iff the user can see its client.
create policy expected_doc_select on public.expected_doc for select to authenticated
  using (office_id = (select private.current_office_id()) and private.can_see_client(client_id));
create policy expected_doc_update on public.expected_doc for update to authenticated
  using (office_id = (select private.current_office_id()) and private.can_see_client(client_id))
  with check (office_id = (select private.current_office_id()));
-- No INSERT/DELETE policies: generation is a definer helper; delete is refused by trigger.
revoke all on public.expected_doc from anon, authenticated;
grant select on public.expected_doc to authenticated;
grant update (status, received_on, completed_by_document_id, waived_reason, waived_code, waived_by, waived_at, reopened_at)
  on public.expected_doc to authenticated;
-- document.expected_doc_id is maintained by trigger only: it is not added to 03's column grants.

-- ── 3 ─────────────────────────────────────────────────────────────────────
-- Period end + N months, on day D clamped to that month's last day (31 → 30/28/29).
create or replace function private.offset_date(p_end date, p_months integer, p_day integer)
returns date language sql immutable set search_path = '' as $$
  select x.m + (least(p_day, extract(day from (x.m + interval '1 month' - interval '1 day'))::integer) - 1)
    from (select (date_trunc('month', p_end) + make_interval(months => p_months))::date as m) x
$$;

-- Spec "Key definitions": ask date and overdue-from date of a period (mirrored by src/lib/expected/schedule.ts).
create or replace function private.schedule_dates(p_end date, p_ask_after integer, p_ask_day integer,
  p_overdue_after integer, p_overdue_day integer, out ask_on date, out overdue_from date)
language sql immutable set search_path = '' as $$
  select private.offset_date(p_end, p_ask_after, p_ask_day), private.offset_date(p_end, p_overdue_after, p_overdue_day)
$$;

create or replace function private.frequency_kind(p_frequency public.frequency)
returns public.period_kind language sql immutable set search_path = '' as $$
  select case p_frequency when 'monthly' then 'month'::public.period_kind when 'quarterly' then 'quarter'::public.period_kind
                          when 'yearly' then 'year'::public.period_kind end
$$;

-- "Today" for 04's rules: the test clock in an is_test office (D1), otherwise the date in India.
create or replace function private.office_today(p_office uuid)
returns date language sql stable security definer set search_path = '' as $$
  select coalesce((select o.test_today from public.office o where o.id = p_office and o.is_test),
                  (now() at time zone 'Asia/Kolkata')::date)
$$;

-- AC-3 / intent Q1: the earliest period of the frequency whose overdue-from date is after today, among the
-- office's periods; the current period if none is open (e.g. next FY not created yet); null for "as needed".
create or replace function private.earliest_open_period(p_office uuid, p_frequency public.frequency,
  p_overdue_after integer, p_overdue_day integer, p_today date)
returns uuid language sql stable security invoker set search_path = '' as $$
  select coalesce(
    (select p.id from public.period p
      where p.office_id = p_office and p.kind = private.frequency_kind(p_frequency)
        and private.offset_date(p.end_date, p_overdue_after, p_overdue_day) > p_today
      order by p.start_date limit 1),
    private.current_period_id(p_office, p_frequency))
$$;

-- ── 4 ─────────────────────────────────────────────────────────────────────
-- Linking rule (spec "Linked document", D4): same client + type + period; registration equal, or the document
-- has none and the client has exactly one active registration of the type's kind (Raja 2026-09-30, option b).
create or replace function private.match_expected(p_office uuid, p_client uuid, p_type uuid, p_period uuid, p_reg uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select e.id from public.expected_doc e
   where e.office_id = p_office and e.client_id = p_client and e.doc_type_id = p_type and e.period_id = p_period
     and (e.registration_id is not distinct from p_reg
          or (p_reg is null and e.registration_id is not null
              and exists (select 1 from public.client_registration r where r.id = e.registration_id and r.active)
              and (select count(*) from public.client_registration r
                     join public.doc_type t on t.id = p_type
                    where r.client_id = p_client and r.active and r.kind = t.registration_kind) = 1))
   order by (e.registration_id is not distinct from p_reg) desc
   limit 1
$$;

-- Status of one item from its linked documents (AC-6, AC-7, AC-10, AC-11). Waived items keep their status.
-- The completing document is the one newly linked while pending; otherwise the earliest remaining by received on.
-- After a reopen, only documents added since then (or the one just linked) can complete it again.
create or replace function private.recompute_expected(p_item uuid, p_new_doc uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare e public.expected_doc; v_doc uuid; v_on date;
begin
  select * into e from public.expected_doc where id = p_item for update;
  if not found or e.status = 'waived' then return; end if;
  if e.status = 'received' then
    select d.received_on into v_on from public.document d
     where d.id = e.completed_by_document_id and d.expected_doc_id = e.id and d.archived_at is null;
    if found then
      if v_on is distinct from e.received_on then
        update public.expected_doc set received_on = v_on where id = e.id;
      end if;
      return;
    end if;
  end if;
  select d.id, d.received_on into v_doc, v_on from public.document d
   where d.expected_doc_id = e.id and d.archived_at is null
     and (e.reopened_at is null or d.created_at > e.reopened_at or d.id = p_new_doc)
   order by (d.id is not distinct from p_new_doc) desc, d.received_on, d.created_at
   limit 1;
  if v_doc is null then
    if e.status = 'received' then
      update public.expected_doc set status = 'pending', received_on = null, completed_by_document_id = null where id = e.id;
    end if;
  else
    update public.expected_doc set status = 'received', received_on = v_on, completed_by_document_id = v_doc where id = e.id;
  end if;
end $$;

-- AC-4: link filed, unarchived, still-unlinked documents to items that now exist. Runs inside 03's write guard.
create or replace function private.link_unlinked_documents(p_office uuid, p_client uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_prev text := coalesce(current_setting('app.doc_write', true), ''); v_n integer; v_items uuid[]; i uuid;
begin
  perform set_config('app.doc_write', 'on', true);
  with m as (
    select d.id as doc_id, private.match_expected(d.office_id, d.client_id, d.doc_type_id, d.period_id, d.registration_id) as item
      from public.document d
     where d.office_id = p_office and (p_client is null or d.client_id = p_client)
       and d.expected_doc_id is null and d.archived_at is null
       and d.client_id is not null and d.doc_type_id is not null and d.period_id is not null
  ), u as (
    update public.document d set expected_doc_id = m.item from m
     where d.id = m.doc_id and m.item is not null
    returning m.item
  )
  select count(*), array_agg(distinct u.item) into v_n, v_items from u;
  perform set_config('app.doc_write', v_prev, true);
  foreach i in array coalesce(v_items, '{}') loop
    perform private.recompute_expected(i, null);
  end loop;
  return v_n;
end $$;

-- AC-1, AC-2, AC-5: create every missing item for active scheduled rows of active groups of unarchived clients,
-- for each period of the row's frequency from its start period whose ask date has arrived, × each active
-- registration when the type is collected per GSTIN/TAN. Set-based, idempotent (unique key). Periods whose
-- overdue date had passed when the row/group was resumed are skipped (AC-12).
create or replace function private.generate_expected(p_office uuid, p_client uuid, p_row uuid, p_today date,
  out created integer, out linked integer)
language plpgsql security definer set search_path = '' as $$
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
       and (p_client is null or r.client_id = p_client) and (p_row is null or r.id = p_row)
       and (t.registration_kind is null or reg.id is not null)
  )
  insert into public.expected_doc (office_id, client_id, client_doc_type_id, doc_type_id, period_id, registration_id, ask_on, overdue_from)
  select office_id, client_id, row_id, doc_type_id, period_id, registration_id, ask_on, overdue_from
    from cand
   where ask_on <= p_today and (resumed_on is null or overdue_from > resumed_on)
  on conflict on constraint expected_doc_key do nothing;
  get diagnostics created = row_count;
  linked := private.link_unlinked_documents(p_office, p_client);
end $$;

-- AC-12 system waivers: one activity row per item, code only (the reason text lives on the row), actor = system.
create or replace function private.auto_waive(p_ids uuid[], p_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_reason text := case p_code when 'removed_from_plan' then 'Removed from plan'
                                     when 'registration_inactive' then 'Registration inactive'
                                     when 'before_start' then 'Before start period' end;
begin
  if p_ids is null or cardinality(p_ids) = 0 then return; end if;
  with w as (
    update public.expected_doc e
       set status = 'waived', waived_code = p_code, waived_reason = v_reason, waived_by = null, waived_at = now()
     where e.id = any (p_ids) and e.status = 'pending'
    returning e.id, e.office_id, e.client_id
  )
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
  select w.office_id, null, 'expected.auto_waived', 'expected_doc', w.id::text, jsonb_build_object('code', p_code, 'client_id', w.client_id)
    from w;
end $$;

-- ── 5 ─────────────────────────────────────────────────────────────────────
-- Resume date on plan rows and groups (BEFORE; also keeps users from setting it).
create or replace function private.plan_resumed_on()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.resumed_on := null;
  elsif old.state <> 'active' and new.state = 'active' then
    new.resumed_on := private.office_today(new.office_id);
  else
    new.resumed_on := old.resumed_on;
  end if;
  return new;
end $$;
create trigger client_doc_type_resumed_on before insert or update on public.client_doc_type
  for each row execute function private.plan_resumed_on();
create trigger client_group_resumed_on before insert or update on public.client_group
  for each row execute function private.plan_resumed_on();

-- Plan row changes (AC-2, AC-12). Every path — 02's server actions, enable/disable, direct API — ends here.
create or replace function private.client_doc_type_after_expected()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  if (select auth.uid()) is not null and new.office_id is distinct from private.current_office_id() then return null; end if;
  if tg_op = 'UPDATE' then
    if new.state = 'removed' and old.state <> 'removed' then
      select array_agg(id) into v_ids from public.expected_doc where client_doc_type_id = new.id and status = 'pending';
      perform private.auto_waive(v_ids, 'removed_from_plan');
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
    perform private.generate_expected(new.office_id, new.client_id, new.id, private.office_today(new.office_id));
  end if;
  return null;
end $$;
create trigger client_doc_type_after_expected after insert or update on public.client_doc_type
  for each row execute function private.client_doc_type_after_expected();

create or replace function private.client_group_after_expected()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  if (select auth.uid()) is not null and new.office_id is distinct from private.current_office_id() then return null; end if;
  if new.state = 'removed' and old.state <> 'removed' then
    select array_agg(e.id) into v_ids from public.expected_doc e join public.client_doc_type r on r.id = e.client_doc_type_id
     where r.client_group_id = new.id and e.status = 'pending';
    perform private.auto_waive(v_ids, 'removed_from_plan');
  elsif new.state = 'active' and old.state <> 'active' then
    perform private.generate_expected(new.office_id, new.client_id, null, private.office_today(new.office_id));
  end if;
  return null;
end $$;
create trigger client_group_after_expected after update of state on public.client_group
  for each row execute function private.client_group_after_expected();

create or replace function private.client_registration_after_expected()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  if (select auth.uid()) is not null and new.office_id is distinct from private.current_office_id() then return null; end if;
  if new.active and (tg_op = 'INSERT' or not old.active) then
    perform private.generate_expected(new.office_id, new.client_id, null, private.office_today(new.office_id));
  elsif tg_op = 'UPDATE' and old.active and not new.active then
    select array_agg(id) into v_ids from public.expected_doc where registration_id = new.id and status = 'pending';
    perform private.auto_waive(v_ids, 'registration_inactive');
  end if;
  return null;
end $$;
create trigger client_registration_after_expected after insert or update of active on public.client_registration
  for each row execute function private.client_registration_after_expected();

-- An unarchived client catches up at once (archived clients get nothing and are excluded from metric 1).
create or replace function private.client_after_expected()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and new.office_id is distinct from private.current_office_id() then return null; end if;
  if old.archived_at is not null and new.archived_at is null then
    perform private.generate_expected(new.office_id, new.id, null, private.office_today(new.office_id));
  end if;
  return null;
end $$;
create trigger client_after_expected after update of archived_at on public.client
  for each row execute function private.client_after_expected();

-- AC-6, AC-7: link/unlink on save, classify, edit, archive, unarchive (and received-on edits).
-- 03's functions are unchanged; this runs inside their transaction (app.doc_write already on for users).
create or replace function private.document_after_link()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_item uuid; v_prev text := coalesce(current_setting('app.doc_write', true), '');
begin
  if coalesce(current_setting('app.purge_office', true), '') = new.office_id::text then return null; end if;
  if (select auth.uid()) is not null and new.office_id is distinct from private.current_office_id() then return null; end if;
  if new.archived_at is null and new.client_id is not null and new.doc_type_id is not null and new.period_id is not null then
    v_item := private.match_expected(new.office_id, new.client_id, new.doc_type_id, new.period_id, new.registration_id);
  end if;
  if v_item is distinct from new.expected_doc_id then
    perform set_config('app.doc_write', 'on', true);
    update public.document set expected_doc_id = v_item where id = new.id;
    perform set_config('app.doc_write', v_prev, true);
    if new.expected_doc_id is not null then perform private.recompute_expected(new.expected_doc_id, null); end if;
    if v_item is not null then perform private.recompute_expected(v_item, new.id); end if;
  elsif v_item is not null then
    perform private.recompute_expected(v_item, null);
  end if;
  return null;
end $$;
create trigger document_after_link
  after insert or update of client_id, doc_type_id, period_id, registration_id, archived_at, received_on on public.document
  for each row execute function private.document_after_link();

-- ── 6 ─────────────────────────────────────────────────────────────────────
create or replace function private.begin_expected_write()
returns void language plpgsql volatile set search_path = '' as $$
begin
  perform set_config('app.expected_write', 'on', true);
end $$;

-- AC-9: Admin/Manager/Staff, pending items only, reason 1–500 characters (kept on the row, never in activity).
create or replace function public.waive_expected(p_id uuid, p_reason text)
returns void language plpgsql security invoker set search_path = '' as $$
declare e public.expected_doc; v_reason text := btrim(coalesce(p_reason, ''));
begin
  if not private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: Limited users cannot waive expected documents' using errcode = '42501';
  end if;
  if length(v_reason) not between 1 and 500 then
    raise exception 'REASON_REQUIRED: give a reason of 1–500 characters' using errcode = '23514';
  end if;
  select * into e from public.expected_doc where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: expected document' using errcode = 'P0002'; end if;
  if e.status <> 'pending' then raise exception 'NOT_PENDING: only an open item can be marked not needed' using errcode = 'P0001'; end if;
  perform private.begin_expected_write();
  update public.expected_doc
     set status = 'waived', waived_code = 'manual', waived_reason = v_reason,
         waived_by = private.current_staff_id(), waived_at = now()
   where id = p_id;
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (e.office_id, private.current_staff_id(), 'expected.waived', 'expected_doc', p_id::text,
            jsonb_build_object('code', 'manual', 'client_id', e.client_id));
end $$;

-- AC-10: Admin/Manager → pending, or received if a linked document exists.
create or replace function public.undo_waive_expected(p_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare e public.expected_doc;
begin
  if not private.has_role(array['admin', 'manager']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: only Admin or Manager can undo a waiver' using errcode = '42501';
  end if;
  select * into e from public.expected_doc where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: expected document' using errcode = 'P0002'; end if;
  if e.status <> 'waived' then raise exception 'NOT_WAIVED: this item is not marked not needed' using errcode = 'P0001'; end if;
  perform private.begin_expected_write();
  update public.expected_doc
     set status = 'pending', waived_code = null, waived_reason = null, waived_by = null, waived_at = null
   where id = p_id;
  perform private.recompute_expected(p_id, null);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (e.office_id, private.current_staff_id(), 'expected.waive_undone', 'expected_doc', p_id::text,
            jsonb_build_object('code', e.waived_code, 'client_id', e.client_id));
end $$;

-- AC-11: anyone who can see the client (RLS), received items only; linked documents stay linked.
create or replace function public.reopen_expected(p_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare e public.expected_doc;
begin
  if private.current_staff_id() is null then raise exception 'ROLE_REQUIRED: sign in' using errcode = '42501'; end if;
  select * into e from public.expected_doc where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: expected document' using errcode = 'P0002'; end if;
  if e.status <> 'received' then raise exception 'NOT_RECEIVED: only a received item can be reopened' using errcode = 'P0001'; end if;
  perform private.begin_expected_write();
  update public.expected_doc
     set status = 'pending', received_on = null, completed_by_document_id = null, reopened_at = now()
   where id = p_id;
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (e.office_id, private.current_staff_id(), 'expected.reopened', 'expected_doc', p_id::text,
            jsonb_build_object('client_id', e.client_id));
end $$;

-- ── 7 ─────────────────────────────────────────────────────────────────────
-- AC-16 / metric 1. Due = overdue-from date in [p_from, p_to] and already passed; excludes waived, on-hold
-- (pending on a paused row or group) and archived-client items. On time = received on < overdue from.
create or replace function public.collection_metric(p_from date, p_to date)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_office uuid := private.current_office_id(); v_today date; v jsonb;
begin
  if not private.has_role(array['admin', 'manager']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: only Admin or Manager can see the collection metric' using errcode = '42501';
  end if;
  v_today := private.office_today(v_office);
  with base as (
    select e.status, e.received_on, e.overdue_from, t.doc_group_id,
           (e.status = 'pending' and (r.state = 'paused' or g.state = 'paused')) as on_hold
      from public.expected_doc e
      join public.client c on c.id = e.client_id and c.archived_at is null
      join public.client_doc_type r on r.id = e.client_doc_type_id
      join public.client_group g on g.id = r.client_group_id
      join public.doc_type t on t.id = e.doc_type_id
     where e.office_id = v_office and e.status <> 'waived'
  ), due as (
    select * from base where not on_hold and overdue_from between p_from and p_to and overdue_from <= v_today
  ), grp as (
    select dg.id, dg.name, dg.sort, count(*) as due,
           count(*) filter (where d.status = 'received' and d.received_on < d.overdue_from) as on_time,
           count(*) filter (where d.status = 'received' and d.received_on >= d.overdue_from) as late,
           count(*) filter (where d.status = 'pending') as missing
      from due d join public.doc_group dg on dg.id = d.doc_group_id
     group by dg.id, dg.name, dg.sort
  )
  select jsonb_build_object(
    'due', (select count(*) from due),
    'on_time', (select count(*) from due where status = 'received' and received_on < overdue_from),
    'late', (select count(*) from due where status = 'received' and received_on >= overdue_from),
    'missing', (select count(*) from due where status = 'pending'),
    'on_time_pct', (select case when count(*) = 0 then null
                    else round(100.0 * count(*) filter (where status = 'received' and received_on < overdue_from) / count(*), 1) end
                      from due),
    'overdue_now', (select count(*) from base where status = 'pending' and not on_hold and overdue_from <= v_today),
    'last_generated_at', (select max(a.created_at) from public.activity a
                           where a.office_id = v_office and a.action = 'expected.generated'),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('doc_group_id', id, 'name', name, 'due', due,
                                 'on_time', on_time, 'late', late, 'missing', missing) order by sort) from grp), '[]'::jsonb))
    into v;
  return v;
end $$;

-- One office's daily run: next FY from 1 February (architecture change 2), generation, back-link, one activity row.
create or replace function private.run_office_expected(p_office uuid, p_today date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_target integer; v_max integer; v_fy uuid; g record;
begin
  v_target := extract(year from p_today)::integer - case when extract(month from p_today) < 4 then 1 else 0 end;
  if extract(month from p_today) in (2, 3) then v_target := v_target + 1; end if;
  select max(extract(year from start_date))::integer into v_max from public.financial_year where office_id = p_office;
  while v_max is not null and v_max < v_target loop
    v_max := v_max + 1;
    v_fy := private.create_financial_year(p_office, v_max);
    insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
      values (p_office, null, 'financial_year.added', 'financial_year', v_fy::text, jsonb_build_object('source', 'system'));
  end loop;
  select * into g from private.generate_expected(p_office, null, null, p_today);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (p_office, null, 'expected.generated', 'office', p_office::text,
            jsonb_build_object('created', g.created, 'linked', g.linked));
  return jsonb_build_object('created', g.created, 'linked', g.linked);
end $$;

-- The pg_cron job (architecture change 1): every real office, as of today in India. One office failing
-- doesn't stop the others; failures show in cron.job_run_details and the nightly job-ran check.
create or replace function private.run_daily_expected()
returns void language plpgsql security definer set search_path = '' as $$
declare o record; v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  for o in select id from public.office where not is_test order by id loop
    begin
      perform private.run_office_expected(o.id, v_today);
    exception when others then
      raise warning 'expected-docs-daily: office % failed: %', o.id, sqlerrm;
    end;
  end loop;
end $$;

-- Test clock (D1): Admin of an is_test office runs the job for their office as of a fixed date.
create or replace function public.run_expected_generation(p_as_of date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office uuid := private.current_office_id();
begin
  if not private.has_role(array['admin']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: only Admin can run generation' using errcode = '42501';
  end if;
  if not exists (select 1 from public.office where id = v_office and is_test) then
    raise exception 'NOT_TEST_OFFICE: fixed-date generation is for test offices only' using errcode = '42501';
  end if;
  update public.office set test_today = p_as_of where id = v_office;
  return private.run_office_expected(v_office, p_as_of);
end $$;

-- Service role only: lets the nightly tests check the job is registered.
create or replace function public.expected_job_info()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('jobname', j.jobname, 'schedule', j.schedule, 'active', j.active)
    from cron.job j where j.jobname = 'expected-docs-daily'
$$;

-- ── 8 ─────────────────────────────────────────────────────────────────────
-- AC-3: 02's functions, unchanged except the start period (was private.current_period_id).
create or replace function private.enable_group_core(p_client_id uuid, p_doc_group_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_office uuid := private.current_office_id(); v_incharge uuid; v_group uuid; v_today date;
begin
  select c.incharge_id into v_incharge from public.client c
    where c.id = p_client_id and c.office_id = v_office and c.archived_at is null;
  if not found then raise exception 'NOT_FOUND: client' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.doc_group g where g.id = p_doc_group_id and g.office_id = v_office and g.active) then
    raise exception 'NOT_FOUND: group' using errcode = 'P0002';
  end if;
  v_today := private.office_today(v_office);
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
  return v_group;
end $$;

create or replace function public.add_client_doc_type(p_client_id uuid, p_doc_type_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_office uuid := private.current_office_id(); t public.doc_type; v_group uuid; v_id uuid;
begin
  if not private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: Limited users cannot change collection plans' using errcode = '42501';
  end if;
  select * into t from public.doc_type where id = p_doc_type_id and office_id = v_office;
  if not found then raise exception 'NOT_FOUND: document type' using errcode = 'P0002'; end if;
  if t.source = 'firm' then raise exception 'FIRM_RECORD: firm records are never part of a collection plan' using errcode = '23514'; end if;
  if not t.active or t.status <> 'approved' then raise exception 'INACTIVE_TYPE: this type is not offered' using errcode = '23514'; end if;
  select g.id into v_group from public.client_group g
    where g.client_id = p_client_id and g.doc_group_id = t.doc_group_id and g.state <> 'removed';
  if not found then raise exception 'GROUP_NOT_ENABLED: enable the group first' using errcode = '23514'; end if;
  insert into public.client_doc_type (office_id, client_id, doc_type_id, client_group_id, frequency,
      ask_after_months, ask_day, overdue_after_months, overdue_day, reminders, start_period_id, state)
    values (v_office, p_client_id, t.id, v_group, t.default_frequency, t.ask_after_months, t.ask_day,
            t.overdue_after_months, t.overdue_day, t.reminders,
            private.earliest_open_period(v_office, t.default_frequency, t.overdue_after_months, t.overdue_day,
                                         private.office_today(v_office)), 'active')
    on conflict (client_id, doc_type_id) do nothing
    returning id into v_id;
  if v_id is null then
    select id into v_id from public.client_doc_type where client_id = p_client_id and doc_type_id = p_doc_type_id;
  else
    insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
      values (v_office, private.current_staff_id(), 'client_doc_type.added', 'client_doc_type', v_id::text,
              jsonb_build_object('client_id', p_client_id, 'doc_type_id', p_doc_type_id));
  end if;
  return v_id;
end $$;

-- 03's reset, plus expected documents (circular references cleared first) and the test clock.
create or replace function public.reset_test_office(p_office_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.office where id = p_office_id and is_test) then
    raise exception 'NOT_TEST_OFFICE: only offices flagged is_test can be reset' using errcode = '42501';
  end if;
  perform set_config('app.purge_office', p_office_id::text, true);
  update public.expected_doc set completed_by_document_id = null where office_id = p_office_id and completed_by_document_id is not null;
  update public.document set current_version_id = null, expected_doc_id = null
   where office_id = p_office_id and (current_version_id is not null or expected_doc_id is not null);
  delete from public.expected_doc        where office_id = p_office_id;
  delete from public.document_version    where office_id = p_office_id;
  delete from public.document            where office_id = p_office_id;
  delete from public.doc_counter         where office_id = p_office_id;
  delete from public.client_doc_type     where office_id = p_office_id;
  delete from public.client_group        where office_id = p_office_id;
  delete from public.doc_type            where office_id = p_office_id and status = 'proposed';
  delete from public.client_registration where office_id = p_office_id;
  delete from public.client_contact      where office_id = p_office_id;
  delete from public.client              where office_id = p_office_id;
  delete from public.period              where office_id = p_office_id;
  delete from public.financial_year      where office_id = p_office_id;
  delete from public.doc_type            where office_id = p_office_id;
  delete from public.doc_group           where office_id = p_office_id;
  perform set_config('app.purge_office', '', true);
  update public.office set client_code_counter = 0, test_today = null where id = p_office_id;
  perform private.seed_catalogue(p_office_id);
end $$;

-- ── 9 ─────────────────────────────────────────────────────────────────────
revoke all on function
  private.expected_before_update(), private.offset_date(date, integer, integer),
  private.schedule_dates(date, integer, integer, integer, integer), private.frequency_kind(public.frequency),
  private.office_today(uuid), private.earliest_open_period(uuid, public.frequency, integer, integer, date),
  private.match_expected(uuid, uuid, uuid, uuid, uuid), private.recompute_expected(uuid, uuid),
  private.link_unlinked_documents(uuid, uuid), private.generate_expected(uuid, uuid, uuid, date),
  private.auto_waive(uuid[], text), private.plan_resumed_on(), private.client_doc_type_after_expected(),
  private.client_group_after_expected(), private.client_registration_after_expected(), private.client_after_expected(),
  private.document_after_link(), private.begin_expected_write(), private.run_office_expected(uuid, date),
  private.run_daily_expected()
  from public, anon, authenticated;
-- Needed by invoker paths (enable/add type, waive/undo/reopen, metric) and the BEFORE trigger run as the user.
grant execute on function
  private.offset_date(date, integer, integer), private.frequency_kind(public.frequency), private.office_today(uuid),
  private.earliest_open_period(uuid, public.frequency, integer, integer, date), private.recompute_expected(uuid, uuid),
  private.begin_expected_write()
  to authenticated;

revoke all on function public.waive_expected(uuid, text), public.undo_waive_expected(uuid), public.reopen_expected(uuid),
  public.collection_metric(date, date), public.run_expected_generation(date) from public, anon;
grant execute on function public.waive_expected(uuid, text), public.undo_waive_expected(uuid), public.reopen_expected(uuid),
  public.collection_metric(date, date), public.run_expected_generation(date) to authenticated;
revoke all on function public.expected_job_info() from public, anon, authenticated;
grant execute on function public.expected_job_info() to service_role;
-- reset_test_office keeps 03's grants (service role only): create or replace preserves them.

-- The daily job at 00:15 IST (18:45 UTC). Re-running the migration replaces it.
select cron.unschedule(j.jobid) from cron.job j where j.jobname = 'expected-docs-daily';
select cron.schedule('expected-docs-daily', '45 18 * * *', 'select private.run_daily_expected()');

-- Back-fill (spec "Backward compatibility"): real offices as of today; links 03's documents.
select private.run_daily_expected();
