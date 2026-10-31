-- Feature 14 — DSC tracking (spec AC-1 … AC-13, T1–T5; plan step 3). ADDITIVE-ONLY (architecture "Additive-only
-- migration exception", owner approval at the 14 plan gate): new types, tables, functions, triggers and policies only;
-- no existing object is changed. FKs to `client` cascade only so reset_test_office's purge (which deletes clients)
-- keeps working unchanged; real offices never delete clients.
--
-- Secrets at rest: the token PIN / password arrives here ALREADY ENCRYPTED by src/lib/dsc/crypto.ts (AES-256-GCM, the
-- key is a server env var and never reaches the database). `password_ct` is left out of the table's SELECT grant; the
-- only read is dsc_reveal (definer), which checks role + client and writes the activity row before it returns.
-- Writes go only through the dsc_* functions (transaction flags app.dsc_write / app.dsc_custody, plan deviation D-3).

-- ── 1. Types and tables ─────────────────────────────────────────────────────────────────────────────────────────────
create type public.dsc_class as enum ('class3', 'dgft', 'other');
create type public.dsc_direction as enum ('out', 'in');

create table public.dsc (
  id              uuid primary key default gen_random_uuid(),
  office_id       uuid not null references public.office (id),
  client_id       uuid not null references public.client (id) on delete cascade,
  holder_name     text not null check (holder_name = btrim(holder_name) and char_length(holder_name) between 1 and 120),
  dsc_class       public.dsc_class,
  issuer          text check (issuer is null or (issuer = btrim(issuer) and char_length(issuer) between 1 and 80)),
  token_note      text check (token_note is null or (token_note = btrim(token_note) and char_length(token_note) between 1 and 200)),
  expires_on      date not null,
  -- k<keyId>.<iv 12 B>.<tag 16 B>.<ciphertext>, base64url (src/lib/dsc/crypto.ts CIPHERTEXT_PATTERN).
  -- (Postgres caps a regex repetition at 255, so the length limit is a separate check.)
  password_ct     text not null constraint dsc_password_ct_shape check (char_length(password_ct) <= 700
                    and password_ct ~ '^k[a-z0-9]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{2,}$'),
  password_set_at timestamptz not null default now(),
  password_set_by uuid not null references public.staff_user (id),
  created_at      timestamptz not null default now(),
  created_by      uuid not null references public.staff_user (id),
  updated_at      timestamptz,
  updated_by      uuid references public.staff_user (id),
  archived_at     timestamptz,
  archived_by     uuid references public.staff_user (id),
  archive_reason  text check (archive_reason is null or char_length(archive_reason) between 1 and 500),
  constraint dsc_archive_fields check ((archived_at is null) = (archived_by is null) and (archived_at is null) = (archive_reason is null))
);
create index dsc_client_idx on public.dsc (client_id);
create index dsc_due_idx on public.dsc (office_id, expires_on) where archived_at is null;

create table public.dsc_custody (
  id          uuid primary key default gen_random_uuid(),
  office_id   uuid not null references public.office (id),
  dsc_id      uuid not null references public.dsc (id) on delete cascade,
  direction   public.dsc_direction not null,
  person_name text not null check (person_name = btrim(person_name) and char_length(person_name) between 1 and 120),
  on_date     date not null,
  note        text check (note is null or (note = btrim(note) and char_length(note) between 1 and 200)),
  actor_id    uuid not null references public.staff_user (id),
  at          timestamptz not null default clock_timestamp()
);
create index dsc_custody_dsc_idx on public.dsc_custody (dsc_id, at desc);
create index dsc_custody_office_idx on public.dsc_custody (office_id);

create table public.client_dsc_setting (
  client_id   uuid primary key references public.client (id) on delete cascade,
  office_id   uuid not null references public.office (id),
  remind_days integer not null check (remind_days between 1 and 180),
  updated_at  timestamptz not null default now(),
  updated_by  uuid not null references public.staff_user (id)
);

-- Nothing is ever deleted (archive only), except by the test purge.
create trigger dsc_no_delete before delete on public.dsc
  for each row execute function private.forbid_delete_unless_purge();
create trigger dsc_custody_no_delete before delete on public.dsc_custody
  for each row execute function private.forbid_delete_unless_purge();
create trigger client_dsc_setting_no_delete before delete on public.client_dsc_setting
  for each row execute function private.forbid_delete_unless_purge();

-- Custody history is append-only.
create function private.dsc_custody_no_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'APPEND_ONLY: dsc_custody rows are never changed' using errcode = 'P0001';
end $$;
create trigger dsc_custody_no_update before update on public.dsc_custody
  for each row execute function private.dsc_custody_no_update();

-- ── 2. RLS and grants ───────────────────────────────────────────────────────────────────────────────────────────────
alter table public.dsc enable row level security;
alter table public.dsc_custody enable row level security;
alter table public.client_dsc_setting enable row level security;

-- Reads short-circuit for Staff+ with a one-time role check, exactly like 02's client_select (Staff+ see every client
-- of the office); Limited fall through to can_see_client per row. Without it, dsc_due spent ~150 ms on 3,000 calls.
create policy dsc_select on public.dsc for select to authenticated
  using (office_id = (select private.current_office_id())
         and ((select private.has_role(array['admin', 'manager', 'staff']::public.staff_role[])) or private.can_see_client(client_id)));
