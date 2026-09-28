-- Feature 03 — document intake (spec rev 2; plan step 2; tests: tests/rls/{documents,proposed-types,document-storage}.test.ts).
-- Additive. Schema lock: 03. Decisions D1–D6 (plan.md "Deviations", approved by Raja 2026-09-28).

-- ── Enums ────────────────────────────────────────────────────────────────
create type public.received_as as enum ('soft_copy', 'hard_copy', 'original');
create type public.doc_channel as enum ('whatsapp', 'email', 'hand_delivery', 'courier', 'portal', 'other');
create type public.document_status as enum ('received'); -- 07 adds review/dispatch values

-- ── Proposed types (AC-15, D6) ───────────────────────────────────────────
alter table public.doc_type add column proposed_for_client_id uuid references public.client (id);
alter table public.doc_type
  add constraint doc_type_proposed_for_client check ((status = 'proposed') = (proposed_for_client_id is not null)),
  add constraint doc_type_proposed_shape check (
    status = 'approved'
    or (source = 'client' and default_frequency = 'as_needed' and reminders = false and proposed_by is not null));
create index doc_type_proposed_for_idx on public.doc_type (proposed_for_client_id);
-- D6: approved names unique per group; proposed names unique per group and client (05 merges duplicates).
drop index public.doc_type_name_key;
create unique index doc_type_name_key on public.doc_type (doc_group_id, lower(name)) where status = 'approved';
create unique index doc_type_proposed_name_key on public.doc_type (doc_group_id, proposed_for_client_id, lower(name)) where status = 'proposed';

create or replace function private.doc_type_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.doc_group g where g.id = new.doc_group_id and g.office_id = new.office_id) then
    raise exception 'GROUP_OFFICE: group belongs to another office' using errcode = '23514';
  end if;
  if new.proposed_for_client_id is not null and not exists (
      select 1 from public.client c where c.id = new.proposed_for_client_id and c.office_id = new.office_id) then
    raise exception 'CLIENT_OFFICE: client belongs to another office' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and (new.source <> old.source or new.code <> old.code) then
    raise exception 'IMMUTABLE: type source and code cannot change' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;

-- ── Tables ───────────────────────────────────────────────────────────────
-- DOC-ID counter per office per FY of the date added (AC-6). DOC-ID = DOC-FY26-27-00001. Written only by the document trigger.
create table public.doc_counter (
  office_id uuid not null references public.office (id),
  fy_code   text not null check (fy_code ~ '^[0-9]{4}-[0-9]{2}$'),
  last      integer not null default 0 check (last >= 0),
  primary key (office_id, fy_code)
);

