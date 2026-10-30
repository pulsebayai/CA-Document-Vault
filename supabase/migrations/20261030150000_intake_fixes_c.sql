-- 12-intake-review-fixes · migration C (decision D1, 30 Oct: "Handed over by" is one text field; spec AC-14 amended).
-- Drops document.handed_over_kind (added by migration A, applied on dev only) and its checks. The three functions
-- are copied from migration A (20261030100000) and only the handed-over lines change.

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
  v_merge  boolean := false; -- 05
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

  -- 12 (spec AC-8, AC-10, AC-14; plan R2): received as = the paper form; Returnable = it goes back to the client.
  -- 'original' is legacy input only: stored as a hard copy + returnable (a check constraint refuses it as a value).
  if new.received_as = 'original' then new.received_as := 'hard_copy'; new.returnable := true; end if;
  if new.returnable and new.received_as <> 'hard_copy' then
    raise exception 'RETURNABLE_HARD_COPY: only a hard copy can be returnable' using errcode = '23514';
  end if;
  -- Handed over by (12 C, decision D1: one text field): the shape only (the app requires it on new hard copies, R2).
  -- 1-120 characters, never on a soft copy, and once set it can be changed but not cleared while it stays a hard copy.
  new.handed_over_name := nullif(btrim(new.handed_over_name), '');
  if length(new.handed_over_name) > 120 then
    raise exception 'HANDED_OVER_NAME: say who handed it over (up to 120 characters)' using errcode = '23514';
  end if;
  if new.handed_over_name is not null and new.received_as <> 'hard_copy' then
    raise exception 'HANDED_OVER_SOFT_COPY: only a hard copy records who handed it over' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and old.handed_over_name is not null and new.handed_over_name is null and new.received_as = 'hard_copy' then
    raise exception 'HANDED_OVER_CLEAR: who handed it over can be changed but not cleared' using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    -- D (review N-1): a proposed type's row lock is taken before the office's DOC-ID counter row, so filing under a
    -- type that is being merged waits alone instead of holding the counter (and every other filing) behind it.
    if new.doc_type_id is not null then
      perform 1 from public.doc_type where id = new.doc_type_id and office_id = new.office_id and status = 'proposed' for share;
    end if;
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
    new.reviewed_by := null; new.reviewed_at := null; new.correction_reason := null; -- 07
    new.correction_kind := null; -- 12
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
    -- 05: a catalogue merge (merge_proposed_type / approve_proposed_type set app.type_merge = the proposed type's id)
    -- changes doc_type_id alone. It moves archived documents too and keeps review state (spec AC-5, AC-6).
    v_merge := coalesce(coalesce(current_setting('app.type_merge', true), '') = old.doc_type_id::text, false)
               and new.doc_type_id is distinct from old.doc_type_id
               and (new.client_id, new.period_id, new.registration_id, new.received_as, new.channel, new.received_on,
                    new.received_by, new.remark, new.current_version_id, new.archived_at, new.archived_by, new.archive_reason)
                   is not distinct from
                   (old.client_id, old.period_id, old.registration_id, old.received_as, old.channel, old.received_on,
                    old.received_by, old.remark, old.current_version_id, old.archived_at, old.archived_by, old.archive_reason);
    if old.archived_at is not null and new.archived_at is not null and not v_merge -- 05
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
    -- 07 (status gate): status and the review columns change only inside review_document / undo_review,
    -- which set app.doc_review to this document's id. Anything else keeps them.
    if coalesce(current_setting('app.doc_review', true), '') <> new.id::text then
      new.status := old.status;
      new.reviewed_by := old.reviewed_by; new.reviewed_at := old.reviewed_at; new.correction_reason := old.correction_reason;
      new.correction_kind := old.correction_kind; -- 12
    end if;
    new.classified_at := coalesce(old.classified_at,
      case when new.client_id is not null and new.doc_type_id is not null then now() end);
    v_dims := (new.client_id, new.doc_type_id, new.period_id, new.registration_id)
              is distinct from (old.client_id, old.doc_type_id, old.period_id, old.registration_id);
    -- 07 (AC-4): a new version, or a change of what the document is (client, type, period, registration), sends a
    -- reviewed or Needs-correction document back to To review, with a 'reset' row in its history.
    if old.status <> 'received' and new.status = old.status and not v_merge -- 05
       and (v_dims or new.current_version_id is distinct from old.current_version_id
            -- 12 (spec AC-23, plan R1): a "wrong details" correction is also fixed by changing how or when it was
            -- received or who handed it over. Remark, channel and received-by never reset a Needs-correction document.
            or (old.status = 'needs_correction' and old.correction_kind = 'details'
                and (new.received_as, new.returnable, new.received_on, new.handed_over_name)
                    is distinct from (old.received_as, old.returnable, old.received_on, old.handed_over_name))) then
      new.status := 'received';
      new.reviewed_by := null; new.reviewed_at := null; new.correction_reason := null;
      new.correction_kind := null; -- 12
      insert into public.document_review (office_id, document_id, outcome, actor_id)
        values (new.office_id, new.id, 'reset', private.current_staff_id());
    end if;
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
      -- 05 (AC-11): filing under a proposed type waits for a decision in progress and re-reads the row, so a document
      -- either lands before a merge (and moves with it) or sees the retired type and is refused.
      if t.status = 'proposed' then
        select * into t from public.doc_type where id = new.doc_type_id and office_id = new.office_id for share;
      end if;
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

  -- 11 (spec AC-14, S2): the format check, a snapshot taken at filing. Re-evaluated only when the current file or
  -- the document's client or type changes (a new document gets it when its first version lands, under
  -- app.doc_version); kept as it is on everything else, including 05's merge. Written only here, on every path
  -- (staff, Upload for a requested item, 10's link path), so no caller can set it.
  if tg_op = 'INSERT' then
    new.format_preferred := null; new.format_ok := null;
  elsif v_merge or ((new.client_id, new.doc_type_id) is not distinct from (old.client_id, old.doc_type_id)
                    and new.current_version_id is not distinct from old.current_version_id) then
    new.format_preferred := old.format_preferred; new.format_ok := old.format_ok;
  else
    select f.preferred, f.ok into new.format_preferred, new.format_ok
      from private.format_check(new.office_id, new.client_id, new.doc_type_id, new.current_version_id) f;
  end if;

  new.updated_at := now();
  return new;
end $$;


create or replace function public.create_document(p jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_office uuid := private.current_office_id();
  v_staff  uuid := private.current_staff_id();
  v_file   jsonb := case when jsonb_typeof(p->'file') = 'object' then p->'file' end;
  v_as     public.received_as := coalesce(nullif(p->>'received_as', ''), 'soft_copy')::public.received_as;
  -- 12 (legacy input rule): without `returnable`, received_as keeps its old meaning ('original' = returnable).
  v_ret    boolean := case when p ? 'returnable' then coalesce((p->>'returnable')::boolean, false)
                           else coalesce(p->>'received_as', '') = 'original' end;
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
      received_as, channel, received_on, received_by, remark,
      returnable, handed_over_name) -- 12
    values (v_doc, v_office, nullif(p->>'client_id', '')::uuid, nullif(p->>'doc_type_id', '')::uuid,
            nullif(p->>'period_id', '')::uuid, nullif(p->>'registration_id', '')::uuid,
            v_as, (p->>'channel')::public.doc_channel,
            coalesce(nullif(p->>'received_on', '')::date, (now() at time zone 'Asia/Kolkata')::date),
            coalesce(nullif(p->>'received_by', '')::uuid, v_staff), nullif(btrim(p->>'remark'), ''),
            v_ret, nullif(btrim(p->>'handed_over_name'), '')) -- 12
    returning doc_code into v_code;
  perform set_config('app.doc_clock', '', true);

  if v_file is not null then
    insert into public.document_version (office_id, document_id, storage_path, file_name)
      values (v_office, v_doc, v_file->>'storage_path', v_file->>'file_name');
  end if;

  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, v_staff, 'document.added', 'document', v_doc::text, jsonb_strip_nulls(jsonb_build_object(
      'client_id', p->>'client_id', 'doc_type_id', p->>'doc_type_id', 'period_id', p->>'period_id',
      'received_as', case when v_as = 'original' then 'hard_copy'::public.received_as else v_as end, -- 12
      'returnable', case when v_ret or v_as = 'original' then true end, -- 12 (never the handed-over name)
      'channel', p->>'channel', 'has_file', v_file is not null)));
  return jsonb_build_object('id', v_doc, 'doc_code', v_code);
