-- 02-clients-and-catalogue · migration 1: catalogue, financial years, clients, collection plans.
-- Rules (architecture.md + spec): RLS default-deny; office_id on every table; no hard delete;
-- column grants for sensitive columns; SQL functions are SECURITY INVOKER (RLS applies) except
-- trigger helpers that must read/lock base tables. Error prefixes (ROLE_REQUIRED, GSTIN_PAN, …)
-- are mapped to plain messages by the app; messages never contain identifier values.

create extension if not exists pg_trgm with schema extensions;

-- ── Types ────────────────────────────────────────────────────────────────
create type public.client_type as enum ('individual', 'huf', 'proprietorship', 'partnership', 'llp',
  'private_ltd', 'public_ltd', 'trust', 'society', 'aop_boi', 'cooperative');
create type public.frequency as enum ('monthly', 'quarterly', 'yearly', 'as_needed');
create type public.period_kind as enum ('month', 'quarter', 'year', 'none');
create type public.plan_state as enum ('active', 'paused', 'removed');
create type public.registration_kind as enum ('gstin', 'tan');
create type public.doc_source as enum ('client', 'firm');
create type public.doc_type_status as enum ('approved', 'proposed');

-- ── Office additions ─────────────────────────────────────────────────────
alter table public.office
  add column client_code_counter integer not null default 0 check (client_code_counter >= 0),
  add column is_test boolean not null default false;
-- Plan D2: fixture offices are the only ones reset_test_office may purge.
update public.office set is_test = true where name like 'e2e office %';

-- ── Pure helpers (immutable; used in CHECK constraints) ──────────────────
create or replace function private.pan_fits_type(p_pan text, p_type public.client_type)
returns boolean language sql immutable set search_path = '' as $$
  -- Mirrors src/lib/validation/identifiers.ts panMatchesType: only hard errors fail here.
  select p_pan is null
      or substr(p_pan, 4, 1) in ('G', 'L', 'J')
      or p_type in ('society', 'cooperative')
      or position(substr(p_pan, 4, 1) in case p_type
           when 'individual' then 'P' when 'proprietorship' then 'P' when 'huf' then 'H'
           when 'partnership' then 'F' when 'llp' then 'F' when 'private_ltd' then 'C'
           when 'public_ltd' then 'C' when 'trust' then 'T' when 'aop_boi' then 'AB' else '' end) > 0
$$;

create or replace function private.gst_state_ok(p_code text)
returns boolean language sql immutable set search_path = '' as $$
  -- Mirrors src/lib/validation/gst-states.ts (01–38 + 97).
  select p_code ~ '^[0-9]{2}$' and (p_code::int between 1 and 38 or p_code = '97')
$$;

-- ── Masters: catalogue + financial years ─────────────────────────────────
create table public.doc_group (
  id                      uuid primary key default gen_random_uuid(),
  office_id               uuid not null references public.office (id),
  code                    text not null check (code ~ '^[a-z0-9_]{1,40}$'),
  name                    text not null check (length(btrim(name)) between 1 and 80),
  sort                    integer not null default 0,
  active                  boolean not null default true,
  enabled_for_new_clients boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (office_id, code)
);
create unique index doc_group_name_key on public.doc_group (office_id, lower(name));

create table public.doc_type (
  id                   uuid primary key default gen_random_uuid(),
  office_id            uuid not null references public.office (id),
  doc_group_id         uuid not null references public.doc_group (id),
  code                 text not null check (code ~ '^[a-z0-9_]{1,60}$'),
  name                 text not null check (length(btrim(name)) between 1 and 120),
  aliases              text[] not null default '{}',
  period_kind          public.period_kind not null,
  default_frequency    public.frequency not null,
  source               public.doc_source not null default 'client',
  used_for             text check (used_for is null or length(used_for) <= 200),
  ask_after_months     smallint check (ask_after_months between 0 and 12),
  ask_day              smallint check (ask_day between 1 and 31),
  overdue_after_months smallint check (overdue_after_months between 0 and 12),
  overdue_day          smallint check (overdue_day between 1 and 31),
  registration_kind    public.registration_kind,
  reminders            boolean not null default false,
  status               public.doc_type_status not null default 'approved',
  proposed_by          uuid references public.staff_user (id),
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (office_id, code),
  -- Offsets are all set or all null, and set exactly when the type is scheduled.
  constraint doc_type_offsets_complete check (num_nonnulls(ask_after_months, ask_day, overdue_after_months, overdue_day) in (0, 4)),
  constraint doc_type_offsets_iff_scheduled check ((default_frequency = 'as_needed') = (ask_after_months is null)),
  constraint doc_type_overdue_after_ask check ((overdue_after_months, overdue_day) >= (ask_after_months, ask_day)),
  constraint doc_type_scheduled_has_period check (default_frequency = 'as_needed' or period_kind <> 'none'),
  -- Firm records: never scheduled, never reminded (spec rev 2).
  constraint doc_type_firm_no_schedule check (source = 'client' or (default_frequency = 'as_needed' and reminders = false))
);
create unique index doc_type_name_key on public.doc_type (doc_group_id, lower(name));
create index doc_type_proposed_by_idx on public.doc_type (proposed_by);