create policy dsc_insert on public.dsc for insert to authenticated
  with check (office_id = (select private.current_office_id())
              and coalesce((select current_setting('app.dsc_write', true)), '') = id::text
              and private.can_see_client(client_id));
create policy dsc_update on public.dsc for update to authenticated
  using (office_id = (select private.current_office_id())
         and coalesce((select current_setting('app.dsc_write', true)), '') = id::text
         and private.can_see_client(client_id))
  with check (office_id = (select private.current_office_id()) and private.can_see_client(client_id));

create policy dsc_custody_select on public.dsc_custody for select to authenticated
  using (office_id = (select private.current_office_id())
         and exists (select 1 from public.dsc d where d.id = dsc_id));
create policy dsc_custody_insert on public.dsc_custody for insert to authenticated
  with check (office_id = (select private.current_office_id())
              and coalesce((select current_setting('app.dsc_custody', true)), '') = dsc_id::text
              and actor_id = (select private.current_staff_id())
              and exists (select 1 from public.dsc d where d.id = dsc_custody.dsc_id and d.office_id = dsc_custody.office_id));

create policy client_dsc_setting_select on public.client_dsc_setting for select to authenticated
  using (office_id = (select private.current_office_id())
         and ((select private.has_role(array['admin', 'manager', 'staff']::public.staff_role[])) or private.can_see_client(client_id)));
create policy client_dsc_setting_insert on public.client_dsc_setting for insert to authenticated
  with check (office_id = (select private.current_office_id())
              and coalesce((select current_setting('app.dsc_write', true)), '') = client_id::text
              and private.can_see_client(client_id));
create policy client_dsc_setting_update on public.client_dsc_setting for update to authenticated
  using (office_id = (select private.current_office_id())
         and coalesce((select current_setting('app.dsc_write', true)), '') = client_id::text
         and private.can_see_client(client_id))
  with check (office_id = (select private.current_office_id()) and private.can_see_client(client_id));

revoke all on public.dsc, public.dsc_custody, public.client_dsc_setting from anon, authenticated;
-- password_ct is NOT selectable by app roles (AC-6): only dsc_reveal returns it.
grant select (id, office_id, client_id, holder_name, dsc_class, issuer, token_note, expires_on, password_set_at,
              password_set_by, created_at, created_by, updated_at, updated_by, archived_at, archived_by, archive_reason)
  on public.dsc to authenticated;
grant insert (id, office_id, client_id, holder_name, dsc_class, issuer, token_note, expires_on, password_ct,
              password_set_at, password_set_by, created_by) on public.dsc to authenticated;
grant update (holder_name, dsc_class, issuer, token_note, expires_on, password_ct, password_set_at, password_set_by,
              updated_at, updated_by, archived_at, archived_by, archive_reason) on public.dsc to authenticated;
grant select on public.dsc_custody to authenticated;
grant insert (office_id, dsc_id, direction, person_name, on_date, note, actor_id) on public.dsc_custody to authenticated;
grant select on public.client_dsc_setting to authenticated;
grant insert (client_id, office_id, remind_days, updated_at, updated_by) on public.client_dsc_setting to authenticated;
grant update (remind_days, updated_at, updated_by) on public.client_dsc_setting to authenticated;