create table public.document (
  id                 uuid primary key default gen_random_uuid(),
  office_id          uuid not null references public.office (id),
  doc_code           text not null,
  fy_code            text not null check (fy_code ~ '^[0-9]{4}-[0-9]{2}$'),
  client_id          uuid references public.client (id),
  doc_type_id        uuid references public.doc_type (id),
  period_id          uuid references public.period (id),
  registration_id    uuid references public.client_registration (id),
  received_as        public.received_as not null,
  channel            public.doc_channel not null,
  received_on        date not null,
  received_by        uuid not null references public.staff_user (id),
  remark             text check (remark is null or length(remark) <= 500),
  status             public.document_status not null default 'received',
  current_version_id uuid,
  version_count      integer not null default 0 check (version_count >= 0),
  classified_at      timestamptz,
  archived_at        timestamptz,
  archived_by        uuid references public.staff_user (id),
  archive_reason     text check (archive_reason is null or length(archive_reason) between 1 and 300),
  created_by         uuid references public.staff_user (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (office_id, doc_code),
  constraint document_doc_code_format check (doc_code ~ '^DOC-FY[0-9]{2}-[0-9]{2}-[0-9]{5,}$')
);

create table public.document_version (
  id           uuid primary key default gen_random_uuid(),
  office_id    uuid not null references public.office (id),
  document_id  uuid not null references public.document (id),
  version_no   integer not null check (version_no > 0),
  storage_path text not null unique,
  file_name    text not null,
  mime_type    text not null,
  size_bytes   bigint not null check (size_bytes between 1 and 26214400),
  uploaded_by  uuid not null references public.staff_user (id),
  uploaded_at  timestamptz not null default now(),
  unique (document_id, version_no),
  -- Stored sanitised (AC-2): no path separators, control characters or leading dot; ≤ 180 chars.
  constraint document_version_file_name check (
    length(file_name) between 1 and 180 and file_name !~ '[/\\[:cntrl:]]' and left(file_name, 1) <> '.'),
  constraint document_version_mime check (mime_type in (
    'application/pdf', 'image/jpeg', 'image/png', 'image/heic',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'))
);
alter table public.document add constraint document_current_version_fk
  foreign key (current_version_id) references public.document_version (id);

-- Indexes: client documents, Inbox, type × period; every FK.
create index document_client_fy_idx on public.document (office_id, client_id, fy_code);
create index document_inbox_idx on public.document (office_id, created_at desc) where classified_at is null;
create index document_type_period_idx on public.document (doc_type_id, period_id);
create index document_client_idx on public.document (client_id);
create index document_period_idx on public.document (period_id);
create index document_registration_idx on public.document (registration_id);
create index document_received_by_idx on public.document (received_by);
create index document_created_by_idx on public.document (created_by);
create index document_archived_by_idx on public.document (archived_by);
create index document_current_version_idx on public.document (current_version_id);
create index document_version_office_idx on public.document_version (office_id);
create index document_version_uploaded_by_idx on public.document_version (uploaded_by);

-- ── Helpers ──────────────────────────────────────────────────────────────
-- FY code ("2026-27") of an instant, in India time.
create or replace function private.fy_code_of(p_at timestamptz)
returns text language sql immutable set search_path = '' as $$
  select y || '-' || lpad(((y + 1) % 100)::text, 2, '0')
    from (select extract(year from d)::integer - case when extract(month from d) < 4 then 1 else 0 end as y
            from (select (p_at at time zone 'Asia/Kolkata')::date as d) a) b
$$;

-- D2: office/<office_id>/doc/<document_id>/<version_id>.<ext> — IDs and an allowed extension only.
-- Returns the document id encoded in the path.
create or replace function private.document_id_from_path(p_path text, p_office_id uuid)
returns uuid language plpgsql immutable set search_path = '' as $$
declare m text[];
begin
  m := regexp_match(coalesce(p_path, ''),
    '^office/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/doc/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|jpeg|png|heic|xlsx|xls|csv|docx|zip)$');
  if m is null or m[1]::uuid <> p_office_id then
    raise exception 'PATH: storage path must be office/<office>/doc/<document>/<version>.<allowed extension>' using errcode = '23514';
  end if;
  return m[2]::uuid;
end $$;

-- The one MIME type each allowed extension is stored as (the server uses the same map).
create or replace function private.mime_for_extension(p_ext text)
returns text language sql immutable set search_path = '' as $$
  select case lower(p_ext)
    when 'pdf' then 'application/pdf' when 'jpg' then 'image/jpeg' when 'jpeg' then 'image/jpeg'
    when 'png' then 'image/png' when 'heic' then 'image/heic'
    when 'xlsx' then 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    when 'xls' then 'application/vnd.ms-excel' when 'csv' then 'text/csv'
    when 'docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    when 'zip' then 'application/zip' end
$$;

-- ── Triggers ─────────────────────────────────────────────────────────────
-- Document rules (AC-1, AC-6, AC-8, AC-11, AC-12). SECURITY DEFINER: increments doc_counter (no user grants)
-- and validates against rows the caller may not see. Tenant first: every referenced row must be this office's.
create or replace function private.document_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_at     timestamptz;
  v_fy     text;
  v_n      integer;
  t        public.doc_type;
  v_pkind  public.period_kind;
  v_today  date := (now() at time zone 'Asia/Kolkata')::date;
  v_dims   boolean;
begin
  if tg_op = 'UPDATE' and coalesce(current_setting('app.purge_office', true), '') = old.office_id::text then
    return new; -- reset_test_office
  end if;

  if tg_op = 'INSERT' then
    -- AC-6: FY of the date added (IST). app.doc_clock is set only by create_document, only in is_test offices (D4).
    v_at := coalesce(nullif(current_setting('app.doc_clock', true), '')::timestamptz, now());
    v_fy := private.fy_code_of(v_at);
    -- Upsert = row lock per office+FY: serialises concurrent adds; rolls back with a failed insert (no gaps).
    insert into public.doc_counter as c (office_id, fy_code, last) values (new.office_id, v_fy, 1)
      on conflict (office_id, fy_code) do update set last = c.last + 1
      returning c.last into v_n;
    new.fy_code := v_fy;
    new.doc_code := 'DOC-FY' || substr(v_fy, 3) || '-' || case when v_n > 99999 then v_n::text else lpad(v_n::text, 5, '0') end;
    new.created_by := private.current_staff_id();
    new.created_at := now();
    new.received_by := coalesce(new.received_by, private.current_staff_id());
    new.status := 'received';
    new.current_version_id := null;
    new.version_count := 0;
    new.classified_at := case when new.client_id is not null and new.doc_type_id is not null then now() end;
    new.archived_at := null; new.archived_by := null; new.archive_reason := null;
    v_dims := true;
  else
    if new.id <> old.id or new.office_id <> old.office_id or new.doc_code <> old.doc_code or new.fy_code <> old.fy_code
       or new.created_by is distinct from old.created_by or new.created_at <> old.created_at then
      raise exception 'IMMUTABLE: DOC-ID, FY, office and creator cannot change' using errcode = 'P0001';
    end if;
    if (new.current_version_id is distinct from old.current_version_id or new.version_count <> old.version_count)
       and coalesce(current_setting('app.doc_version', true), '') <> new.id::text then
      raise exception 'IMMUTABLE: the current version changes only by adding a version' using errcode = 'P0001';
    end if;
    -- AC-11: archive/unarchive is Admin/Manager only; an archived document is read-only until unarchived.
    if (new.archived_at is distinct from old.archived_at or new.archived_by is distinct from old.archived_by
        or new.archive_reason is distinct from old.archive_reason) and not private.is_privileged() then
      raise exception 'ROLE_REQUIRED: only Admin or Manager can archive or unarchive a document' using errcode = '42501';
    end if;
    if old.archived_at is not null and new.archived_at is not null
       and (new.client_id, new.doc_type_id, new.period_id, new.registration_id, new.received_as, new.channel,
            new.received_on, new.received_by, new.remark, new.current_version_id)
           is distinct from
           (old.client_id, old.doc_type_id, old.period_id, old.registration_id, old.received_as, old.channel,
            old.received_on, old.received_by, old.remark, old.current_version_id) then
      raise exception 'ARCHIVED: unarchive the document before changing it' using errcode = 'P0001';
    end if;
    if new.archived_at is null then
      new.archived_by := null; new.archive_reason := null;
    elsif old.archived_at is null then
      new.archived_by := coalesce(private.current_staff_id(), new.archived_by);
    end if;
    new.status := old.status; -- 07 owns status changes
    -- AC-8: classified_at is set the first time client + type are both present, never changed after.
    new.classified_at := coalesce(old.classified_at,
      case when new.client_id is not null and new.doc_type_id is not null then now() end);
    v_dims := (new.client_id, new.doc_type_id, new.period_id, new.registration_id)
              is distinct from (old.client_id, old.doc_type_id, old.period_id, old.registration_id);
    if new.received_on <> old.received_on and new.received_on > v_today then
      raise exception 'RECEIVED_ON_FUTURE: received on cannot be in the future' using errcode = '23514';
    end if;
    if new.received_by <> old.received_by then perform private.check_assignee(new.received_by, new.office_id); end if;
  end if;

  if tg_op = 'INSERT' then
    if new.received_on > v_today then
      raise exception 'RECEIVED_ON_FUTURE: received on cannot be in the future' using errcode = '23514';
    end if;
    perform private.check_assignee(new.received_by, new.office_id);
  end if;

  -- Dimension rules, checked when any dimension changes (a later deactivation doesn't block other edits).
  if v_dims then
    if new.client_id is not null and not exists (
        select 1 from public.client c where c.id = new.client_id and c.office_id = new.office_id) then
      raise exception 'CLIENT_OFFICE: client belongs to another office' using errcode = '23514';
    end if;
    if new.doc_type_id is not null then
      select * into t from public.doc_type where id = new.doc_type_id and office_id = new.office_id;
      if not found then raise exception 'TYPE_OFFICE: document type belongs to another office' using errcode = '23514'; end if;
      if not t.active or (t.status = 'proposed' and t.proposed_for_client_id is distinct from new.client_id) then
        raise exception 'TYPE_NOT_OFFERED: this type is not offered for this client' using errcode = '23514';
      end if;
    end if;
    if new.period_id is not null then
      select p.kind into v_pkind from public.period p where p.id = new.period_id and p.office_id = new.office_id;
      if not found then raise exception 'PERIOD_OFFICE: period belongs to another office' using errcode = '23514'; end if;
      if t.id is not null and not (
          t.period_kind in ('month', 'none')
          or (t.period_kind = 'quarter' and v_pkind in ('quarter', 'year'))
          or (t.period_kind = 'year' and v_pkind = 'year')) then
        raise exception 'PERIOD_KIND: a % document cannot be filed for a % period', t.period_kind, v_pkind using errcode = '23514';
      end if;
    end if;
    if new.registration_id is not null and (t.id is null or t.registration_kind is null or not exists (
        select 1 from public.client_registration r
         where r.id = new.registration_id and r.office_id = new.office_id and r.client_id = new.client_id
           and r.active and r.kind = t.registration_kind)) then
      raise exception 'REGISTRATION_MISMATCH: registration must be an active GSTIN/TAN of this client, as the type needs' using errcode = '23514';
    end if;
  end if;

  new.updated_at := now();
  return new;
end $$;

-- AC-1: a soft copy has a file. Deferred to commit so create_document can insert the document, then its version.
create or replace function private.document_soft_copy_check()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.document d where d.id = new.id and d.received_as = 'soft_copy' and d.version_count = 0) then
    raise exception 'SOFT_COPY_NEEDS_FILE: a soft copy needs a file' using errcode = '23514';
  end if;
  return null;
end $$;

-- Versions (AC-2, AC-11, AC-13, D1, D2). SECURITY DEFINER: reads storage.objects, which app roles cannot.
-- Size and MIME type come from Storage, never from the caller.
create or replace function private.document_version_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_meta jsonb; v_ext text; v_mime text;
begin
  perform 1 from public.document d where d.id = new.document_id and d.office_id = new.office_id for update;
  if not found then raise exception 'DOCUMENT_OFFICE: document belongs to another office' using errcode = '23514'; end if;
  if private.document_id_from_path(new.storage_path, new.office_id) <> new.document_id then
    raise exception 'PATH: the file must be stored under its own document' using errcode = '23514';
  end if;
  select o.metadata into v_meta from storage.objects o where o.bucket_id = 'documents' and o.name = new.storage_path;
  if not found then raise exception 'OBJECT_MISSING: the uploaded file was not found in storage' using errcode = '23514'; end if;
  v_ext := lower(substring(new.storage_path from '\.([a-z]+)$'));
  v_mime := private.mime_for_extension(v_ext);
  if v_meta->>'mimetype' is distinct from v_mime then
    raise exception 'FILE_TYPE: stored file type does not match its extension' using errcode = '23514';
  end if;
  new.mime_type := v_mime;
  new.size_bytes := (v_meta->>'size')::bigint;
  new.version_no := coalesce((select max(v.version_no) from public.document_version v where v.document_id = new.document_id), 0) + 1;
  new.uploaded_by := coalesce(private.current_staff_id(), new.uploaded_by);
  new.uploaded_at := now();
  return new;
end $$;

-- The new version becomes current (same DOC-ID).
create or replace function private.document_version_after_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('app.doc_version', new.document_id::text, true);
  update public.document set current_version_id = new.id, version_count = new.version_no where id = new.document_id;
  perform set_config('app.doc_version', '', true);
  return null;
end $$;

create or replace function private.document_version_no_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'IMMUTABLE: document versions are append-only' using errcode = 'P0001';
end $$;

create trigger document_before_write before insert or update on public.document
  for each row execute function private.document_before_write();
create constraint trigger document_soft_copy_check after insert or update of received_as, version_count on public.document
  deferrable initially deferred for each row execute function private.document_soft_copy_check();
create trigger document_version_before_insert before insert on public.document_version
  for each row execute function private.document_version_before_insert();
create trigger document_version_after_insert after insert on public.document_version
  for each row execute function private.document_version_after_insert();
create trigger document_version_no_update before update on public.document_version
  for each row execute function private.document_version_no_update();
create trigger document_no_delete before delete on public.document
  for each row execute function private.forbid_delete_unless_purge();
create trigger document_version_no_delete before delete on public.document_version
  for each row execute function private.forbid_delete_unless_purge();
create trigger doc_counter_no_delete before delete on public.doc_counter
  for each row execute function private.forbid_delete_unless_purge();

-- ── Functions (SECURITY INVOKER: RLS and column grants apply) ────────────
-- AC-1/4: document (+ version 1 when a file is given) + activity, atomic. Returns { id, doc_code }.
create or replace function public.create_document(p jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_office uuid := private.current_office_id();
  v_staff  uuid := private.current_staff_id();
  v_file   jsonb := case when jsonb_typeof(p->'file') = 'object' then p->'file' end;
  v_as     public.received_as := coalesce(nullif(p->>'received_as', ''), 'soft_copy')::public.received_as;
  v_doc    uuid;
  v_code   text;
  v_test   boolean;
begin
  if v_staff is null then raise exception 'ROLE_REQUIRED: sign in as active staff' using errcode = '42501'; end if;
  if nullif(p->>'test_added_at', '') is not null then
    select o.is_test into v_test from public.office o where o.id = v_office;
    if not coalesce(v_test, false) then
      raise exception 'TEST_ONLY: test_added_at is accepted only in test offices' using errcode = '42501';
    end if;
    perform set_config('app.doc_clock', (p->>'test_added_at')::timestamptz::text, true);
  end if;
  if v_file is null then
    if v_as = 'soft_copy' then raise exception 'SOFT_COPY_NEEDS_FILE: a soft copy needs a file' using errcode = '23514'; end if;
    v_doc := gen_random_uuid();
  else
    v_doc := private.document_id_from_path(v_file->>'storage_path', v_office);
  end if;

  insert into public.document (id, office_id, client_id, doc_type_id, period_id, registration_id,
      received_as, channel, received_on, received_by, remark)
    values (v_doc, v_office, nullif(p->>'client_id', '')::uuid, nullif(p->>'doc_type_id', '')::uuid,
            nullif(p->>'period_id', '')::uuid, nullif(p->>'registration_id', '')::uuid,
            v_as, (p->>'channel')::public.doc_channel,
            coalesce(nullif(p->>'received_on', '')::date, (now() at time zone 'Asia/Kolkata')::date),
            coalesce(nullif(p->>'received_by', '')::uuid, v_staff), nullif(btrim(p->>'remark'), ''))
    returning doc_code into v_code;
  perform set_config('app.doc_clock', '', true);

  if v_file is not null then
    insert into public.document_version (office_id, document_id, storage_path, file_name)
      values (v_office, v_doc, v_file->>'storage_path', v_file->>'file_name');
  end if;

  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, v_staff, 'document.added', 'document', v_doc::text, jsonb_strip_nulls(jsonb_build_object(
      'client_id', p->>'client_id', 'doc_type_id', p->>'doc_type_id', 'period_id', p->>'period_id',
      'received_as', v_as, 'channel', p->>'channel', 'has_file', v_file is not null)));
  return jsonb_build_object('id', v_doc, 'doc_code', v_code);
end $$;

-- AC-8/11 (D3): classify and edit. Only the keys present change. One activity row with field names only.
create or replace function public.update_document(p_id uuid, p jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  d public.document;
  n public.document;
  v_fields text[] := '{}';
  k text;
begin
  select * into d from public.document where id = p_id;
  if not found then raise exception 'NOT_FOUND: document' using errcode = 'P0002'; end if;
  if d.archived_at is not null then raise exception 'ARCHIVED: unarchive the document before changing it' using errcode = 'P0001'; end if;
  n := d;
  if p ? 'client_id'       then n.client_id       := nullif(p->>'client_id', '')::uuid; end if;
  if p ? 'doc_type_id'     then n.doc_type_id     := nullif(p->>'doc_type_id', '')::uuid; end if;
  if p ? 'period_id'       then n.period_id       := nullif(p->>'period_id', '')::uuid; end if;
  if p ? 'registration_id' then n.registration_id := nullif(p->>'registration_id', '')::uuid; end if;
  if p ? 'received_as'     then n.received_as     := (p->>'received_as')::public.received_as; end if;
  if p ? 'channel'         then n.channel         := (p->>'channel')::public.doc_channel; end if;
  if p ? 'received_on'     then n.received_on     := (p->>'received_on')::date; end if;
  if p ? 'received_by'     then n.received_by     := (p->>'received_by')::uuid; end if;
  if p ? 'remark'          then n.remark          := nullif(btrim(p->>'remark'), ''); end if;
  if n.received_as = 'soft_copy' and d.version_count = 0 then
    raise exception 'SOFT_COPY_NEEDS_FILE: a soft copy needs a file' using errcode = '23514';
  end if;
  foreach k in array array['client_id', 'doc_type_id', 'period_id', 'registration_id', 'received_as',
                           'channel', 'received_on', 'received_by', 'remark'] loop
    if (to_jsonb(n)->k) is distinct from (to_jsonb(d)->k) then v_fields := v_fields || k; end if;
  end loop;
  if cardinality(v_fields) = 0 then return; end if;

  update public.document set client_id = n.client_id, doc_type_id = n.doc_type_id, period_id = n.period_id,
      registration_id = n.registration_id, received_as = n.received_as, channel = n.channel,
      received_on = n.received_on, received_by = n.received_by, remark = n.remark
    where id = p_id;

  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (d.office_id, private.current_staff_id(),
            case when v_fields && array['client_id', 'doc_type_id'] then 'document.classified' else 'document.updated' end,
            'document', p_id::text,
            jsonb_strip_nulls(jsonb_build_object('fields', to_jsonb(v_fields), 'client_id', n.client_id, 'doc_type_id', n.doc_type_id)));
end $$;

-- AC-11: a new file becomes the current version (same DOC-ID). Returns { version_id, version_no }.
create or replace function public.add_document_version(p_document_id uuid, p_file jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare d public.document; v_id uuid; v_no integer;
begin
  select * into d from public.document where id = p_document_id;
  if not found then raise exception 'NOT_FOUND: document' using errcode = 'P0002'; end if;
  if d.archived_at is not null then raise exception 'ARCHIVED: unarchive the document before changing it' using errcode = 'P0001'; end if;
  insert into public.document_version (office_id, document_id, storage_path, file_name)
    values (d.office_id, d.id, p_file->>'storage_path', p_file->>'file_name')
    returning id, version_no into v_id, v_no;
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (d.office_id, private.current_staff_id(), 'document.version_added', 'document', d.id::text,
            jsonb_build_object('version_id', v_id, 'version_no', v_no));
  return jsonb_build_object('version_id', v_id, 'version_no', v_no);
end $$;

-- AC-11: Admin/Manager archive with a reason (kept on the document, not in activity) and unarchive.
create or replace function public.archive_document(p_id uuid, p_reason text)
returns void language plpgsql security invoker set search_path = '' as $$
declare d public.document;
begin
  if not private.has_role(array['admin', 'manager']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: only Admin or Manager can archive a document' using errcode = '42501';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'REASON_REQUIRED: give a reason for archiving' using errcode = '23514';
  end if;
  select * into d from public.document where id = p_id;
  if not found then raise exception 'NOT_FOUND: document' using errcode = 'P0002'; end if;
  if d.archived_at is not null then return; end if;
  update public.document set archived_at = now(), archive_reason = btrim(p_reason) where id = p_id;
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (d.office_id, private.current_staff_id(), 'document.archived', 'document', p_id::text, '{}');
end $$;

create or replace function public.unarchive_document(p_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare d public.document;
begin
  if not private.has_role(array['admin', 'manager']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: only Admin or Manager can unarchive a document' using errcode = '42501';
  end if;
  select * into d from public.document where id = p_id;
  if not found then raise exception 'NOT_FOUND: document' using errcode = 'P0002'; end if;
  if d.archived_at is null then return; end if;
  update public.document set archived_at = null where id = p_id;
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (d.office_id, private.current_staff_id(), 'document.unarchived', 'document', p_id::text, '{}');
end $$;

-- AC-15 (D5, D6): Staff+ create a proposed type for one client; it joins that client's plan at once.
-- If the group isn't enabled, a client group row is created holding only this type.
create or replace function public.create_proposed_type(p_client_id uuid, p_doc_group_id uuid, p_name text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_office   uuid := private.current_office_id();
  v_staff    uuid := private.current_staff_id();
  v_name     text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_incharge uuid;
  v_type     uuid;
  v_group    uuid;
  v_state    public.plan_state;
  v_plan     uuid;
begin
  if not private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: Limited users cannot change collection plans' using errcode = '42501';
  end if;
  if length(v_name) not between 1 and 120 then
    raise exception 'NAME_INVALID: a type name has 1–120 characters' using errcode = '23514';
  end if;
  select c.incharge_id into v_incharge from public.client c
    where c.id = p_client_id and c.office_id = v_office and c.archived_at is null;
  if not found then raise exception 'NOT_FOUND: client' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.doc_group g where g.id = p_doc_group_id and g.office_id = v_office and g.active) then
    raise exception 'NOT_FOUND: group' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.doc_type t
              where t.doc_group_id = p_doc_group_id and lower(t.name) = lower(v_name)
                and (t.status = 'approved' or t.proposed_for_client_id = p_client_id)) then
    raise exception 'DUPLICATE_TYPE: a type with this name already exists in this group' using errcode = '23505';
  end if;

  perform set_config('app.propose_type', 'on', true);
  insert into public.doc_type (office_id, doc_group_id, code, name, period_kind, default_frequency, source,
      reminders, status, proposed_by, proposed_for_client_id)
    values (v_office, p_doc_group_id, 'p_' || replace(gen_random_uuid()::text, '-', ''), v_name, 'none', 'as_needed',
            'client', false, 'proposed', v_staff, p_client_id)
    returning id into v_type;
  perform set_config('app.propose_type', '', true);

  select g.id, g.state into v_group, v_state from public.client_group g
    where g.client_id = p_client_id and g.doc_group_id = p_doc_group_id;
  if not found then
    insert into public.client_group (office_id, client_id, doc_group_id, assigned_staff_id, state)
      values (v_office, p_client_id, p_doc_group_id, v_incharge, 'active') returning id into v_group;
  elsif v_state = 'removed' then
    -- Switched off earlier: back on holding only this type; the other types keep their remembered states.
    update public.client_group set state = 'active' where id = v_group;
  end if;
  insert into public.client_doc_type (office_id, client_id, doc_type_id, client_group_id, frequency, reminders, state)
    values (v_office, p_client_id, v_type, v_group, 'as_needed', false, 'active') returning id into v_plan;

  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, v_staff, 'doc_type.proposed', 'doc_type', v_type::text,
            jsonb_build_object('client_id', p_client_id, 'doc_group_id', p_doc_group_id, 'client_group_id', v_group));
  return jsonb_build_object('doc_type_id', v_type, 'client_doc_type_id', v_plan, 'client_group_id', v_group);
end $$;

-- AC-15: closest types first — name and aliases, trigram word similarity (typo-tolerant). Approved active
-- types plus this client's own proposed types. ≤ 10 rows, best first; name matches beat alias matches.
create or replace function public.suggest_doc_types(p_client_id uuid, p_query text)
returns table (doc_type_id uuid, name text, group_name text, status public.doc_type_status, in_plan boolean, score real)
language sql stable security invoker set search_path = '' as $$
  with q as (select lower(btrim(coalesce(p_query, ''))) as q),
  scored as (
    select t.id, t.name, g.name as group_name, t.status,
           extensions.word_similarity(q.q, lower(t.name)) as name_score,
           coalesce((select max(extensions.word_similarity(q.q, lower(a))) from unnest(t.aliases) a), 0) as alias_score
      from public.doc_type t
      join public.doc_group g on g.id = t.doc_group_id and g.active
      cross join q
     where t.office_id = (select private.current_office_id())
       and t.active
       and (t.status = 'approved' or t.proposed_for_client_id = p_client_id)
       and length(q.q) >= 2
  )
  select s.id, s.name, s.group_name, s.status,
         exists (select 1 from public.client_doc_type c
                  where c.client_id = p_client_id and c.doc_type_id = s.id and c.state = 'active') as in_plan,
         greatest(s.name_score, s.alias_score) as score
    from scored s
   where greatest(s.name_score, s.alias_score) >= 0.3
   order by greatest(s.name_score, s.alias_score) desc, s.name_score desc, s.name
   limit 10
$$;

-- ── Test office reset (plan D2, extended for documents) ──────────────────
-- Storage objects are removed by the test helper through the Storage API first (the DB can't delete them).
create or replace function public.reset_test_office(p_office_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.office where id = p_office_id and is_test) then
    raise exception 'NOT_TEST_OFFICE: only offices flagged is_test can be reset' using errcode = '42501';
  end if;
  perform set_config('app.purge_office', p_office_id::text, true);
  update public.document set current_version_id = null where office_id = p_office_id and current_version_id is not null;
  delete from public.document_version    where office_id = p_office_id;
  delete from public.document            where office_id = p_office_id;
  delete from public.doc_counter         where office_id = p_office_id;
  delete from public.client_doc_type     where office_id = p_office_id;
  delete from public.client_group        where office_id = p_office_id;
  delete from public.doc_type            where office_id = p_office_id and status = 'proposed'; -- → client FK
  delete from public.client_registration where office_id = p_office_id;
  delete from public.client_contact      where office_id = p_office_id;
  delete from public.client              where office_id = p_office_id;
  delete from public.period              where office_id = p_office_id;
  delete from public.financial_year      where office_id = p_office_id;
  delete from public.doc_type            where office_id = p_office_id;
  delete from public.doc_group           where office_id = p_office_id;
  perform set_config('app.purge_office', '', true);
  update public.office set client_code_counter = 0 where id = p_office_id;
  perform private.seed_catalogue(p_office_id);
end $$;
revoke all on function public.reset_test_office(uuid) from public, anon, authenticated;
grant execute on function public.reset_test_office(uuid) to service_role;

-- ── Grants ───────────────────────────────────────────────────────────────
revoke all on public.doc_counter, public.document, public.document_version from anon, authenticated;
grant select on public.document, public.document_version to authenticated;
-- doc_code, fy_code, classified_at, current_version_id, version_count, created_*: set by triggers only.
grant insert (id, office_id, client_id, doc_type_id, period_id, registration_id, received_as, channel,
  received_on, received_by, remark) on public.document to authenticated;
grant update (client_id, doc_type_id, period_id, registration_id, received_as, channel, received_on, received_by,
  remark, archived_at, archive_reason) on public.document to authenticated;
grant insert (office_id, document_id, storage_path, file_name) on public.document_version to authenticated;
-- create_proposed_type (invoker) writes these; the insert policy below admits only its own proposed rows.
grant insert (status, proposed_by, proposed_for_client_id) on public.doc_type to authenticated;

revoke all on function private.fy_code_of(timestamptz), private.document_id_from_path(text, uuid),
  private.mime_for_extension(text), private.document_before_write(), private.document_soft_copy_check(),
  private.document_version_before_insert(), private.document_version_after_insert(),
  private.document_version_no_update() from public, anon, authenticated;
grant execute on function private.document_id_from_path(text, uuid) to authenticated;
revoke all on function public.create_document(jsonb), public.update_document(uuid, jsonb),
  public.add_document_version(uuid, jsonb), public.archive_document(uuid, text), public.unarchive_document(uuid),
  public.create_proposed_type(uuid, uuid, text), public.suggest_doc_types(uuid, text) from public, anon;
grant execute on function public.create_document(jsonb), public.update_document(uuid, jsonb),
  public.add_document_version(uuid, jsonb), public.archive_document(uuid, text), public.unarchive_document(uuid),
  public.create_proposed_type(uuid, uuid, text), public.suggest_doc_types(uuid, text) to authenticated;

-- ── Row-level security (default deny) ────────────────────────────────────
alter table public.doc_counter      enable row level security; -- no policies: nobody but triggers
alter table public.document         enable row level security;
alter table public.document_version enable row level security;

-- AC-12: visible if the user can see its client; or it's unclassified and the user is Staff+ or added it.
create policy document_select on public.document for select to authenticated
  using (office_id = (select private.current_office_id())
         and ((select private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]))
              or (client_id is not null and private.can_see_client(client_id))
              or ((client_id is null or doc_type_id is null) and created_by = (select private.current_staff_id()))));
-- Limited add/edit only for clients they can see, or without a client (Inbox).
create policy document_insert on public.document for insert to authenticated
  with check (office_id = (select private.current_office_id())
              and ((select private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]))
                   or client_id is null or private.can_see_client(client_id)));
create policy document_update on public.document for update to authenticated
  using (office_id = (select private.current_office_id())
         and ((select private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]))
              or (client_id is not null and private.can_see_client(client_id))
              or ((client_id is null or doc_type_id is null) and created_by = (select private.current_staff_id()))))
  with check (office_id = (select private.current_office_id())
              and ((select private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]))
                   or client_id is null or private.can_see_client(client_id)));

-- Versions follow their document's visibility (the subquery runs under document RLS).
create policy document_version_select on public.document_version for select to authenticated
  using (office_id = (select private.current_office_id())
         and exists (select 1 from public.document d where d.id = document_id));
create policy document_version_insert on public.document_version for insert to authenticated
  with check (office_id = (select private.current_office_id())
              and exists (select 1 from public.document d where d.id = document_id));

-- Proposed types: Staff+ only through create_proposed_type (flag set inside it; nothing else sets it).
create policy doc_type_insert_proposed on public.doc_type for insert to authenticated
  with check (office_id = (select private.current_office_id())
              and status = 'proposed'
              and (select private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]))
              and coalesce(current_setting('app.propose_type', true), '') = 'on');

-- ── Storage (AC-2, AC-13) ────────────────────────────────────────────────
-- Private bucket; no storage.objects policies for anon/authenticated — all access via server-issued signed URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 26214400, array[
  'application/pdf', 'image/jpeg', 'image/png', 'image/heic',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