end $$;


create or replace function public.update_document(p_id uuid, p jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  d public.document;
  n public.document;
  v_fields text[] := '{}';
  k text;
  v_reset boolean; -- 07
begin
  perform private.begin_doc_write(); -- review hardening: only functions write documents
  select * into d from public.document where id = p_id for update; -- D: lock, so the reset flag reads the current status
  if not found then raise exception 'NOT_FOUND: document' using errcode = 'P0002'; end if;
  if d.archived_at is not null then raise exception 'ARCHIVED: unarchive the document before changing it' using errcode = 'P0001'; end if;
  n := d;
  if p ? 'client_id'       then n.client_id       := nullif(p->>'client_id', '')::uuid; end if;
  if p ? 'doc_type_id'     then n.doc_type_id     := nullif(p->>'doc_type_id', '')::uuid; end if;
  if p ? 'period_id'       then n.period_id       := nullif(p->>'period_id', '')::uuid; end if;
  if p ? 'registration_id' then n.registration_id := nullif(p->>'registration_id', '')::uuid; end if;
  if p ? 'received_as'     then n.received_as     := (p->>'received_as')::public.received_as;
    -- 12 (legacy input rule): without `returnable`, received_as keeps its old meaning ('original' = returnable).
    if not p ? 'returnable' then n.returnable := (p->>'received_as') = 'original'; end if;
  end if;
  if p ? 'returnable'       then n.returnable       := coalesce((p->>'returnable')::boolean, false); end if; -- 12
  if p ? 'handed_over_name' then n.handed_over_name := nullif(btrim(p->>'handed_over_name'), ''); end if; -- 12
  if n.received_as = 'original' then n.received_as := 'hard_copy'; n.returnable := true; end if; -- 12 (legacy input)
  -- 12: a hard copy that becomes a soft copy drops who handed it over, unless the caller sent it (the trigger refuses).
  if n.received_as = 'soft_copy' and d.received_as <> 'soft_copy' and not p ? 'handed_over_name' then
    n.handed_over_name := null;
  end if;
  if p ? 'channel'         then n.channel         := (p->>'channel')::public.doc_channel; end if;
  if p ? 'received_on'     then n.received_on     := (p->>'received_on')::date; end if;
  if p ? 'received_by'     then n.received_by     := (p->>'received_by')::uuid; end if;
  if p ? 'remark'          then n.remark          := nullif(btrim(p->>'remark'), ''); end if;
  if n.received_as = 'soft_copy' and d.version_count = 0 then
    raise exception 'SOFT_COPY_NEEDS_FILE: a soft copy needs a file' using errcode = '23514';
  end if;
  foreach k in array array['client_id', 'doc_type_id', 'period_id', 'registration_id', 'received_as',
                           'channel', 'received_on', 'received_by', 'remark',
                           'returnable', 'handed_over_name'] loop -- 12
    if (to_jsonb(n)->k) is distinct from (to_jsonb(d)->k) then v_fields := v_fields || k; end if;
  end loop;
  if cardinality(v_fields) = 0 then return; end if;
  -- D: a dispatched original keeps its client and stays an original (its packet would no longer match).
  -- 12 (spec AC-12): …and stays returnable.
  if (v_fields && array['client_id', 'received_as', 'returnable'])
     and exists (select 1 from public.dispatch_item i where i.document_id = p_id and i.removed_at is null) then
    raise exception 'DISPATCHED: undo the dispatch before changing the client or how it was received' using errcode = 'P0001';
  end if;

  update public.document set client_id = n.client_id, doc_type_id = n.doc_type_id, period_id = n.period_id,
      registration_id = n.registration_id, received_as = n.received_as, channel = n.channel,
      received_on = n.received_on, received_by = n.received_by, remark = n.remark,
      returnable = n.returnable, handed_over_name = n.handed_over_name -- 12
    where id = p_id
    returning status = 'received' and d.status <> 'received' into v_reset; -- 07

  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (d.office_id, private.current_staff_id(),
            case when v_fields && array['client_id', 'doc_type_id'] then 'document.classified' else 'document.updated' end,
            'document', p_id::text,
            jsonb_strip_nulls(jsonb_build_object('fields', to_jsonb(v_fields), 'client_id', n.client_id, 'doc_type_id', n.doc_type_id,
              'review_reset', case when v_reset then true end))); -- 07
end $$;

-- ── Checks and the column ───────────────────────────────────────────────────────────────────────────────
alter table public.document
  drop constraint document_handed_over_pair,
  drop constraint document_handed_over_hard_copy,
  add constraint document_handed_over_hard_copy check (handed_over_name is null or received_as = 'hard_copy');
revoke insert (handed_over_kind), update (handed_over_kind) on public.document from authenticated;
alter table public.document drop column handed_over_kind;
drop type public.handed_over_kind;
comment on column public.document.handed_over_name is '12: who handed the hard copy in (one text field, D1; 1-120). Personal data: on the entity only, never in activity, logs or URLs.';
