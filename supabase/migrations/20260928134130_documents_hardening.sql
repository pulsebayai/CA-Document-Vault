-- Feature 03 — pre-PR review hardening (sdlc-reviewer 2026-09-28; tests: "review hardening" in
-- tests/rls/documents.test.ts, proposed-types.test.ts). Replaces three trigger functions and one policy; adds
-- two checks. No data change.
--
-- 1. Tenant boundary first in the SECURITY DEFINER triggers (as 02's client_before_write): refuse a row for another
--    office before touching that office's counter, locking its rows or reading its storage objects.
-- 2. Documents and versions change only through the vault's functions (app.doc_write, set inside them), so every
--    change writes its activity row (AC-17); direct PostgREST writes are refused.
-- 3. A filed document can't lose its client or type (it would vanish from the Inbox and the client's list).
-- 4. No filing to an archived client. Archiving always has a reason (AC-11).
-- 5. File names: no bidirectional/format control characters (display spoofing, e.g. U+202E).
-- 6. Proposed types only through create_proposed_type, proposer = the caller — for Admin/Manager too.

-- ── 2: the functions set app.doc_write for their own transaction ──────────
create or replace function private.begin_doc_write()
returns void language plpgsql volatile set search_path = '' as $$
begin
  perform set_config('app.doc_write', 'on', true);
end $$;
revoke all on function private.begin_doc_write() from public, anon;
grant execute on function private.begin_doc_write() to authenticated;

-- ── 1–4: document ──────────────────────────────────────────────────────────
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
  v_user   boolean := (select auth.uid()) is not null;
begin
  if tg_op = 'UPDATE' and coalesce(current_setting('app.purge_office', true), '') = old.office_id::text then
    return new; -- reset_test_office
  end if;
  -- 1. Tenant boundary first.
  if v_user and new.office_id is distinct from private.current_office_id() then
    raise exception 'OFFICE_DENIED: new row violates row-level security for this office' using errcode = '42501';
  end if;
  -- 2. Only the vault's functions write documents (the version trigger updates the current version).
  if v_user and coalesce(current_setting('app.doc_write', true), '') <> 'on'
     and not (tg_op = 'UPDATE' and coalesce(current_setting('app.doc_version', true), '') = new.id::text) then
    raise exception 'permission denied: documents change only through the vault''s functions' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    v_at := coalesce(nullif(current_setting('app.doc_clock', true), '')::timestamptz, now());
    v_fy := private.fy_code_of(v_at);
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
    -- 3. Once filed, always filed (client and type may change, not be removed).
    if old.classified_at is not null and (new.client_id is null or new.doc_type_id is null) then
      raise exception 'DECLASSIFY: a filed document keeps a client and a type' using errcode = '23514';
    end if;
    if new.archived_at is null then
      new.archived_by := null; new.archive_reason := null;
    elsif old.archived_at is null then
      new.archived_by := coalesce(private.current_staff_id(), new.archived_by);
    end if;
    new.status := old.status;
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

  if v_dims then
    if new.client_id is not null and not exists (
        select 1 from public.client c where c.id = new.client_id and c.office_id = new.office_id) then
      raise exception 'CLIENT_OFFICE: client belongs to another office' using errcode = '23514';
    end if;
    -- 4. Filing to (or moving onto) an archived client is refused.
    if new.client_id is not null and (tg_op = 'INSERT' or new.client_id is distinct from old.client_id)
       and exists (select 1 from public.client c where c.id = new.client_id and c.archived_at is not null) then
      raise exception 'CLIENT_ARCHIVED: this client is archived' using errcode = '23514';
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

alter table public.document
  add constraint document_archive_has_reason check (archived_at is null or archive_reason is not null);

-- ── 1–2, 5: document_version ─────────────────────────────────────────────
create or replace function private.document_version_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_meta jsonb; v_ext text; v_mime text; v_user boolean := (select auth.uid()) is not null;
begin
  if v_user and new.office_id is distinct from private.current_office_id() then
    raise exception 'OFFICE_DENIED: new row violates row-level security for this office' using errcode = '42501';
  end if;
  if v_user and coalesce(current_setting('app.doc_write', true), '') <> 'on' then
    raise exception 'permission denied: files are added only through the vault''s functions' using errcode = '42501';
  end if;
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

-- 5. U+200B–U+200F, U+202A–U+202E, U+2060–U+2069, U+FEFF (mirrors \p{Cf} stripping in src/lib/validation/document.ts).
alter table public.document_version add constraint document_version_file_name_format check (
  file_name !~ ('[' || chr(8203) || '-' || chr(8207) || chr(8234) || '-' || chr(8238) || chr(8288) || '-' || chr(8297) || chr(65279) || ']'));

-- The five public functions, unchanged except for one line: perform private.begin_doc_write();
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
  perform private.begin_doc_write(); -- review hardening: only functions write documents
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

create or replace function public.update_document(p_id uuid, p jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  d public.document;
  n public.document;
  v_fields text[] := '{}';
  k text;
begin
  perform private.begin_doc_write(); -- review hardening: only functions write documents
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

create or replace function public.add_document_version(p_document_id uuid, p_file jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare d public.document; v_id uuid; v_no integer;
begin
  perform private.begin_doc_write(); -- review hardening: only functions write documents
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

create or replace function public.archive_document(p_id uuid, p_reason text)
returns void language plpgsql security invoker set search_path = '' as $$
declare d public.document;
begin
  perform private.begin_doc_write(); -- review hardening: only functions write documents
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
  perform private.begin_doc_write(); -- review hardening: only functions write documents
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

-- ── 1, 6: doc_type ─────────────────────────────────────────────────────────
create or replace function private.doc_type_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and new.office_id is distinct from private.current_office_id() then
    raise exception 'OFFICE_DENIED: new row violates row-level security for this office' using errcode = '42501';
  end if;
  if not exists (select 1 from public.doc_group g where g.id = new.doc_group_id and g.office_id = new.office_id) then
    raise exception 'GROUP_OFFICE: group belongs to another office' using errcode = '23514';
  end if;
  if new.proposed_for_client_id is not null and not exists (
      select 1 from public.client c where c.id = new.proposed_for_client_id and c.office_id = new.office_id) then
    raise exception 'CLIENT_OFFICE: client belongs to another office' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and new.status = 'proposed' and (select auth.uid()) is not null then
    new.proposed_by := private.current_staff_id(); -- the proposer is always the caller
  end if;
  if tg_op = 'UPDATE' and (new.source <> old.source or new.code <> old.code) then
    raise exception 'IMMUTABLE: type source and code cannot change' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;

-- Approved types: Admin/Manager. Proposed types: Staff+ and only inside create_proposed_type — for everyone.
alter policy doc_type_insert on public.doc_type
  with check (office_id = (select private.current_office_id())
              and ((status = 'approved' and (select private.has_role(array['admin', 'manager']::public.staff_role[])))
                   or (status = 'proposed'
                       and (select private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]))
                       and coalesce((select current_setting('app.propose_type', true)), '') = 'on')));