-- ── 3. Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────
create function private.dsc_ct_ok(p text)
returns boolean language sql immutable set search_path = '' as $$
  select char_length(p) <= 700 and p ~ '^k[a-z0-9]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{2,}$'
$$;

create function private.dsc_text(p jsonb, k text, maxlen integer, code text)
returns text language plpgsql immutable set search_path = '' as $$
declare v text := nullif(btrim(p ->> k), '');
begin
  if v is not null and char_length(v) > maxlen then
    raise exception '%: % characters max', code, maxlen using errcode = '22023';
  end if;
  return v;
end $$;

-- ── 4. dsc_save: add, edit / renew, change password (AC-2, AC-4, AC-6) ────────────────────────────────────────────
-- Invoker functions never read password_ct (no SELECT grant on it): rows are read by an explicit column list, and the
-- password is written by its own UPDATE, only when a new ciphertext arrives. Row locks (FOR UPDATE) need the update
-- policy, so the write flag is set before the lock and cleared after the write.
create function public.dsc_save(p jsonb)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_staff   uuid := private.current_staff_id();
  v_id      uuid := nullif(p ->> 'id', '')::uuid;
  v_ct      text := nullif(p ->> 'password_ct', '');
  v_fields  text[] := '{}';
  c         record;
  d         record;
  v_new_id  uuid;
  v_holder  text;
  v_class   public.dsc_class;
  v_issuer  text;
  v_note    text;
  v_expires date;
begin
  if v_staff is null or not private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: Staff, Manager or Admin' using errcode = '42501';
  end if;
  if v_ct is not null and not private.dsc_ct_ok(v_ct) then
    raise exception 'DSC_BAD_CIPHERTEXT: the password must be encrypted by the server' using errcode = '22023';
  end if;

  if v_id is null then
    select x.id, x.office_id, x.archived_at into c from public.client x where x.id = nullif(p ->> 'client_id', '')::uuid; -- RLS
    if not found then raise exception 'NOT_FOUND: client' using errcode = 'P0002'; end if;
    if c.archived_at is not null then raise exception 'CLIENT_ARCHIVED: unarchive the client first' using errcode = '22023'; end if;
    if v_ct is null then raise exception 'DSC_PASSWORD_REQUIRED: enter the token PIN / password' using errcode = '22023'; end if;
    v_holder := private.dsc_text(p, 'holder_name', 120, 'DSC_HOLDER');
    v_class := nullif(p ->> 'dsc_class', '')::public.dsc_class;
    v_issuer := private.dsc_text(p, 'issuer', 80, 'DSC_ISSUER');
    v_note := private.dsc_text(p, 'token_note', 200, 'DSC_NOTE');
    v_expires := nullif(p ->> 'expires_on', '')::date;
    if v_holder is null then raise exception 'DSC_HOLDER: enter the holder name' using errcode = '22023'; end if;
    if v_expires is null then raise exception 'DSC_EXPIRY: enter the expiry date' using errcode = '22023'; end if;
    v_new_id := gen_random_uuid();
    perform set_config('app.dsc_write', v_new_id::text, true);
    insert into public.dsc (id, office_id, client_id, holder_name, dsc_class, issuer, token_note, expires_on,
                            password_ct, password_set_by, created_by)
      values (v_new_id, c.office_id, c.id, v_holder, v_class, v_issuer, v_note, v_expires, v_ct, v_staff, v_staff);
    perform set_config('app.dsc_write', '', true);
    insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
      values (c.office_id, v_staff, 'dsc.created', 'dsc', v_new_id::text, jsonb_build_object('client_id', c.id));
    return v_new_id;
  end if;

  perform set_config('app.dsc_write', v_id::text, true);
  select x.id, x.office_id, x.client_id, x.holder_name, x.dsc_class, x.issuer, x.token_note, x.expires_on, x.archived_at
    into d from public.dsc x where x.id = v_id for update; -- RLS
  if not found then raise exception 'NOT_FOUND: DSC' using errcode = 'P0002'; end if;
  if d.archived_at is not null then raise exception 'DSC_ARCHIVED: unarchive it first' using errcode = '22023'; end if;
  -- Step 10 review I-3: an archived client's DSCs are read-only (like 03's archived = read-only).
  if exists (select 1 from public.client cl where cl.id = d.client_id and cl.archived_at is not null) then
    raise exception 'CLIENT_ARCHIVED: unarchive the client first' using errcode = '22023';
  end if;
  if p ? 'client_id' and nullif(p ->> 'client_id', '')::uuid is distinct from d.client_id then
    raise exception 'DSC_CLIENT_FIXED: a DSC stays with its client' using errcode = '22023';
  end if;
  v_holder := case when p ? 'holder_name' then private.dsc_text(p, 'holder_name', 120, 'DSC_HOLDER') else d.holder_name end;
  v_class := case when p ? 'dsc_class' then nullif(p ->> 'dsc_class', '')::public.dsc_class else d.dsc_class end;
  v_issuer := case when p ? 'issuer' then private.dsc_text(p, 'issuer', 80, 'DSC_ISSUER') else d.issuer end;
  v_note := case when p ? 'token_note' then private.dsc_text(p, 'token_note', 200, 'DSC_NOTE') else d.token_note end;
  v_expires := case when p ? 'expires_on' then nullif(p ->> 'expires_on', '')::date else d.expires_on end;
  if v_holder is null then raise exception 'DSC_HOLDER: enter the holder name' using errcode = '22023'; end if;
  if v_expires is null then raise exception 'DSC_EXPIRY: enter the expiry date' using errcode = '22023'; end if;
  -- Field names in alphabetical order (activity data: names only, never values).
  if v_class is distinct from d.dsc_class then v_fields := array_append(v_fields, 'dsc_class'); end if;
  if v_expires is distinct from d.expires_on then v_fields := array_append(v_fields, 'expires_on'); end if;
  if v_holder is distinct from d.holder_name then v_fields := array_append(v_fields, 'holder_name'); end if;
  if v_issuer is distinct from d.issuer then v_fields := array_append(v_fields, 'issuer'); end if;
  if v_note is distinct from d.token_note then v_fields := array_append(v_fields, 'token_note'); end if;
  if cardinality(v_fields) > 0 then
    update public.dsc set holder_name = v_holder, dsc_class = v_class, issuer = v_issuer, token_note = v_note,
           expires_on = v_expires, updated_at = now(), updated_by = v_staff
     where id = d.id;
    insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
      values (d.office_id, v_staff, 'dsc.updated', 'dsc', d.id::text,
              jsonb_build_object('client_id', d.client_id, 'fields', to_jsonb(v_fields)));
  end if;
  if v_ct is not null then -- a new value from the server (a fresh IV each time), i.e. "Change password"
    update public.dsc set password_ct = v_ct, password_set_at = now(), password_set_by = v_staff,
           updated_at = now(), updated_by = v_staff
     where id = d.id;
    insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
      values (d.office_id, v_staff, 'dsc.password_changed', 'dsc', d.id::text, jsonb_build_object('client_id', d.client_id));
  end if;
  perform set_config('app.dsc_write', '', true);
  return d.id;