create table public.financial_year (
  id         uuid primary key default gen_random_uuid(),
  office_id  uuid not null references public.office (id),
  code       text not null check (code ~ '^[0-9]{4}-[0-9]{2}$'),
  start_date date not null,
  end_date   date not null check (end_date > start_date),
  created_at timestamptz not null default now(),
  unique (office_id, code)
);

create table public.period (
  id                uuid primary key default gen_random_uuid(),
  office_id         uuid not null references public.office (id),
  financial_year_id uuid not null references public.financial_year (id),
  kind              public.period_kind not null check (kind <> 'none'),
  code              text not null,
  label             text not null,
  start_date        date not null,
  end_date          date not null check (end_date >= start_date),
  unique (office_id, kind, code)
);
create index period_fy_idx on public.period (financial_year_id);
create index period_lookup_idx on public.period (office_id, kind, start_date, end_date);

-- ── Clients ──────────────────────────────────────────────────────────────
create table public.client (
  id                 uuid primary key default gen_random_uuid(),
  office_id          uuid not null references public.office (id),
  code               text not null,
  name               text not null check (length(btrim(name)) between 1 and 200),
  client_type        public.client_type not null,
  pan                text check (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  previous_reference text check (previous_reference is null or length(btrim(previous_reference)) between 1 and 60),
  email              text check (email is null or (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  mobile             text check (mobile is null or mobile ~ '^[6-9][0-9]{9}$'),
  incharge_id        uuid not null references public.staff_user (id),
  archived_at        timestamptz,
  archived_by        uuid references public.staff_user (id),
  created_by         uuid references public.staff_user (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (office_id, code),
  constraint client_pan_fits_type check (private.pan_fits_type(pan, client_type))
);
create unique index client_pan_active_key on public.client (office_id, pan) where archived_at is null and pan is not null;
create index client_incharge_idx on public.client (incharge_id);
create index client_archived_by_idx on public.client (archived_by);
create index client_created_by_idx on public.client (created_by);
create index client_name_trgm on public.client using gin (name extensions.gin_trgm_ops);
create index client_prev_ref_trgm on public.client using gin (previous_reference extensions.gin_trgm_ops);

create table public.client_registration (
  id         uuid primary key default gen_random_uuid(),
  office_id  uuid not null references public.office (id),
  client_id  uuid not null references public.client (id),
  kind       public.registration_kind not null,
  number     text not null,
  state_code text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (office_id, number),
  constraint client_registration_format check (
    (kind = 'gstin' and number ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][0-9A-Z][0-9A-Z]$' and private.gst_state_ok(substr(number, 1, 2)))
    or (kind = 'tan' and number ~ '^[A-Z]{4}[0-9]{5}[A-Z]$'))
);
create index client_registration_client_idx on public.client_registration (client_id);

create table public.client_contact (
  id         uuid primary key default gen_random_uuid(),
  office_id  uuid not null references public.office (id),
  client_id  uuid not null references public.client (id),
  name       text not null check (length(btrim(name)) between 1 and 120),
  role       text check (role is null or length(role) <= 60),
  email      text check (email is null or (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  mobile     text check (mobile is null or mobile ~ '^[6-9][0-9]{9}$'),
  created_at timestamptz not null default now()
);
create index client_contact_client_idx on public.client_contact (client_id);
create index client_contact_office_idx on public.client_contact (office_id);

-- ── Collection plans ─────────────────────────────────────────────────────
create table public.client_group (
  id                uuid primary key default gen_random_uuid(),
  office_id         uuid not null references public.office (id),
  client_id         uuid not null references public.client (id),
  doc_group_id      uuid not null references public.doc_group (id),
  assigned_staff_id uuid references public.staff_user (id),
  state             public.plan_state not null default 'active',
  remark            text check (remark is null or length(remark) <= 500),
  paused_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (client_id, doc_group_id)
);
create index client_group_office_idx on public.client_group (office_id);
create index client_group_doc_group_idx on public.client_group (doc_group_id);
create index client_group_assigned_idx on public.client_group (assigned_staff_id, client_id) where state = 'active';

create table public.client_doc_type (
  id                   uuid primary key default gen_random_uuid(),
  office_id            uuid not null references public.office (id),
  client_id            uuid not null references public.client (id),
  doc_type_id          uuid not null references public.doc_type (id),
  client_group_id      uuid not null references public.client_group (id),
  frequency            public.frequency not null,
  ask_after_months     smallint check (ask_after_months between 0 and 12),
  ask_day              smallint check (ask_day between 1 and 31),
  overdue_after_months smallint check (overdue_after_months between 0 and 12),
  overdue_day          smallint check (overdue_day between 1 and 31),
  reminders            boolean not null default false,
  assigned_staff_id    uuid references public.staff_user (id),
  start_period_id      uuid references public.period (id),
  state                public.plan_state not null default 'active',
  state_before_disable public.plan_state,  -- S3: restored when the group is re-enabled
  remark               text check (remark is null or length(remark) <= 500),
  paused_at            timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (client_id, doc_type_id),
  constraint client_doc_type_offsets_complete check (num_nonnulls(ask_after_months, ask_day, overdue_after_months, overdue_day) in (0, 4)),
  constraint client_doc_type_offsets_iff_scheduled check ((frequency = 'as_needed') = (ask_after_months is null)),
  constraint client_doc_type_overdue_after_ask check ((overdue_after_months, overdue_day) >= (ask_after_months, ask_day))
);
create index client_doc_type_office_idx on public.client_doc_type (office_id);
create index client_doc_type_doc_type_idx on public.client_doc_type (doc_type_id);
create index client_doc_type_group_idx on public.client_doc_type (client_group_id);
create index client_doc_type_period_idx on public.client_doc_type (start_period_id);
create index client_doc_type_assigned_idx on public.client_doc_type (assigned_staff_id, client_id) where state = 'active';

-- ── Access helpers ───────────────────────────────────────────────────────
-- Limited users see a client only if incharge or assigned on an active group/type (AC-12).
-- SECURITY DEFINER so it reads base tables without recursing through their RLS.
create or replace function private.can_see_client(p_client_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.client c
    join public.staff_user s on s.id = (select auth.uid()) and s.status = 'active' and s.office_id = c.office_id
    where c.id = p_client_id
      and (s.role <> 'limited'
        or c.incharge_id = s.id
        or exists (select 1 from public.client_group g where g.client_id = c.id and g.state = 'active' and g.assigned_staff_id = s.id)
        or exists (select 1 from public.client_doc_type t where t.client_id = c.id and t.state = 'active' and t.assigned_staff_id = s.id))
  )
$$;

-- True for the service role / migrations (no JWT) and for active Admin/Manager.
create or replace function private.is_privileged()
returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is null or private.has_role(array['admin', 'manager']::public.staff_role[])
$$;

-- ── Triggers ─────────────────────────────────────────────────────────────
create or replace function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

-- No hard delete, except reset_test_office on an is_test office (plan D2), which sets app.purge_office.
create or replace function private.forbid_delete_unless_purge()
returns trigger language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('app.purge_office', true), '') = old.office_id::text then return old; end if;
  raise exception 'NO_DELETE: % rows are never deleted', tg_table_name using errcode = 'P0001';
end $$;

-- Client: vault-assigned code (AC-8), incharge/archive role rule (AC-10/11), incharge validity.
-- SECURITY DEFINER: locks and increments office.client_code_counter, which users cannot update.
create or replace function private.client_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  if tg_op = 'INSERT' then
    -- Row lock on the office serialises inserts; a failed insert rolls the counter back (no gaps).
    update public.office set client_code_counter = client_code_counter + 1
      where id = new.office_id returning client_code_counter into v_n;
    if v_n is null then raise exception 'NOT_FOUND: office' using errcode = 'P0002'; end if;
    new.code := 'C' || lpad(v_n::text, 4, '0');
    new.created_by := coalesce(new.created_by, private.current_staff_id());
    new.created_at := now();
    new.updated_at := now();
  else
    if new.code is distinct from old.code or new.office_id is distinct from old.office_id
       or new.created_by is distinct from old.created_by then
      raise exception 'IMMUTABLE: client code, office and creator cannot change' using errcode = 'P0001';
    end if;
    if (new.incharge_id is distinct from old.incharge_id
        or new.archived_at is distinct from old.archived_at
        or new.archived_by is distinct from old.archived_by)
       and not private.is_privileged() then
      raise exception 'ROLE_REQUIRED: only Admin or Manager can change incharge or archive a client' using errcode = '42501';
    end if;
    if new.archived_at is null then new.archived_by := null;
    elsif old.archived_at is null then new.archived_by := coalesce(new.archived_by, private.current_staff_id());
    end if;
    if new.pan is distinct from old.pan and new.pan is not null and exists (
      select 1 from public.client_registration r
      where r.client_id = new.id and r.kind = 'gstin' and substr(r.number, 3, 10) <> new.pan) then
      raise exception 'GSTIN_PAN: the new PAN does not match this client''s GSTIN' using errcode = '23514';
    end if;
    new.updated_at := now();
  end if;
  if tg_op = 'INSERT' or new.incharge_id is distinct from old.incharge_id then
    if not exists (select 1 from public.staff_user s
                   where s.id = new.incharge_id and s.office_id = new.office_id and s.status = 'active') then
      raise exception 'INCHARGE: incharge must be active staff of this office' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

-- Registration: same office as the client; a GSTIN carries the client's PAN (AC-9); state derived.
-- Mirrors validateClient: the PAN match applies when the client has a PAN.
create or replace function private.registration_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_office uuid; v_pan text;
begin
  select c.office_id, c.pan into v_office, v_pan from public.client c where c.id = new.client_id;
  if v_office is null or v_office <> new.office_id then
    raise exception 'CLIENT_OFFICE: client belongs to another office' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and (new.client_id <> old.client_id or new.kind <> old.kind) then
    raise exception 'IMMUTABLE: registration client and kind cannot change' using errcode = 'P0001';
  end if;
  if new.kind = 'gstin' then
    new.state_code := substr(new.number, 1, 2);
    if v_pan is not null and substr(new.number, 3, 10) <> v_pan then
      raise exception 'GSTIN_PAN: this GSTIN does not contain the client''s PAN' using errcode = '23514';
    end if;
  else
    new.state_code := null;
  end if;
  return new;
end $$;

-- Contact: same office as the client.
create or replace function private.contact_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.client c where c.id = new.client_id and c.office_id = new.office_id) then
    raise exception 'CLIENT_OFFICE: client belongs to another office' using errcode = '23514';
  end if;
  return new;
end $$;

-- Master consistency: a type's group is in the same office; source and code never change.
create or replace function private.doc_type_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.doc_group g where g.id = new.doc_group_id and g.office_id = new.office_id) then
    raise exception 'GROUP_OFFICE: group belongs to another office' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and (new.source <> old.source or new.code <> old.code) then
    raise exception 'IMMUTABLE: type source and code cannot change' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;

-- Assignee must be active staff of the office.
create or replace function private.check_assignee(p_staff uuid, p_office uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if p_staff is not null and not exists (
    select 1 from public.staff_user s where s.id = p_staff and s.office_id = p_office and s.status = 'active') then
    raise exception 'ASSIGNEE: assigned staff must be active staff of this office' using errcode = '23514';
  end if;
end $$;

-- Plan rules (AC-20 + S2): pause/resume and assignment are Admin/Manager only.
-- enable/disable set app.plan_bulk for their own transaction (they restore remembered states, S3).
create or replace function private.client_group_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_bulk boolean := coalesce(current_setting('app.plan_bulk', true), '') = 'on';
        v_incharge uuid;
begin
  select c.incharge_id into v_incharge from public.client c where c.id = new.client_id and c.office_id = new.office_id;
  if not found then raise exception 'CLIENT_OFFICE: client belongs to another office' using errcode = '23514'; end if;
  if not exists (select 1 from public.doc_group g where g.id = new.doc_group_id and g.office_id = new.office_id) then
    raise exception 'GROUP_OFFICE: group belongs to another office' using errcode = '23514';
  end if;
  perform private.check_assignee(new.assigned_staff_id, new.office_id);
  if not v_bulk and not private.is_privileged() then
    if tg_op = 'INSERT' then
      if new.state <> 'active' or new.assigned_staff_id is distinct from v_incharge then
        raise exception 'ROLE_REQUIRED: only Admin or Manager can pause or assign' using errcode = '42501';
      end if;
    elsif new.assigned_staff_id is distinct from old.assigned_staff_id
       or (new.state is distinct from old.state and 'paused' in (old.state, new.state)) then
      raise exception 'ROLE_REQUIRED: only Admin or Manager can pause, resume or assign' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'UPDATE' and (new.client_id <> old.client_id or new.doc_group_id <> old.doc_group_id) then
    raise exception 'IMMUTABLE: plan rows cannot move' using errcode = 'P0001';
  end if;
  if new.state = 'paused' then
    if tg_op = 'INSERT' or old.state <> 'paused' then new.paused_at := now(); end if;
  else
    new.paused_at := null;
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace function private.client_doc_type_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_bulk boolean := coalesce(current_setting('app.plan_bulk', true), '') = 'on';
begin
  if not exists (select 1 from public.client_group g
                 join public.doc_type t on t.id = new.doc_type_id and t.doc_group_id = g.doc_group_id
                 where g.id = new.client_group_id and g.client_id = new.client_id and g.office_id = new.office_id) then
    raise exception 'PLAN_MISMATCH: type, group and client do not belong together' using errcode = '23514';
  end if;
  if exists (select 1 from public.doc_type t where t.id = new.doc_type_id and t.source = 'firm') then
    raise exception 'FIRM_RECORD: firm records are never part of a collection plan' using errcode = '23514';
  end if;
  perform private.check_assignee(new.assigned_staff_id, new.office_id);
  if not v_bulk and not private.is_privileged() then
    if tg_op = 'INSERT' then
      if new.state <> 'active' or new.assigned_staff_id is not null then
        raise exception 'ROLE_REQUIRED: only Admin or Manager can pause or assign' using errcode = '42501';
      end if;
    elsif new.assigned_staff_id is distinct from old.assigned_staff_id
       or (new.state is distinct from old.state and 'paused' in (old.state, new.state)) then
      raise exception 'ROLE_REQUIRED: only Admin or Manager can pause, resume or assign' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    if new.client_id <> old.client_id or new.doc_type_id <> old.doc_type_id or new.client_group_id <> old.client_group_id then
      raise exception 'IMMUTABLE: plan rows cannot move' using errcode = 'P0001';
    end if;
    -- state_before_disable is written only by enable/disable. A deliberate per-type state change
    -- while the group is off wins over the remembered state.
    if not v_bulk then
      new.state_before_disable := case when new.state is distinct from old.state then null else old.state_before_disable end;
    end if;
  elsif not v_bulk then
    new.state_before_disable := null;
  end if;
  if new.state = 'paused' then
    if tg_op = 'INSERT' or old.state <> 'paused' then new.paused_at := now(); end if;
  else
    new.paused_at := null;
  end if;
  new.updated_at := now();
  return new;
end $$;

-- S1 / AC-23: activity data holds field names and IDs only — never PAN, GSTIN, TAN, email or mobile.
create or replace function private.activity_no_pii()
returns trigger language plpgsql set search_path = '' as $$
declare v jsonb; s text;
begin
  for v in select * from jsonb_path_query(new.data, 'strict $.**') loop
    if jsonb_typeof(v) = 'object' then
      if exists (select 1 from jsonb_object_keys(v) k
                 where lower(k) in ('pan', 'gstin', 'tan', 'email', 'mobile', 'phone')) then
        raise exception 'ACTIVITY_PII: activity data must hold field names and IDs only' using errcode = '23514';
      end if;
    elsif jsonb_typeof(v) in ('string', 'number') then
      s := v #>> '{}';
      if s ~ '[A-Z]{5}[0-9]{4}[A-Z]' or s ~ '[A-Z]{4}[0-9]{5}[A-Z]'
         or s ~* '[^\s@]+@[^\s@]+\.[a-z]{2,}'
         or regexp_replace(s, '[\s-]', '', 'g') ~ '^(\+?91|0)?[6-9][0-9]{9}$' then
        raise exception 'ACTIVITY_PII: activity data must hold field names and IDs only' using errcode = '23514';
      end if;
    end if;
  end loop;
  return new;
end $$;
create trigger activity_no_pii before insert on public.activity
  for each row execute function private.activity_no_pii();

create trigger client_before_write before insert or update on public.client
  for each row execute function private.client_before_write();
create trigger client_registration_before_write before insert or update on public.client_registration
  for each row execute function private.registration_before_write();
create trigger client_contact_before_write before insert or update on public.client_contact
  for each row execute function private.contact_before_write();
create trigger doc_type_before_write before insert or update on public.doc_type
  for each row execute function private.doc_type_before_write();
create trigger doc_group_touch before update on public.doc_group
  for each row execute function private.touch_updated_at();
create trigger client_group_before_write before insert or update on public.client_group
  for each row execute function private.client_group_before_write();
create trigger client_doc_type_before_write before insert or update on public.client_doc_type
  for each row execute function private.client_doc_type_before_write();

do $$
declare t text;
begin
  foreach t in array array['client', 'client_registration', 'client_contact', 'doc_group', 'doc_type',
                           'financial_year', 'period', 'client_group', 'client_doc_type'] loop
    execute format('create trigger %I before delete on public.%I for each row execute function private.forbid_delete_unless_purge()',
                   t || '_no_delete', t);
  end loop;
end $$;

-- ── Financial years and periods (AC-5) ───────────────────────────────────
create or replace function private.create_financial_year(p_office_id uuid, p_start_year integer)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_code  text := p_start_year || '-' || lpad(((p_start_year + 1) % 100)::text, 2, '0');
  v_start date := make_date(p_start_year, 4, 1);
  v_fy    uuid;
  d       date;
  i       integer;
begin
  insert into public.financial_year (office_id, code, start_date, end_date)
    values (p_office_id, v_code, v_start, make_date(p_start_year + 1, 3, 31)) returning id into v_fy;
  for i in 0..11 loop
    d := (v_start + make_interval(months => i))::date;
    insert into public.period (office_id, financial_year_id, kind, code, label, start_date, end_date)
      values (p_office_id, v_fy, 'month', to_char(d, 'YYYY-MM'), to_char(d, 'Mon YYYY'), d,
              (d + interval '1 month' - interval '1 day')::date);
  end loop;
  for i in 1..4 loop
    d := (v_start + make_interval(months => (i - 1) * 3))::date;
    insert into public.period (office_id, financial_year_id, kind, code, label, start_date, end_date)
      values (p_office_id, v_fy, 'quarter', v_code || '-Q' || i,
              'Q' || i || ' ' || v_code || ' (' || to_char(d, 'Mon') || '–' || to_char(d + interval '2 months', 'Mon') || ')',
              d, (d + interval '3 months' - interval '1 day')::date);
  end loop;
  insert into public.period (office_id, financial_year_id, kind, code, label, start_date, end_date)
    values (p_office_id, v_fy, 'year', v_code, 'FY ' || v_code, v_start, make_date(p_start_year + 1, 3, 31));
  return v_fy;
end $$;

-- The period of the given frequency that contains today (India time); null for "as needed".
create or replace function private.current_period_id(p_office_id uuid, p_frequency public.frequency)
returns uuid language sql stable security invoker set search_path = '' as $$
  select p.id from public.period p
  where p.office_id = p_office_id
    and p.kind = case p_frequency when 'monthly' then 'month'::public.period_kind
                                  when 'quarterly' then 'quarter'::public.period_kind
                                  when 'yearly' then 'year'::public.period_kind end
    and (now() at time zone 'Asia/Kolkata')::date between p.start_date and p.end_date
  limit 1
$$;

create or replace function public.add_financial_year()
returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_office uuid := private.current_office_id(); v_last integer; v_fy uuid; v_today date;
begin
  if not private.has_role(array['admin']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: only Admin can add a financial year' using errcode = '42501';
  end if;
  select max(extract(year from start_date))::integer into v_last from public.financial_year where office_id = v_office;
  v_today := (now() at time zone 'Asia/Kolkata')::date;
  v_fy := private.create_financial_year(v_office,
    coalesce(v_last + 1, extract(year from v_today)::integer - case when extract(month from v_today) < 4 then 1 else 0 end));
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, private.current_staff_id(), 'financial_year.added', 'financial_year', v_fy::text, '{}');
  return v_fy;
end $$;

-- ── Collection plan functions (AC-19 … AC-21) ────────────────────────────
-- Core: enable a group for a client and copy active client-source master types. No activity row
-- (callers log). Returns the client_group id. Runs as the caller: RLS and column grants apply.
create or replace function private.enable_group_core(p_client_id uuid, p_doc_group_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_office uuid := private.current_office_id(); v_incharge uuid; v_group uuid;
begin
  select c.incharge_id into v_incharge from public.client c
    where c.id = p_client_id and c.office_id = v_office and c.archived_at is null;
  if not found then raise exception 'NOT_FOUND: client' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.doc_group g where g.id = p_doc_group_id and g.office_id = v_office and g.active) then
    raise exception 'NOT_FOUND: group' using errcode = 'P0002';
  end if;
  perform set_config('app.plan_bulk', 'on', true);
  insert into public.client_group (office_id, client_id, doc_group_id, assigned_staff_id, state)
    values (v_office, p_client_id, p_doc_group_id, v_incharge, 'active')
    on conflict (client_id, doc_group_id) do update
      set state = case when public.client_group.state = 'removed' then 'active'::public.plan_state else public.client_group.state end
    returning id into v_group;
  -- S3: rows switched off with the group get their previous state back.
  update public.client_doc_type
     set state = state_before_disable, state_before_disable = null
   where client_group_id = v_group and state_before_disable is not null;
  -- AC-19/21: add active client-source master types not yet on the client (firm records never).
  insert into public.client_doc_type (office_id, client_id, doc_type_id, client_group_id, frequency,
      ask_after_months, ask_day, overdue_after_months, overdue_day, reminders, start_period_id, state)
    select v_office, p_client_id, t.id, v_group, t.default_frequency,
           t.ask_after_months, t.ask_day, t.overdue_after_months, t.overdue_day, t.reminders,
           private.current_period_id(v_office, t.default_frequency), 'active'
      from public.doc_type t
     where t.doc_group_id = p_doc_group_id and t.office_id = v_office
       and t.source = 'client' and t.active and t.status = 'approved'
    on conflict (client_id, doc_type_id) do nothing;
  perform set_config('app.plan_bulk', 'off', true);
  return v_group;
end $$;

create or replace function public.enable_client_group(p_client_id uuid, p_doc_group_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_group uuid;
begin
  if not private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: Limited users cannot change collection plans' using errcode = '42501';
  end if;
  v_group := private.enable_group_core(p_client_id, p_doc_group_id);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (private.current_office_id(), private.current_staff_id(), 'client_group.enabled', 'client_group', v_group::text,
            jsonb_build_object('client_id', p_client_id, 'doc_group_id', p_doc_group_id));
  return v_group;
end $$;

create or replace function public.disable_client_group(p_client_id uuid, p_doc_group_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_group uuid;
begin
  if not private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: Limited users cannot change collection plans' using errcode = '42501';
  end if;
  select g.id into v_group from public.client_group g
    where g.client_id = p_client_id and g.doc_group_id = p_doc_group_id and g.office_id = private.current_office_id();
  if not found then raise exception 'NOT_FOUND: group is not enabled for this client' using errcode = 'P0002'; end if;
  perform set_config('app.plan_bulk', 'on', true);
  update public.client_doc_type set state_before_disable = state, state = 'removed'
   where client_group_id = v_group and state_before_disable is null;
  update public.client_group set state = 'removed' where id = v_group and state <> 'removed';
  perform set_config('app.plan_bulk', 'off', true);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (private.current_office_id(), private.current_staff_id(), 'client_group.disabled', 'client_group', v_group::text,
            jsonb_build_object('client_id', p_client_id, 'doc_group_id', p_doc_group_id));
end $$;

-- "+ Add type to <group>" (AC-20): copies the master's defaults into an enabled group.
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
            t.overdue_after_months, t.overdue_day, t.reminders, private.current_period_id(v_office, t.default_frequency), 'active')
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

-- ── CSV import backstop (AC-16) ──────────────────────────────────────────
-- The server validates every row first; this re-applies the DB rules in ONE transaction per call.
-- rows: [{name, client_type, pan, previous_reference, email, mobile, incharge_id,
--         registrations: [{kind, number}], group_ids: [uuid]}]  → [{row, client_id, code}]
create or replace function public.import_clients(p_rows jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_office uuid := private.current_office_id();
  r jsonb; i bigint; reg jsonb; g text;
  v_id uuid; v_code text;
  v_out jsonb := '[]'::jsonb;
  v_ids jsonb := '[]'::jsonb;
begin
  if not private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: Limited users cannot import clients' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'IMPORT_FORMAT: rows must be an array' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 200 then
    raise exception 'IMPORT_TOO_MANY: at most 200 rows per call' using errcode = '22023';
  end if;
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
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, private.current_staff_id(), 'client.imported', 'client', null,
            jsonb_build_object('count', jsonb_array_length(v_ids), 'client_ids', v_ids));
  return v_out;
end $$;

-- ── Grants (nothing for anon; minimal for authenticated) ─────────────────
revoke all on public.client, public.client_registration, public.client_contact, public.doc_group, public.doc_type,
  public.financial_year, public.period, public.client_group, public.client_doc_type from anon, authenticated;
grant select on public.client, public.client_registration, public.client_contact, public.doc_group, public.doc_type,
  public.financial_year, public.period, public.client_group, public.client_doc_type to authenticated;

-- code, created_by: never client-supplied. incharge/archived_*: role-checked by trigger.
grant insert (office_id, name, client_type, pan, previous_reference, email, mobile, incharge_id) on public.client to authenticated;
grant update (name, client_type, pan, previous_reference, email, mobile, incharge_id, archived_at, archived_by) on public.client to authenticated;
grant insert (office_id, client_id, kind, number, active) on public.client_registration to authenticated;
grant update (number, active) on public.client_registration to authenticated;
grant insert (office_id, client_id, name, role, email, mobile) on public.client_contact to authenticated;
grant update (name, role, email, mobile) on public.client_contact to authenticated;
grant insert (office_id, code, name, sort, active, enabled_for_new_clients) on public.doc_group to authenticated;
grant update (name, sort, active, enabled_for_new_clients) on public.doc_group to authenticated;
grant insert (office_id, doc_group_id, code, name, aliases, period_kind, default_frequency, source, used_for,
  ask_after_months, ask_day, overdue_after_months, overdue_day, registration_kind, reminders, active) on public.doc_type to authenticated;
grant update (name, aliases, default_frequency, used_for, ask_after_months, ask_day, overdue_after_months, overdue_day,
  registration_kind, reminders, active) on public.doc_type to authenticated;
grant insert (office_id, code, start_date, end_date) on public.financial_year to authenticated;
grant insert (office_id, financial_year_id, kind, code, label, start_date, end_date) on public.period to authenticated;
grant insert (office_id, client_id, doc_group_id, assigned_staff_id, state) on public.client_group to authenticated;
grant update (assigned_staff_id, state, remark) on public.client_group to authenticated;
grant insert (office_id, client_id, doc_type_id, client_group_id, frequency, ask_after_months, ask_day,
  overdue_after_months, overdue_day, reminders, start_period_id, state) on public.client_doc_type to authenticated;
-- state_before_disable is granted only so enable/disable (security invoker) can write it; the trigger
-- ignores any direct change outside those functions.
grant update (frequency, ask_after_months, ask_day, overdue_after_months, overdue_day, reminders,
  assigned_staff_id, start_period_id, state, state_before_disable, remark) on public.client_doc_type to authenticated;

revoke all on function private.pan_fits_type(text, public.client_type), private.gst_state_ok(text),
  private.can_see_client(uuid), private.is_privileged(), private.check_assignee(uuid, uuid),
  private.create_financial_year(uuid, integer), private.current_period_id(uuid, public.frequency),
  private.enable_group_core(uuid, uuid) from public, anon;
grant execute on function private.pan_fits_type(text, public.client_type), private.gst_state_ok(text),
  private.can_see_client(uuid), private.is_privileged(), private.check_assignee(uuid, uuid),
  private.create_financial_year(uuid, integer), private.current_period_id(uuid, public.frequency),
  private.enable_group_core(uuid, uuid) to authenticated;
revoke all on function public.add_financial_year(), public.enable_client_group(uuid, uuid),
  public.disable_client_group(uuid, uuid), public.add_client_doc_type(uuid, uuid), public.import_clients(jsonb) from public, anon;
grant execute on function public.add_financial_year(), public.enable_client_group(uuid, uuid),
  public.disable_client_group(uuid, uuid), public.add_client_doc_type(uuid, uuid), public.import_clients(jsonb) to authenticated;

-- ── Row-level security (default deny) ────────────────────────────────────
alter table public.client              enable row level security;
alter table public.client_registration enable row level security;
alter table public.client_contact      enable row level security;
alter table public.doc_group           enable row level security;
alter table public.doc_type            enable row level security;
alter table public.financial_year      enable row level security;
alter table public.period              enable row level security;
alter table public.client_group        enable row level security;
alter table public.client_doc_type     enable row level security;

-- Masters: every active staff member reads; Admin/Manager write the catalogue; Admin adds FYs (AC-5/6).
create policy doc_group_select on public.doc_group for select to authenticated
  using (office_id = (select private.current_office_id()));
create policy doc_group_insert on public.doc_group for insert to authenticated
  with check (office_id = (select private.current_office_id()) and (select private.has_role(array['admin', 'manager']::public.staff_role[])));
create policy doc_group_update on public.doc_group for update to authenticated
  using (office_id = (select private.current_office_id()) and (select private.has_role(array['admin', 'manager']::public.staff_role[])))
  with check (office_id = (select private.current_office_id()));

create policy doc_type_select on public.doc_type for select to authenticated
  using (office_id = (select private.current_office_id()));
create policy doc_type_insert on public.doc_type for insert to authenticated
  with check (office_id = (select private.current_office_id()) and (select private.has_role(array['admin', 'manager']::public.staff_role[])));
create policy doc_type_update on public.doc_type for update to authenticated
  using (office_id = (select private.current_office_id()) and (select private.has_role(array['admin', 'manager']::public.staff_role[])))
  with check (office_id = (select private.current_office_id()));

create policy financial_year_select on public.financial_year for select to authenticated
  using (office_id = (select private.current_office_id()));
create policy financial_year_insert on public.financial_year for insert to authenticated
  with check (office_id = (select private.current_office_id()) and (select private.has_role(array['admin']::public.staff_role[])));
create policy period_select on public.period for select to authenticated
  using (office_id = (select private.current_office_id()));
create policy period_insert on public.period for insert to authenticated
  with check (office_id = (select private.current_office_id()) and (select private.has_role(array['admin']::public.staff_role[])));

-- Clients and their children: Staff+ read all in the office; Limited via can_see_client (AC-12);
-- Staff+ write (column grants and triggers narrow further).
create policy client_select on public.client for select to authenticated
  using (office_id = (select private.current_office_id())
         and ((select private.has_role(array['admin', 'manager', 'staff']::public.staff_role[])) or private.can_see_client(id)));
create policy client_insert on public.client for insert to authenticated
  with check (office_id = (select private.current_office_id()) and (select private.has_role(array['admin', 'manager', 'staff']::public.staff_role[])));
create policy client_update on public.client for update to authenticated
  using (office_id = (select private.current_office_id()) and (select private.has_role(array['admin', 'manager', 'staff']::public.staff_role[])))
  with check (office_id = (select private.current_office_id()));

do $$
declare t text;
begin
  foreach t in array array['client_registration', 'client_contact', 'client_group', 'client_doc_type'] loop
    execute format($f$
      create policy %1$s_select on public.%1$I for select to authenticated
        using (office_id = (select private.current_office_id())
               and ((select private.has_role(array['admin', 'manager', 'staff']::public.staff_role[])) or private.can_see_client(client_id)));
      create policy %1$s_insert on public.%1$I for insert to authenticated
        with check (office_id = (select private.current_office_id()) and (select private.has_role(array['admin', 'manager', 'staff']::public.staff_role[])));
      create policy %1$s_update on public.%1$I for update to authenticated
        using (office_id = (select private.current_office_id()) and (select private.has_role(array['admin', 'manager', 'staff']::public.staff_role[])))
        with check (office_id = (select private.current_office_id()));
    $f$, t);
  end loop;
end $$;
