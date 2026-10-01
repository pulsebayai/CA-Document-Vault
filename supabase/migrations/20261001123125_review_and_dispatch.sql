-- Feature 07 — review & dispatch, migration B (spec "Data model changes", plan step 2; schema lock: 07).
-- Tests: tests/rls/review-dispatch.test.ts, tests/rls/review-metric.test.ts. Needs migration A (the enum values).
--
--   1. Review state on document + append-only review history (document_review)
--   2. Dispatch packets: dispatch + dispatch_item (one live packet per original; removal never deletes)
--   3. RLS + grants: select follows the document / client; writes only inside the functions below (flags)
--   4. 03's document_before_write: the status gate (app.doc_review) + resets (AC-4) — body copied from
--      20260928134130_documents_hardening.sql, changed only where marked "07"
--   5. 03's update_document / add_document_version: activity notes a reset; corrected file's received on (AC-4)
--   6. 04's linking: a Needs-correction document doesn't count (recompute_expected) + a status-change trigger
--   7. review_document / undo_review / create_dispatch / undo_dispatch_item (SECURITY INVOKER)
--   8. 03b's search functions: Return filter + facet, state columns on rows
--   9. reset_test_office purges the new tables
-- No back-fill: existing documents stay 'received' (= To review).

-- ── 1. Review state + history ───────────────────────────────────────────────
create type public.review_outcome as enum ('reviewed', 'needs_correction', 'undone', 'reset');

alter table public.document
  add column reviewed_by       uuid references public.staff_user (id),
  add column reviewed_at       timestamptz,
  add column correction_reason text check (correction_reason is null or length(correction_reason) between 1 and 500);
alter table public.document
  add constraint document_correction_reason_state check ((status = 'needs_correction') = (correction_reason is not null)),
  add constraint document_reviewed_state check ((status = 'received') = (reviewed_by is null and reviewed_at is null));

create table public.document_review (
  id          uuid primary key default gen_random_uuid(),
  office_id   uuid not null references public.office (id),
  document_id uuid not null references public.document (id),
  outcome     public.review_outcome not null,
  reason      text check (reason is null or length(reason) between 1 and 500),
  actor_id    uuid references public.staff_user (id), -- null only for a reset by a system writer
  created_at  timestamptz not null default now(),
  constraint document_review_reason check (outcome not in ('needs_correction', 'undone') or reason is not null)
);
create index document_review_document_idx on public.document_review (document_id, created_at);
create index document_review_office_idx on public.document_review (office_id);
create index document_review_actor_idx on public.document_review (actor_id);
create index document_reviewed_by_idx on public.document (reviewed_by);
create index document_status_idx on public.document (office_id, status) where archived_at is null;

-- ── 2. Dispatch packets ─────────────────────────────────────────────────────
create type public.dispatch_method as enum ('courier', 'hand_delivery', 'client_collected', 'other');

create table public.dispatch (
  id             uuid primary key default gen_random_uuid(),
  office_id      uuid not null references public.office (id),
  client_id      uuid not null references public.client (id),
  dispatched_on  date not null,
  method         public.dispatch_method not null,
  courier_name   text check (courier_name is null or length(courier_name) between 1 and 100),
  tracking_no    text check (tracking_no is null or length(tracking_no) between 1 and 60),
  recipient_name text not null check (length(recipient_name) between 1 and 120),
  created_by     uuid not null references public.staff_user (id),
  created_at     timestamptz not null default now(),
  constraint dispatch_courier_only check (method = 'courier' or (courier_name is null and tracking_no is null))
);
create table public.dispatch_item (
  id             uuid primary key default gen_random_uuid(),
  office_id      uuid not null references public.office (id),
  dispatch_id    uuid not null references public.dispatch (id),
  document_id    uuid not null references public.document (id),
  removed_at     timestamptz,
  removed_by     uuid references public.staff_user (id),
  removed_reason text check (removed_reason is null or length(removed_reason) between 1 and 500),
  constraint dispatch_item_removed check ((removed_at is null) = (removed_by is null) and (removed_at is null) = (removed_reason is null))
);
create unique index dispatch_item_live_key on public.dispatch_item (document_id) where removed_at is null; -- one live packet per original
create index dispatch_office_idx on public.dispatch (office_id);
create index dispatch_client_idx on public.dispatch (client_id);
create index dispatch_created_by_idx on public.dispatch (created_by);
create index dispatch_item_dispatch_idx on public.dispatch_item (dispatch_id);
create index dispatch_item_document_idx on public.dispatch_item (document_id);
create index dispatch_item_office_idx on public.dispatch_item (office_id);
create index dispatch_item_removed_by_idx on public.dispatch_item (removed_by);

