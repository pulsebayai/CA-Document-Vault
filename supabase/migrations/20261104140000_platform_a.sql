-- Feature 19 — super admin console, migration A (schema). Spec Y1, Y4, Y6; plan step 2.
--   1. platform_admin   — super admins: outside every firm, never staff; an email is one or the other
--   2. platform_access  — a support window: one super admin × one firm, a reason, 60 minutes
--   3. platform_audit   — every super admin action; append-only (nobody updates or deletes, service role included)
--   4. office           — suspended_at / suspended_by / suspend_reason (written only by the platform functions)
--   5. notification     — kind platform_access (to a firm's Admins when support access opens)
-- Rollback: drop the three tables, the office columns, the triggers and functions below; the enum value stays
-- (Postgres can't drop one) and is unused.

-- ── 1 ─────────────────────────────────────────────────────────────────────
create table public.platform_admin (
  id         uuid primary key references auth.users (id),
  email      text not null unique check (email = lower(email) and position('@' in email) > 1),
  full_name  text not null check (length(btrim(full_name)) between 1 and 120),
  status     text not null default 'active' check (status in ('active', 'deactivated')),
  created_at timestamptz not null default now()
);
alter table public.platform_admin enable row level security;
revoke all on public.platform_admin from public, anon, authenticated;
grant select on public.platform_admin to authenticated;
create policy platform_admin_self on public.platform_admin for select to authenticated using (id = (select auth.uid()));
create trigger platform_admin_no_delete before delete on public.platform_admin
  for each row execute function private.forbid_delete();

-- One email = staff in one firm OR a super admin (spec Y1). Checked both ways, under a shared advisory lock so two
-- concurrent inserts can't both pass.
create or replace function private.platform_email_clash()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext('platform_email:' || lower(new.email)));
  if tg_table_name = 'platform_admin' then
    if exists (select 1 from public.staff_user s where s.email = lower(new.email) or s.id = new.id) then
      raise exception 'EMAIL_IN_USE: this email belongs to a firm''s staff' using errcode = '23505';
    end if;
  else
    if exists (select 1 from public.platform_admin p where p.email = lower(new.email) or p.id = new.id) then
      raise exception 'EMAIL_IN_USE: this email can''t be used' using errcode = '23505';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.platform_email_clash() from public, anon, authenticated;
create trigger platform_admin_email_clash before insert or update of email, id on public.platform_admin
  for each row execute function private.platform_email_clash();
create trigger staff_user_platform_clash before insert or update of email, id on public.staff_user
  for each row execute function private.platform_email_clash();

-- ── 2 ─────────────────────────────────────────────────────────────────────
create table public.platform_access (
  id         uuid primary key default gen_random_uuid(),
  admin_id   uuid not null references public.platform_admin (id),
  office_id  uuid not null references public.office (id),
  reason     text not null check (length(btrim(reason)) between 10 and 500),
  opened_at  timestamptz not null default now(),
  expires_at timestamptz not null,
  closed_at  timestamptz,
  check (expires_at > opened_at)
);
create index platform_access_open_idx on public.platform_access (admin_id, office_id, expires_at desc) where closed_at is null;
alter table public.platform_access enable row level security; -- no policies: read and written only by the platform functions
revoke all on public.platform_access from public, anon, authenticated;
create trigger platform_access_no_delete before delete on public.platform_access
  for each row execute function private.forbid_delete();

-- ── 3 ─────────────────────────────────────────────────────────────────────
-- 02's ACTIVITY_PII rule for the platform log: detail holds IDs and view names only.
create or replace function private.platform_audit_no_pii()
returns trigger language plpgsql set search_path = '' as $$
declare v jsonb; s text;
begin
  for v in select * from jsonb_path_query(new.detail, 'strict $.**') loop
    if jsonb_typeof(v) = 'object' then
      if exists (select 1 from jsonb_object_keys(v) k
                 where lower(k) in ('pan', 'gstin', 'tan', 'email', 'mobile', 'phone', 'reason', 'name')) then
        raise exception 'AUDIT_PII: platform audit detail must hold IDs and view names only' using errcode = '23514';
      end if;
    elsif jsonb_typeof(v) in ('string', 'number') then
      s := v #>> '{}';
      if s ~ '[A-Z]{5}[0-9]{4}[A-Z]' or s ~ '[A-Z]{4}[0-9]{5}[A-Z]'
         or s ~* '[^\s@]+@[^\s@]+\.[a-z]{2,}'
         or regexp_replace(s, '[\s-]', '', 'g') ~ '^(\+?91|0)?[6-9][0-9]{9}$' then
        raise exception 'AUDIT_PII: platform audit detail must hold IDs and view names only' using errcode = '23514';
      end if;
    end if;
  end loop;
  return new;
end $$;
revoke all on function private.platform_audit_no_pii() from public, anon, authenticated;

create table public.platform_audit (
  id         bigint generated always as identity primary key,
  admin_id   uuid not null references public.platform_admin (id),
  action     text not null check (action ~ '^[a-z_]+\.[a-z_]+$' or action = 'viewed'),
  office_id  uuid references public.office (id),
  access_id  uuid references public.platform_access (id),
  detail     jsonb not null default '{}', -- IDs and view names only: free text (reasons) stays on its own row
  -- a suspension's reason (the office row clears it on reactivation, but the log keeps it); written only by
  -- platform_suspend_firm. Read access reasons stay on platform_access.
  reason     text check (reason is null or (action = 'firm.suspended' and length(btrim(reason)) between 10 and 500)),
  at         timestamptz not null default now()
);
create index platform_audit_office_idx on public.platform_audit (office_id, id desc);
create index platform_audit_at_idx on public.platform_audit (id desc);
alter table public.platform_audit enable row level security; -- no policies: read through platform_audit_list()
revoke all on public.platform_audit from public, anon, authenticated;
create trigger platform_audit_append_only before update or delete on public.platform_audit
  for each row execute function private.forbid_change();
create trigger platform_audit_no_pii before insert on public.platform_audit
  for each row execute function private.platform_audit_no_pii();

-- ── 4 ─────────────────────────────────────────────────────────────────────
alter table public.office
  add column suspended_at   timestamptz,
  add column suspended_by   uuid references public.platform_admin (id),
  add column suspend_reason text check (suspend_reason is null or length(btrim(suspend_reason)) between 10 and 500),
  add constraint office_suspended_fields check ((suspended_at is null) = (suspended_by is null) and (suspended_at is null) = (suspend_reason is null));
-- 17's column grant lets Admins update name and branch only; the new columns are written by the platform functions.

-- ── 5 ─────────────────────────────────────────────────────────────────────
alter type public.notification_kind add value if not exists 'platform_access';
alter table public.notification drop constraint notification_entity_type_check;
alter table public.notification add constraint notification_entity_type_check check (
     (kind = 'type_decision' and entity_type = 'doc_type')
  or (kind = 'link_upload' and entity_type = 'upload_request')
  or (kind::text = 'platform_access' and entity_type = 'platform_access'));