end $$;

-- ── 5. dsc_reveal: the one read of the ciphertext, logged before it returns (AC-7, T5) ───────────────────────────
-- SECURITY DEFINER (the caller has no SELECT on password_ct). Tenant first; the activity row is written in the same
-- transaction as the value is returned, so a reveal without its log row can't happen. Useless without the server key.
create function public.dsc_reveal(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_staff  uuid := private.current_staff_id();
  v_office uuid := private.current_office_id();
  d        public.dsc;
begin
  if v_staff is null or v_office is null then raise exception 'ROLE_REQUIRED: sign in as active staff' using errcode = '42501'; end if;
  -- Role before lookup (step 10 review N-4): a Limited caller learns nothing about which IDs exist.
  if not private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: Staff, Manager or Admin' using errcode = '42501';
  end if;
  select * into d from public.dsc x where x.id = p_id and x.office_id = v_office;
  if not found then raise exception 'NOT_FOUND: DSC' using errcode = 'P0002'; end if;
  if not private.can_see_client(d.client_id) then raise exception 'NOT_FOUND: DSC' using errcode = 'P0002'; end if;
  if d.archived_at is not null then raise exception 'DSC_ARCHIVED: unarchive it first' using errcode = '22023'; end if;
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, v_staff, 'dsc.password_revealed', 'dsc', d.id::text, jsonb_build_object('client_id', d.client_id));
  return d.password_ct;
end $$;