-- History and packets are append-only; an item changes only once, when it is removed (AC-7, AC-10).
create or replace function private.review_dispatch_before_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'dispatch_item'
     and (new.id, new.office_id, new.dispatch_id, new.document_id) = (old.id, old.office_id, old.dispatch_id, old.document_id)
     and old.removed_at is null and new.removed_at is not null
     and (current_user not in ('authenticated', 'anon') or coalesce(current_setting('app.dispatch_write', true), '') = 'on') then
    return new;
  end if;
  raise exception 'IMMUTABLE: % rows are append-only', tg_table_name using errcode = 'P0001';
end $$;
create trigger document_review_no_update before update on public.document_review
  for each row execute function private.review_dispatch_before_update();
create trigger dispatch_no_update before update on public.dispatch
  for each row execute function private.review_dispatch_before_update();
create trigger dispatch_item_before_update before update on public.dispatch_item
  for each row execute function private.review_dispatch_before_update();
create trigger document_review_no_delete before delete on public.document_review
  for each row execute function private.forbid_delete_unless_purge();
create trigger dispatch_no_delete before delete on public.dispatch
  for each row execute function private.forbid_delete_unless_purge();
create trigger dispatch_item_no_delete before delete on public.dispatch_item
  for each row execute function private.forbid_delete_unless_purge();

-- ── 3. RLS + grants ─────────────────────────────────────────────────────────
alter table public.document_review enable row level security;
alter table public.dispatch        enable row level security;
alter table public.dispatch_item   enable row level security;

-- Review history follows its document's visibility (the subquery runs under document RLS).
create policy document_review_select on public.document_review for select to authenticated
  using (office_id = (select private.current_office_id())
         and exists (select 1 from public.document d where d.id = document_id));
-- Written only inside review_document / undo_review (app.doc_review = the document), as the caller.
create policy document_review_insert on public.document_review for insert to authenticated
  with check (office_id = (select private.current_office_id())
              and coalesce((select current_setting('app.doc_review', true)), '') = document_id::text
              and actor_id = (select private.current_staff_id())
              and exists (select 1 from public.document d where d.id = document_review.document_id
                          and d.office_id = document_review.office_id));

create policy dispatch_select on public.dispatch for select to authenticated
  using (office_id = (select private.current_office_id()) and private.can_see_client(client_id));
create policy dispatch_insert on public.dispatch for insert to authenticated
  with check (office_id = (select private.current_office_id())
              and coalesce((select current_setting('app.dispatch_write', true)), '') = 'on'
              and created_by = (select private.current_staff_id())
              and private.can_see_client(client_id));
create policy dispatch_item_select on public.dispatch_item for select to authenticated
  using (office_id = (select private.current_office_id())
         and exists (select 1 from public.dispatch p where p.id = dispatch_id));
create policy dispatch_item_insert on public.dispatch_item for insert to authenticated
  with check (office_id = (select private.current_office_id())
              and coalesce((select current_setting('app.dispatch_write', true)), '') = 'on'
              and exists (select 1 from public.dispatch p where p.id = dispatch_item.dispatch_id
                          and p.office_id = dispatch_item.office_id));
create policy dispatch_item_update on public.dispatch_item for update to authenticated
  using (office_id = (select private.current_office_id())
         and coalesce((select current_setting('app.dispatch_write', true)), '') = 'on'
         and exists (select 1 from public.dispatch p where p.id = dispatch_id))
  with check (office_id = (select private.current_office_id()));

revoke all on public.document_review, public.dispatch, public.dispatch_item from anon, authenticated;
grant select on public.document_review, public.dispatch, public.dispatch_item to authenticated;
grant insert (office_id, document_id, outcome, reason, actor_id) on public.document_review to authenticated;
grant insert (office_id, client_id, dispatched_on, method, courier_name, tracking_no, recipient_name, created_by)
  on public.dispatch to authenticated;
grant insert (office_id, dispatch_id, document_id) on public.dispatch_item to authenticated;
grant update (removed_at, removed_by, removed_reason) on public.dispatch_item to authenticated;
-- The review columns: written only by review_document / undo_review (the trigger keeps them otherwise).
grant update (status, reviewed_by, reviewed_at, correction_reason) on public.document to authenticated;

-- ── 4. 03's document trigger: status gate + resets ──────────────────────────
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
    new.reviewed_by := null; new.reviewed_at := null; new.correction_reason := null; -- 07
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
    -- 07 (status gate): status and the review columns change only inside review_document / undo_review,
    -- which set app.doc_review to this document's id. Anything else keeps them.
    if coalesce(current_setting('app.doc_review', true), '') <> new.id::text then
      new.status := old.status;
      new.reviewed_by := old.reviewed_by; new.reviewed_at := old.reviewed_at; new.correction_reason := old.correction_reason;
    end if;
    new.classified_at := coalesce(old.classified_at,
      case when new.client_id is not null and new.doc_type_id is not null then now() end);
    v_dims := (new.client_id, new.doc_type_id, new.period_id, new.registration_id)
              is distinct from (old.client_id, old.doc_type_id, old.period_id, old.registration_id);
    -- 07 (AC-4): a new version, or a change of what the document is (client, type, period, registration), sends a
    -- reviewed or Needs-correction document back to To review, with a 'reset' row in its history.
    if old.status <> 'received' and new.status = old.status
       and (v_dims or new.current_version_id is distinct from old.current_version_id) then
      new.status := 'received';
      new.reviewed_by := null; new.reviewed_at := null; new.correction_reason := null;
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

