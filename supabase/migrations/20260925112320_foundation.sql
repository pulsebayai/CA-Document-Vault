-- 01-walking-skeleton · foundation: office, staff, audit log, access helpers, RLS.
-- Rules (architecture.md): RLS default-deny on every table; office_id on every business table;
-- no hard delete; activity is append-only; helpers live in a non-exposed schema.

-- ── Types ────────────────────────────────────────────────────────────────
create type public.staff_role as enum ('admin', 'manager', 'staff', 'limited');
create type public.staff_status as enum ('invited', 'active', 'deactivated');

-- ── Tables ───────────────────────────────────────────────────────────────
create table public.office (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(btrim(name)) between 1 and 120),
  branch         text check (branch is null or length(btrim(branch)) between 1 and 120),
  fy_start_month smallint not null default 4 check (fy_start_month between 1 and 12),
  created_at     timestamptz not null default now()
);

create table public.staff_user (
  id             uuid primary key references auth.users (id) on delete restrict,
  office_id      uuid not null references public.office (id),
  full_name      text not null check (length(btrim(full_name)) between 1 and 120),
  email          text not null check (email = lower(email) and position('@' in email) > 1),
  role           public.staff_role not null,
  status         public.staff_status not null default 'invited',
  invited_by     uuid references public.staff_user (id),
  created_at     timestamptz not null default now(),
  activated_at   timestamptz,
  deactivated_at timestamptz
);
create unique index staff_user_email_key on public.staff_user (email);
create index staff_user_office_idx on public.staff_user (office_id);

create table public.activity (
  id          bigint generated always as identity primary key,
  office_id   uuid not null references public.office (id),
  actor_id    uuid references public.staff_user (id),
  action      text not null check (length(action) between 1 and 64),
  entity_type text not null check (length(entity_type) between 1 and 64),
  entity_id   text,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index activity_office_created_idx on public.activity (office_id, created_at desc);

-- Sign-in lockout (spec AC-3). Keyed by SHA-256 of the email, never the email itself.
create table public.login_attempt (
  email_hash   text primary key check (length(email_hash) = 64),
  failed_count integer not null default 0 check (failed_count >= 0),
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);

-- ── Private helpers (schema not exposed through the Data API) ────────────
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.current_staff_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select s.id from public.staff_user s
  where s.id = (select auth.uid()) and s.status = 'active'
$$;

create or replace function private.current_office_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select s.office_id from public.staff_user s
  where s.id = (select auth.uid()) and s.status = 'active'
$$;

create or replace function private.has_role(roles public.staff_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff_user s
    where s.id = (select auth.uid()) and s.status = 'active' and s.role = any (roles)
  )
$$;

revoke all on function private.current_staff_id(), private.current_office_id(), private.has_role(public.staff_role[]) from public, anon;
grant execute on function private.current_staff_id(), private.current_office_id(), private.has_role(public.staff_role[]) to authenticated;

-- ── Integrity triggers (apply to every role, including the service role) ──
-- AC-9: an office must always keep at least one active admin.
create or replace function private.guard_last_admin()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.role = 'admin' and old.status = 'active'
     and (new.role <> 'admin' or new.status <> 'active') then
    if not exists (
      select 1 from public.staff_user s
      where s.office_id = old.office_id and s.id <> old.id
        and s.role = 'admin' and s.status = 'active'
    ) then
      raise exception 'LAST_ADMIN: the office must keep at least one active Admin'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
create trigger staff_user_guard_last_admin
  before update of role, status on public.staff_user
  for each row execute function private.guard_last_admin();

-- No hard delete of staff (deactivate instead).
create or replace function private.forbid_delete()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'NO_DELETE: % rows are never deleted', tg_table_name using errcode = 'P0001';
end $$;
create trigger staff_user_no_delete before delete on public.staff_user
  for each row execute function private.forbid_delete();

-- AC-11: activity is append-only.
create or replace function private.forbid_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'APPEND_ONLY: % rows cannot be changed or deleted', tg_table_name using errcode = 'P0001';
end $$;
create trigger activity_append_only before update or delete on public.activity
  for each row execute function private.forbid_change();
create trigger office_no_delete before delete on public.office
  for each row execute function private.forbid_delete();

-- ── Grants: nothing for anon; minimal for authenticated ───────────────────
revoke all on public.office, public.staff_user, public.activity, public.login_attempt from anon, authenticated;
grant select on public.office to authenticated;
grant select on public.staff_user to authenticated;
grant update (full_name, role, status, activated_at, deactivated_at) on public.staff_user to authenticated;
grant select, insert on public.activity to authenticated;
-- login_attempt: service role only (no grants to authenticated).

-- ── Row-level security (default deny) ────────────────────────────────────
alter table public.office        enable row level security;
alter table public.staff_user    enable row level security;
alter table public.activity      enable row level security;
alter table public.login_attempt enable row level security;

create policy office_select on public.office for select to authenticated
  using (id = (select private.current_office_id()));

create policy staff_select on public.staff_user for select to authenticated
  using (office_id = (select private.current_office_id()));

create policy staff_update_admin on public.staff_user for update to authenticated
  using (office_id = (select private.current_office_id()) and (select private.has_role(array['admin']::public.staff_role[])))
  with check (office_id = (select private.current_office_id()));

create policy activity_select on public.activity for select to authenticated
  using (office_id = (select private.current_office_id()));

create policy activity_insert_self on public.activity for insert to authenticated
  with check (office_id = (select private.current_office_id()) and actor_id = (select private.current_staff_id()));