-- ── 6. Custody (AC-8, AC-9) ─────────────────────────────────────────────────────────────────────────────────────
create function public.dsc_custody_log(p jsonb)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_staff  uuid := private.current_staff_id();
  v_dsc    uuid := nullif(p ->> 'dsc_id', '')::uuid;
  v_dir    text := p ->> 'direction';
  v_person text := private.dsc_text(p, 'person_name', 120, 'DSC_PERSON');
  v_note   text := private.dsc_text(p, 'note', 200, 'DSC_NOTE');
  v_on     date := nullif(p ->> 'on_date', '')::date;
  v_last   public.dsc_direction;
  v_last_on date;
  v_id     uuid;
  d        record;
begin
  if v_staff is null then raise exception 'ROLE_REQUIRED: sign in as active staff' using errcode = '42501'; end if;
  perform set_config('app.dsc_write', coalesce(v_dsc::text, ''), true); -- the lock below needs the update policy
  select x.id, x.office_id, x.client_id, x.archived_at into d from public.dsc x where x.id = v_dsc for update; -- RLS
  if not found then raise exception 'NOT_FOUND: DSC' using errcode = 'P0002'; end if;
  perform set_config('app.dsc_write', '', true);
  if d.archived_at is not null then raise exception 'DSC_ARCHIVED: unarchive it first' using errcode = '22023'; end if;
  if exists (select 1 from public.client c where c.id = d.client_id and c.archived_at is not null) then
    raise exception 'CLIENT_ARCHIVED: unarchive the client first' using errcode = '22023';
  end if;
  if v_dir is null or v_dir not in ('out', 'in') then raise exception 'DIRECTION_INVALID: out or in' using errcode = '22023'; end if;
  if v_person is null then raise exception 'DSC_PERSON: enter the name' using errcode = '22023'; end if;
  if v_on is null then raise exception 'DATE_REQUIRED: enter the date' using errcode = '22023'; end if;
  if v_on > private.office_today(d.office_id) then raise exception 'DATE_IN_FUTURE: the date can''t be in the future' using errcode = '22023'; end if;
  select h.direction, h.on_date into v_last, v_last_on from public.dsc_custody h where h.dsc_id = d.id order by h.at desc, h.id desc limit 1;
  -- Step 10 review I-1: moves stay in date order, so "With X since <date>" and the log read right.
  if v_last_on is not null and v_on < v_last_on then
    raise exception 'DATE_BEFORE_LAST_MOVE: the date can''t be before the last move' using errcode = '22023';
  end if;
  if v_dir = 'out' and v_last = 'out' then raise exception 'DSC_ALREADY_OUT: record it as received back first' using errcode = '22023'; end if;
  if v_dir = 'in' and v_last is distinct from 'out' then raise exception 'DSC_NOT_OUT: the DSC is in the office' using errcode = '22023'; end if;
  perform set_config('app.dsc_custody', d.id::text, true);
  insert into public.dsc_custody (office_id, dsc_id, direction, person_name, on_date, note, actor_id)
    values (d.office_id, d.id, v_dir::public.dsc_direction, v_person, v_on, v_note, v_staff)
    returning id into v_id;
  perform set_config('app.dsc_custody', '', true);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (d.office_id, v_staff, case v_dir when 'out' then 'dsc.given_out' else 'dsc.received_back' end, 'dsc', d.id::text,
            jsonb_build_object('client_id', d.client_id));
  return v_id;
end $$;