-- ── 5. 03's functions: activity notes a reset; corrected file's received on ──
-- update_document: unchanged except the activity row says when the save reset a review (AC-16).
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
    where id = p_id
    returning status = 'received' and d.status <> 'received' into v_reset; -- 07

  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (d.office_id, private.current_staff_id(),
            case when v_fields && array['client_id', 'doc_type_id'] then 'document.classified' else 'document.updated' end,
            'document', p_id::text,
            jsonb_strip_nulls(jsonb_build_object('fields', to_jsonb(v_fields), 'client_id', n.client_id, 'doc_type_id', n.doc_type_id,
              'review_reset', case when v_reset then true end))); -- 07
end $$;

-- add_document_version: one optional argument (default null keeps 03's call shape). For a Needs-correction
-- document, p_received_on (the corrected file's date) replaces received on before the version resets the review.
drop function public.add_document_version(uuid, jsonb);
create function public.add_document_version(p_document_id uuid, p_file jsonb, p_received_on date default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare d public.document; v_id uuid; v_no integer; v_on boolean := false; v_status public.document_status;
begin
  perform private.begin_doc_write(); -- review hardening: only functions write documents
  select * into d from public.document where id = p_document_id;
  if not found then raise exception 'NOT_FOUND: document' using errcode = 'P0002'; end if;
  if d.archived_at is not null then raise exception 'ARCHIVED: unarchive the document before changing it' using errcode = 'P0001'; end if;
  if p_received_on is not null and d.status = 'needs_correction' and p_received_on <> d.received_on then -- 07
    update public.document set received_on = p_received_on where id = d.id; -- the trigger refuses a future date
    v_on := true;
  end if;
  insert into public.document_version (office_id, document_id, storage_path, file_name)
    values (d.office_id, d.id, p_file->>'storage_path', p_file->>'file_name')
    returning id, version_no into v_id, v_no;
  select x.status into v_status from public.document x where x.id = d.id; -- 07
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (d.office_id, private.current_staff_id(), 'document.version_added', 'document', d.id::text,
            jsonb_strip_nulls(jsonb_build_object('version_id', v_id, 'version_no', v_no,
              'fields', case when v_on then to_jsonb(array['received_on']) end,
              'review_reset', case when d.status <> 'received' and v_status = 'received' then true end)));
  return jsonb_build_object('version_id', v_id, 'version_no', v_no);
end $$;
revoke all on function public.add_document_version(uuid, jsonb, date) from public, anon;
grant execute on function public.add_document_version(uuid, jsonb, date) to authenticated;

-- ── 6. 04's linking: Needs correction doesn't count ─────────────────────────
-- recompute_expected (20261001070941), changed only in the two document lookups ("07").
create or replace function private.recompute_expected(p_item uuid, p_new_doc uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare e public.expected_doc; v_doc uuid; v_on date;
begin
  select * into e from public.expected_doc where id = p_item for update;
  if not found or e.status = 'waived' then return; end if;
  if (select auth.uid()) is not null and e.office_id is distinct from private.current_office_id() then return; end if;
  if e.status = 'received' then
    select d.received_on into v_on from public.document d
     where d.id = e.completed_by_document_id and d.expected_doc_id = e.id and d.archived_at is null
       and d.status <> 'needs_correction'; -- 07
    if found then
      if v_on is distinct from e.received_on then
        update public.expected_doc set received_on = v_on where id = e.id;
      end if;
      return;
    end if;
  end if;
  select d.id, d.received_on into v_doc, v_on from public.document d
   where d.expected_doc_id = e.id and d.archived_at is null
     and d.status <> 'needs_correction' -- 07
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

-- 04's document_after_link also runs when the review status changes — including a reset made inside 03's
-- trigger by a new version, which an "UPDATE OF status" column list would miss (the statement doesn't name status).
-- A separate trigger with a WHEN clause, so ordinary saves pay nothing extra.
create trigger document_after_review_link after update on public.document
  for each row when (old.status is distinct from new.status)
  execute function private.document_after_link();

-- ── 7. Review and dispatch functions (SECURITY INVOKER: RLS applies) ────────
-- AC-1/2/3: anyone who can see a filed, live document marks it reviewed or Needs correction (reason 1–500).
create or replace function public.review_document(p_id uuid, p_outcome text, p_reason text default null)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  d        public.document;
  v_staff  uuid := private.current_staff_id();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_staff is null then raise exception 'ROLE_REQUIRED: sign in as active staff' using errcode = '42501'; end if;
  if p_outcome is null or p_outcome not in ('reviewed', 'needs_correction') then
    raise exception 'OUTCOME_INVALID: reviewed or needs_correction' using errcode = '22023';
  end if;
  if p_outcome = 'needs_correction' and (v_reason is null or length(v_reason) > 500) then
    raise exception 'REASON_REQUIRED: give a reason of 1–500 characters' using errcode = '23514';
  end if;
  select * into d from public.document where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: document' using errcode = 'P0002'; end if;
  if d.client_id is null or d.doc_type_id is null then
    raise exception 'NOT_CLASSIFIED: file the document (client and type) before reviewing it' using errcode = 'P0001';
  end if;
  if d.archived_at is not null then raise exception 'ARCHIVED: unarchive the document before changing it' using errcode = 'P0001'; end if;
  if p_outcome = 'reviewed' and d.status = 'reviewed' then
    raise exception 'ALREADY_REVIEWED: this document has already been reviewed' using errcode = 'P0001';
  end if;
  perform private.begin_doc_write();
  perform set_config('app.doc_review', p_id::text, true);
  update public.document
     set status = p_outcome::public.document_status, reviewed_by = v_staff, reviewed_at = now(),
         correction_reason = case when p_outcome = 'needs_correction' then v_reason end
   where id = p_id;
  insert into public.document_review (office_id, document_id, outcome, reason, actor_id)
    values (d.office_id, p_id, p_outcome::public.review_outcome, case when p_outcome = 'needs_correction' then v_reason end, v_staff);
  perform set_config('app.doc_review', '', true);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (d.office_id, v_staff, 'document.' || p_outcome, 'document', p_id::text,
            jsonb_build_object('client_id', d.client_id, 'doc_type_id', d.doc_type_id));
end $$;

-- AC-5: Admin/Manager put a reviewed or Needs-correction document back to To review, with a reason.
create or replace function public.undo_review(p_id uuid, p_reason text)
returns void language plpgsql security invoker set search_path = '' as $$
declare d public.document; v_staff uuid := private.current_staff_id(); v_reason text := btrim(coalesce(p_reason, ''));
begin
  if not private.has_role(array['admin', 'manager']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: only Admin or Manager can undo a review' using errcode = '42501';
  end if;
  if length(v_reason) not between 1 and 500 then
    raise exception 'REASON_REQUIRED: give a reason of 1–500 characters' using errcode = '23514';
  end if;
  select * into d from public.document where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: document' using errcode = 'P0002'; end if;
  if d.archived_at is not null then raise exception 'ARCHIVED: unarchive the document before changing it' using errcode = 'P0001'; end if;
  if d.status = 'received' then raise exception 'NOT_REVIEWED: this document is still to review' using errcode = 'P0001'; end if;
  perform private.begin_doc_write();
  perform set_config('app.doc_review', p_id::text, true);
  update public.document set status = 'received', reviewed_by = null, reviewed_at = null, correction_reason = null where id = p_id;
  insert into public.document_review (office_id, document_id, outcome, reason, actor_id)
    values (d.office_id, p_id, 'undone', v_reason, v_staff);
  perform set_config('app.doc_review', '', true);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (d.office_id, v_staff, 'document.review_undone', 'document', p_id::text,
            jsonb_build_object('client_id', d.client_id, 'from', d.status));
end $$;

-- AC-8/9: one packet of a client's ready originals, all-or-nothing. Returns { id }.
-- p = { client_id, document_ids[], dispatched_on, method, courier_name?, tracking_no?, recipient_name }.
create or replace function public.create_dispatch(p jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_office    uuid := private.current_office_id();
  v_staff     uuid := private.current_staff_id();
  v_client    uuid := nullif(p->>'client_id', '')::uuid;
  v_ids       uuid[];
  v_on        date := nullif(p->>'dispatched_on', '')::date;
  v_method    public.dispatch_method := nullif(p->>'method', '')::public.dispatch_method;
  v_courier   text := nullif(btrim(coalesce(p->>'courier_name', '')), '');
  v_tracking  text := nullif(btrim(coalesce(p->>'tracking_no', '')), '');
  v_recipient text := btrim(coalesce(p->>'recipient_name', ''));
  v_today     date := (now() at time zone 'Asia/Kolkata')::date;
  v_found     integer := 0;
  v_latest    date;
  d           record;
  v_id        uuid;
begin
  if v_staff is null then raise exception 'ROLE_REQUIRED: sign in as active staff' using errcode = '42501'; end if;
  select coalesce(array_agg(distinct x::uuid), '{}') into v_ids
    from jsonb_array_elements_text(case when jsonb_typeof(p->'document_ids') = 'array' then p->'document_ids' else '[]'::jsonb end) x;
  if cardinality(v_ids) = 0 then raise exception 'NO_DOCUMENTS: tick at least one original' using errcode = '23514'; end if;
  if v_on is null then raise exception 'DATE_REQUIRED: give the date dispatched' using errcode = '23514'; end if;
  if v_on > v_today then raise exception 'DATE_FUTURE: the dispatch date cannot be in the future' using errcode = '23514'; end if;
  if v_method is null then raise exception 'METHOD_REQUIRED: choose how it was dispatched' using errcode = '23514'; end if;
  if length(v_recipient) not between 1 and 120 then
    raise exception 'RECIPIENT_REQUIRED: give the recipient''s name (up to 120 characters)' using errcode = '23514';
  end if;
  if v_method <> 'courier' then v_courier := null; v_tracking := null; end if;
  if v_client is null or not exists (select 1 from public.client c where c.id = v_client) then
    raise exception 'NOT_FOUND: client' using errcode = 'P0002';
  end if;
  -- Lock the originals in a stable order: two packets for the same original serialise here.
  for d in select x.id, x.doc_code, x.client_id, x.doc_type_id, x.received_as, x.status, x.archived_at, x.received_on
             from public.document x where x.id = any (v_ids) order by x.id for update loop
    v_found := v_found + 1;
    if d.client_id is distinct from v_client or d.doc_type_id is null or d.received_as <> 'original'
       or d.archived_at is not null or d.status not in ('reviewed', 'needs_correction') then
      raise exception 'NOT_ELIGIBLE: % is not a ready original of this client', d.doc_code using errcode = '23514';
    end if;
    if exists (select 1 from public.dispatch_item i where i.document_id = d.id and i.removed_at is null) then
      raise exception 'ALREADY_DISPATCHED: % is already dispatched', d.doc_code using errcode = '23514';
    end if;
    v_latest := greatest(v_latest, d.received_on);
  end loop;
  if v_found < cardinality(v_ids) then raise exception 'NOT_FOUND: document' using errcode = 'P0002'; end if;
  if v_on < v_latest then
    raise exception 'DATE_BEFORE_RECEIVED: the dispatch date is before a ticked original was received' using errcode = '23514';
  end if;

  perform set_config('app.dispatch_write', 'on', true);
  insert into public.dispatch (office_id, client_id, dispatched_on, method, courier_name, tracking_no, recipient_name, created_by)
    values (v_office, v_client, v_on, v_method, v_courier, v_tracking, v_recipient, v_staff)
    returning id into v_id;
  insert into public.dispatch_item (office_id, dispatch_id, document_id)
    select v_office, v_id, x from unnest(v_ids) x;
  perform set_config('app.dispatch_write', '', true);

  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, v_staff, 'dispatch.created', 'dispatch', v_id::text,
            jsonb_build_object('client_id', v_client, 'document_ids', to_jsonb(v_ids), 'method', v_method));
  return jsonb_build_object('id', v_id);
end $$;

-- AC-10: Admin/Manager take one original out of its packet (reason kept on the item). Nothing is deleted.
create or replace function public.undo_dispatch_item(p_document_id uuid, p_reason text)
returns void language plpgsql security invoker set search_path = '' as $$
declare i public.dispatch_item; v_staff uuid := private.current_staff_id(); v_reason text := btrim(coalesce(p_reason, ''));
begin
  if not private.has_role(array['admin', 'manager']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: only Admin or Manager can undo a dispatch' using errcode = '42501';
  end if;
  if length(v_reason) not between 1 and 500 then
    raise exception 'REASON_REQUIRED: give a reason of 1–500 characters' using errcode = '23514';
  end if;
  perform set_config('app.dispatch_write', 'on', true);
  select * into i from public.dispatch_item where document_id = p_document_id and removed_at is null for update;
  if not found then
    perform set_config('app.dispatch_write', '', true);
    raise exception 'NOT_DISPATCHED: this original is not in a packet' using errcode = 'P0001';
  end if;
  update public.dispatch_item set removed_at = now(), removed_by = v_staff, removed_reason = v_reason where id = i.id;
  perform set_config('app.dispatch_write', '', true);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (i.office_id, v_staff, 'dispatch.item_removed', 'dispatch', i.dispatch_id::text,
            jsonb_build_object('document_id', p_document_id));
end $$;

revoke all on function public.review_document(uuid, text, text), public.undo_review(uuid, text),
  public.create_dispatch(jsonb), public.undo_dispatch_item(uuid, text) from public, anon;
grant execute on function public.review_document(uuid, text, text), public.undo_review(uuid, text),
  public.create_dispatch(jsonb), public.undo_dispatch_item(uuid, text) to authenticated;
revoke all on function private.review_dispatch_before_update() from public, anon, authenticated;

-- ── 8. 03b's search: Return filter + facet, state columns ───────────────────
-- Replaces 20261001093454's two functions (same signatures); changed only where "v_return", "return_state",
-- "reviewed_by_name", "dispatch" appear. The Limited planner hint is unchanged.
create or replace function public.search_documents(p jsonb)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  f          jsonb := coalesce(p->'filters', '{}'::jsonb);
  v_office   uuid := (select private.current_office_id());
  v_limited  boolean := (select private.has_role(array['limited']::public.staff_role[]));
  v_visible  uuid[];
  v_me       uuid := (select private.current_staff_id());
  v_words    text[];
  v_sort     text := coalesce(nullif(p->>'sort', ''), 'received');
  v_state    text := nullif(f->>'state', '');
  v_size     integer := least(greatest(coalesce((p->>'page_size')::integer, 50), 1), 50);
  v_page     integer := greatest(coalesce((p->>'page')::integer, 1), 1);
  v_archived boolean := coalesce((p->>'include_archived')::boolean, false);
  -- Filters (casts reject malformed values with a Postgres error).
  v_client   uuid := nullif(f->>'client_id', '')::uuid;
  v_group    uuid := nullif(f->>'group_id', '')::uuid;
  v_type     uuid := nullif(f->>'doc_type_id', '')::uuid;
  v_fy       uuid := nullif(f->>'fy_id', '')::uuid;
  v_period   uuid := nullif(f->>'period_id', '')::uuid;
  v_reg      uuid := nullif(f->>'registration_id', '')::uuid;
  v_as       public.received_as := nullif(f->>'received_as', '')::public.received_as;
  v_channel  public.doc_channel := nullif(f->>'channel', '')::public.doc_channel;
  v_by       uuid := nullif(f->>'received_by', '')::uuid;
  v_from     date := nullif(f->>'from', '')::date;
  v_to       date := nullif(f->>'to', '')::date;
  v_status   public.document_status := nullif(f->>'status', '')::public.document_status;
  v_return   text := nullif(f->>'return', ''); -- 07: ready | dispatched
  v_result   jsonb;
begin
  if v_sort not in ('received', 'added', 'docid') then
    raise exception 'INVALID_SORT' using errcode = '22023';
  end if;
  if v_state is not null and v_state not in ('classified', 'inbox') then
    raise exception 'INVALID_FILTER: state' using errcode = '22023';
  end if;
  if v_return is not null and v_return not in ('ready', 'dispatched') then
    raise exception 'INVALID_FILTER: return' using errcode = '22023';
  end if;
  if v_office is null then
    return jsonb_build_object('total', 0, 'rows', '[]'::jsonb);
  end if;

  select (array_agg(left(w, 50) order by i))[1:5] into v_words
    from unnest(regexp_split_to_array(btrim(coalesce(p->>'text', '')), '\s+')) with ordinality as x(w, i)
   where w <> '';

  if v_limited then
    select coalesce(array_agg(c.id), '{}') into v_visible
      from public.client c where c.office_id = v_office and private.can_see_client(c.id);
  end if;

  with m as (
    select d.id, d.doc_code, d.fy_code, d.client_id, c.name as client_name, c.code as client_code,
           d.doc_type_id, t.name as type_name, t.doc_group_id as group_id, gr.name as group_name,
           d.period_id, pr.code as period_code, pr.label as period_label, d.registration_id,
           d.received_as, d.channel, d.received_on, d.received_by, s.full_name as received_by_name,
           d.status, d.remark, v.file_name, d.archived_at, d.created_at,
           d.reviewed_at, rv.full_name as reviewed_by_name, d.correction_reason,
           dp.dispatched_on, dp.method as dispatch_method,
           case when di.id is not null then 'dispatched'
                when d.received_as = 'original' and d.client_id is not null and d.doc_type_id is not null
                     and d.archived_at is null and d.status in ('reviewed', 'needs_correction') then 'ready' end as return_state
      from public.document d
      left join public.document_version v on v.id = d.current_version_id
      left join public.client c           on c.id = d.client_id
      left join public.doc_type t         on t.id = d.doc_type_id
      left join public.doc_group gr       on gr.id = t.doc_group_id
      left join public.period pr          on pr.id = d.period_id
      left join public.staff_user s       on s.id = d.received_by
      left join public.staff_user rv      on rv.id = d.reviewed_by
      left join public.dispatch_item di   on di.document_id = d.id and di.removed_at is null
      left join public.dispatch dp        on dp.id = di.dispatch_id
     where d.office_id = v_office
       and (v_archived or d.archived_at is null)
       and (not v_limited or d.client_id is null or d.client_id = any (v_visible)
            or (d.doc_type_id is null and d.created_by = v_me))
       and (v_client is null  or d.client_id = v_client)
       and (v_group is null   or t.doc_group_id = v_group)
       and (v_type is null    or d.doc_type_id = v_type)
       and (v_fy is null      or pr.financial_year_id = v_fy)
       and (v_period is null  or d.period_id = v_period)
       and (v_reg is null     or d.registration_id = v_reg)
       and (v_as is null      or d.received_as = v_as)
       and (v_channel is null or d.channel = v_channel)
       and (v_by is null      or d.received_by = v_by)
       and (v_from is null    or d.received_on >= v_from)
       and (v_to is null      or d.received_on <= v_to)
       and (v_status is null  or d.status = v_status)
       and (v_state is null
            or (v_state = 'classified' and d.client_id is not null and d.doc_type_id is not null)
            or (v_state = 'inbox' and (d.client_id is null or d.doc_type_id is null)))
       and not exists (
         select 1 from unnest(coalesce(v_words, '{}')) as w(word)
          cross join lateral (select replace(replace(replace(w.word, '\', '\\'), '%', '\%'), '_', '\_') as e) q
          where not (coalesce(d.remark, '') ilike '%' || q.e || '%'
                     or coalesce(v.file_name, '') ilike '%' || q.e || '%'
                     or d.doc_code ilike q.e || '%'))
  ), ranked as (
    select m.*, count(*) over () as total,
           row_number() over (order by
             case when v_sort = 'received' then m.received_on end desc nulls last,
             case when v_sort = 'docid' then m.fy_code end desc,
             case when v_sort = 'docid' then (regexp_replace(m.doc_code, '^.*-', ''))::bigint end desc,
             m.created_at desc, m.id) as rn
      from m
     where (v_return is null or m.return_state = v_return)
  )
  select jsonb_build_object(
           'total', coalesce(max(r.total), 0),
           'rows', coalesce(jsonb_agg(to_jsonb(r) - 'total' - 'rn' - 'fy_code' order by r.rn)
                              filter (where r.rn > (v_page - 1) * v_size and r.rn <= v_page * v_size), '[]'::jsonb))
    into v_result
    from ranked r;
  return v_result;
end $$;

-- ── Facets ──────────────────────────────────────────────────────────────────
-- (facet, value, label, n) for group · received_as · channel · received_by · status · return (07). A facet counts the visible
-- documents that match the text and every filter except its own; values with no documents are not returned.
create or replace function public.search_document_facets(p jsonb)
returns table (facet text, value text, label text, n integer)
language plpgsql stable security invoker set search_path = '' as $$
declare
  f          jsonb := coalesce(p->'filters', '{}'::jsonb);
  v_office   uuid := (select private.current_office_id());
  v_limited  boolean := (select private.has_role(array['limited']::public.staff_role[]));
  v_visible  uuid[];
  v_me       uuid := (select private.current_staff_id());
  v_words    text[];
  v_state    text := nullif(f->>'state', '');
  v_archived boolean := coalesce((p->>'include_archived')::boolean, false);
  v_client   uuid := nullif(f->>'client_id', '')::uuid;
  v_group    uuid := nullif(f->>'group_id', '')::uuid;
  v_type     uuid := nullif(f->>'doc_type_id', '')::uuid;
  v_fy       uuid := nullif(f->>'fy_id', '')::uuid;
  v_period   uuid := nullif(f->>'period_id', '')::uuid;
  v_reg      uuid := nullif(f->>'registration_id', '')::uuid;
  v_as       public.received_as := nullif(f->>'received_as', '')::public.received_as;
  v_channel  public.doc_channel := nullif(f->>'channel', '')::public.doc_channel;
  v_by       uuid := nullif(f->>'received_by', '')::uuid;
  v_from     date := nullif(f->>'from', '')::date;
  v_to       date := nullif(f->>'to', '')::date;
  v_status   public.document_status := nullif(f->>'status', '')::public.document_status;
  v_return   text := nullif(f->>'return', ''); -- 07: ready | dispatched
begin
  if v_state is not null and v_state not in ('classified', 'inbox') then
    raise exception 'INVALID_FILTER: state' using errcode = '22023';
  end if;
  if v_return is not null and v_return not in ('ready', 'dispatched') then
    raise exception 'INVALID_FILTER: return' using errcode = '22023';
  end if;
  if v_office is null then
    return;
  end if;

  select (array_agg(left(w, 50) order by i))[1:5] into v_words
    from unnest(regexp_split_to_array(btrim(coalesce(p->>'text', '')), '\s+')) with ordinality as x(w, i)
   where w <> '';

  if v_limited then
    select coalesce(array_agg(c.id), '{}') into v_visible
      from public.client c where c.office_id = v_office and private.can_see_client(c.id);
  end if;

  return query
  with m as (
    select t.doc_group_id as group_id, d.received_as, d.channel, d.received_by, d.status,
           case when di.id is not null then 'dispatched'
                when d.received_as = 'original' and d.client_id is not null and d.doc_type_id is not null
                     and d.archived_at is null and d.status in ('reviewed', 'needs_correction') then 'ready' end as return_state,
           (v_group is null   or t.doc_group_id = v_group) as ok_group,
           (v_as is null      or d.received_as = v_as)     as ok_as,
           (v_channel is null or d.channel = v_channel)    as ok_channel,
           (v_by is null      or d.received_by = v_by)     as ok_by,
           (v_status is null  or d.status = v_status)      as ok_status,
           (v_return is null  or (case when di.id is not null then 'dispatched'
                when d.received_as = 'original' and d.client_id is not null and d.doc_type_id is not null
                     and d.archived_at is null and d.status in ('reviewed', 'needs_correction') then 'ready' end) = v_return) as ok_return
      from public.document d
      left join public.document_version v on v.id = d.current_version_id
      left join public.doc_type t         on t.id = d.doc_type_id
      left join public.period pr          on pr.id = d.period_id
      left join public.dispatch_item di   on di.document_id = d.id and di.removed_at is null
     where d.office_id = v_office
       and (v_archived or d.archived_at is null)
       and (not v_limited or d.client_id is null or d.client_id = any (v_visible)
            or (d.doc_type_id is null and d.created_by = v_me))
       and (v_client is null  or d.client_id = v_client)
       and (v_type is null    or d.doc_type_id = v_type)
       and (v_fy is null      or pr.financial_year_id = v_fy)
       and (v_period is null  or d.period_id = v_period)
       and (v_reg is null     or d.registration_id = v_reg)
       and (v_from is null    or d.received_on >= v_from)
       and (v_to is null      or d.received_on <= v_to)
       and (v_state is null
            or (v_state = 'classified' and d.client_id is not null and d.doc_type_id is not null)
            or (v_state = 'inbox' and (d.client_id is null or d.doc_type_id is null)))
       and not exists (
         select 1 from unnest(coalesce(v_words, '{}')) as w(word)
          cross join lateral (select replace(replace(replace(w.word, '\', '\\'), '%', '\%'), '_', '\_') as e) q
          where not (coalesce(d.remark, '') ilike '%' || q.e || '%'
                     or coalesce(v.file_name, '') ilike '%' || q.e || '%'
                     or d.doc_code ilike q.e || '%'))
  ), counts as (
    select 'group'::text as facet, m.group_id::text as value, count(*)::integer as n from m
     where m.group_id is not null and m.ok_as and m.ok_channel and m.ok_by and m.ok_status and m.ok_return group by m.group_id
    union all
    select 'received_as', m.received_as::text, count(*)::integer from m
     where m.ok_group and m.ok_channel and m.ok_by and m.ok_status and m.ok_return group by m.received_as
    union all
    select 'channel', m.channel::text, count(*)::integer from m
     where m.ok_group and m.ok_as and m.ok_by and m.ok_status and m.ok_return group by m.channel
    union all
    select 'received_by', m.received_by::text, count(*)::integer from m
     where m.ok_group and m.ok_as and m.ok_channel and m.ok_status and m.ok_return group by m.received_by
    union all
    select 'status', m.status::text, count(*)::integer from m
     where m.ok_group and m.ok_as and m.ok_channel and m.ok_by and m.ok_return group by m.status
    union all
    select 'return', m.return_state, count(*)::integer from m
     where m.return_state is not null and m.ok_group and m.ok_as and m.ok_channel and m.ok_by and m.ok_status
     group by m.return_state
  )
  select c.facet, c.value,
         case c.facet
           when 'group' then (select g.name from public.doc_group g where g.id = c.value::uuid)
           when 'received_by' then (select s.full_name || case when s.status = 'deactivated' then ' (inactive)' else '' end
                                      from public.staff_user s where s.id = c.value::uuid)
           else c.value
         end,
         c.n
    from counts c
   order by c.facet, c.n desc, c.value;
end $$;

revoke all on function public.search_documents(jsonb), public.search_document_facets(jsonb) from public, anon;
grant execute on function public.search_documents(jsonb), public.search_document_facets(jsonb) to authenticated;

-- ── 9. Test office reset: the new tables first ──────────────────────────────
create or replace function public.reset_test_office(p_office_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.office where id = p_office_id and is_test) then
    raise exception 'NOT_TEST_OFFICE: only offices flagged is_test can be reset' using errcode = '42501';
  end if;
  perform set_config('app.purge_office', p_office_id::text, true);
  delete from public.dispatch_item       where office_id = p_office_id; -- 07
  delete from public.dispatch            where office_id = p_office_id; -- 07
  delete from public.document_review     where office_id = p_office_id; -- 07
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
-- reset_test_office keeps its grants (service role only): create or replace preserves them.