-- ── 7. Archive / unarchive (AC-5) ────────────────────────────────────────────────────────────────────────────────
create function public.dsc_archive(p_id uuid, p_reason text)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_staff  uuid := private.current_staff_id();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  d        record;
begin
  if v_staff is null or not private.has_role(array['admin', 'manager']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: Admin or Manager only' using errcode = '42501';
  end if;
  if v_reason is null or char_length(v_reason) > 500 then
    raise exception 'REASON_REQUIRED: a reason of up to 500 characters' using errcode = '22023';
  end if;
  perform set_config('app.dsc_write', coalesce(p_id::text, ''), true);
  select x.id, x.office_id, x.client_id, x.archived_at into d from public.dsc x where x.id = p_id for update;
  if not found then raise exception 'NOT_FOUND: DSC' using errcode = 'P0002'; end if;
  if d.archived_at is not null then raise exception 'ALREADY_ARCHIVED: the DSC is archived' using errcode = '22023'; end if;
  -- Step 10 review I-4: a DSC that is out is received back first, so its return can still be logged.
  if (select h.direction from public.dsc_custody h where h.dsc_id = d.id order by h.at desc, h.id desc limit 1) = 'out' then
    raise exception 'DSC_OUT: record it as received back first' using errcode = '22023';
  end if;
  update public.dsc set archived_at = now(), archived_by = v_staff, archive_reason = v_reason where id = d.id;
  perform set_config('app.dsc_write', '', true);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (d.office_id, v_staff, 'dsc.archived', 'dsc', d.id::text, jsonb_build_object('client_id', d.client_id));
end $$;

create function public.dsc_unarchive(p_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_staff uuid := private.current_staff_id();
  d       record;
begin
  if v_staff is null or not private.has_role(array['admin', 'manager']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: Admin or Manager only' using errcode = '42501';
  end if;
  perform set_config('app.dsc_write', coalesce(p_id::text, ''), true);
  select x.id, x.office_id, x.client_id, x.archived_at into d from public.dsc x where x.id = p_id for update;
  if not found then raise exception 'NOT_FOUND: DSC' using errcode = 'P0002'; end if;
  if d.archived_at is null then raise exception 'NOT_ARCHIVED: the DSC is not archived' using errcode = '22023'; end if;
  update public.dsc set archived_at = null, archived_by = null, archive_reason = null, updated_at = now(), updated_by = v_staff
   where id = d.id;
  perform set_config('app.dsc_write', '', true);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (d.office_id, v_staff, 'dsc.unarchived', 'dsc', d.id::text, jsonb_build_object('client_id', d.client_id));
end $$;

-- ── 8. Remind days per client (AC-10; deviation D-1: logged as dsc.remind_days_set) ──────────────────────────────
create function public.dsc_set_remind_days(p_client_id uuid, p_days integer)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_staff uuid := private.current_staff_id();
  v_old   integer;
  c       record;
begin
  if v_staff is null or not private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: Staff, Manager or Admin' using errcode = '42501';
  end if;
  if p_days is null or p_days not between 1 and 180 then
    raise exception 'DAYS_INVALID: 1 to 180 days' using errcode = '22023';
  end if;
  select x.id, x.office_id, x.archived_at into c from public.client x where x.id = p_client_id; -- RLS
  if not found then raise exception 'NOT_FOUND: client' using errcode = 'P0002'; end if;
  if c.archived_at is not null then raise exception 'CLIENT_ARCHIVED: unarchive the client first' using errcode = '22023'; end if;
  select s.remind_days into v_old from public.client_dsc_setting s where s.client_id = c.id;
  if coalesce(v_old, 30) = p_days and v_old is not null then return; end if;
  perform set_config('app.dsc_write', c.id::text, true);
  insert into public.client_dsc_setting (client_id, office_id, remind_days, updated_at, updated_by)
    values (c.id, c.office_id, p_days, now(), v_staff)
    on conflict (client_id) do update set remind_days = excluded.remind_days, updated_at = excluded.updated_at,
                                          updated_by = excluded.updated_by;
  perform set_config('app.dsc_write', '', true);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (c.office_id, v_staff, 'dsc.remind_days_set', 'client', c.id::text,
            jsonb_build_object('client_id', c.id, 'remind_days', p_days));
end $$;

-- ── 9. Today's "DSC expiring" (AC-11, T2, T3): its own read, today_items untouched ────────────────────────────────
-- Live DSCs of live clients whose expiry is within the client's remind days (default 30) of the office date, or has
-- passed. Mine = clients I am incharge of (T3). RLS decides what Everyone means. Rows: at most 200, soonest first.
create function public.dsc_due(p_scope text)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_staff  uuid := private.current_staff_id();
  v_office uuid := private.current_office_id();
  v_today  date;
  v        jsonb;
begin
  if v_staff is null then raise exception 'ROLE_REQUIRED: sign in as active staff' using errcode = '42501'; end if;
  if p_scope is null or p_scope not in ('mine', 'everyone') then
    raise exception 'BAD_SCOPE: mine or everyone' using errcode = '22023';
  end if;
  v_today := private.office_today(v_office);
  with due as (
    select d.id, d.client_id, c.code as client_code, c.name as client_name, d.holder_name, d.dsc_class, d.expires_on,
           coalesce(s.remind_days, 30) as remind_days
      from public.dsc d
      join public.client c on c.id = d.client_id
      left join public.client_dsc_setting s on s.client_id = d.client_id
     where d.office_id = v_office and d.archived_at is null and c.archived_at is null
       and d.expires_on <= v_today + 180 -- the widest window (index prefilter)
       and d.expires_on <= v_today + coalesce(s.remind_days, 30)
       and (p_scope = 'everyone' or c.incharge_id = v_staff)
  ), rows as (
    select u.*, h.direction, h.person_name, h.on_date
      from due u
      left join lateral (select x.direction, x.person_name, x.on_date from public.dsc_custody x
                          where x.dsc_id = u.id order by x.at desc, x.id desc limit 1) h on true
     order by u.expires_on, u.holder_name, u.id
     limit 200
  )
  select jsonb_build_object(
    'count', (select count(*) from due),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'client_id', r.client_id, 'client_code', r.client_code, 'client_name', r.client_name,
        'holder_name', r.holder_name, 'dsc_class', r.dsc_class, 'expires_on', r.expires_on,
        'days_left', r.expires_on - v_today, 'remind_days', r.remind_days,
        'out_to', case when r.direction = 'out' then r.person_name end,
        'out_since', case when r.direction = 'out' then r.on_date end)
      order by r.expires_on, r.holder_name, r.id) from rows r), '[]'::jsonb))
    into v;
  return v;
end $$;

-- ── 10. Test-only seed for the dsc_due timing (spec NFR; service role, is_test offices only) ──────────────────────
create function public.test_seed_dsc(p_office_id uuid, p_per_client integer, p_today date)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid;
  v_n     integer;
begin
  if not exists (select 1 from public.office o where o.id = p_office_id and o.is_test) then
    raise exception 'NOT_TEST_OFFICE: only offices flagged is_test can be seeded' using errcode = '42501';
  end if;
  if p_per_client is null or p_per_client not between 1 and 10 then
    raise exception 'BAD_COUNT: 1 to 10 per client' using errcode = '22023';
  end if;
  select s.id into v_actor from public.staff_user s where s.office_id = p_office_id order by s.id limit 1;
  if v_actor is null then raise exception 'NO_STAFF: the office needs one staff user' using errcode = '22023'; end if;
  insert into public.dsc (office_id, client_id, holder_name, dsc_class, expires_on, password_ct, password_set_by, created_by)
  select p_office_id, c.id, 'Seed holder ' || g.i, 'class3',
         p_today - 200 + ((row_number() over (order by c.id, g.i))::integer * 37 % 400),
         'ktest.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.c2VlZA', v_actor, v_actor
    from public.client c cross join generate_series(1, p_per_client) g(i)
   where c.office_id = p_office_id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ── 11. Execute rights ──────────────────────────────────────────────────────────────────────────────────────────────
revoke all on function public.dsc_save(jsonb) from public, anon;
revoke all on function public.dsc_reveal(uuid) from public, anon;
revoke all on function public.dsc_custody_log(jsonb) from public, anon;
revoke all on function public.dsc_archive(uuid, text) from public, anon;
revoke all on function public.dsc_unarchive(uuid) from public, anon;
revoke all on function public.dsc_set_remind_days(uuid, integer) from public, anon;
revoke all on function public.dsc_due(text) from public, anon;
grant execute on function public.dsc_save(jsonb) to authenticated;
grant execute on function public.dsc_reveal(uuid) to authenticated;
grant execute on function public.dsc_custody_log(jsonb) to authenticated;
grant execute on function public.dsc_archive(uuid, text) to authenticated;
grant execute on function public.dsc_unarchive(uuid) to authenticated;
grant execute on function public.dsc_set_remind_days(uuid, integer) to authenticated;
grant execute on function public.dsc_due(text) to authenticated;
revoke all on function public.test_seed_dsc(uuid, integer, date) from public, anon, authenticated;
grant execute on function public.test_seed_dsc(uuid, integer, date) to service_role;
revoke all on function private.dsc_ct_ok(text) from public;
revoke all on function private.dsc_text(jsonb, text, integer, text) from public;
revoke all on function private.dsc_custody_no_update() from public;
grant execute on function private.dsc_ct_ok(text) to authenticated;
grant execute on function private.dsc_text(jsonb, text, integer, text) to authenticated;
