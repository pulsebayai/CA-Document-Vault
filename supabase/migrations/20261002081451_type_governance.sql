-- Feature 05 — migration B, part 1 of 3 (sections 1–4; parts 2–3 follow): type governance (spec AC-1 … AC-17; plan step 2). Needs migration A.
--   1. doc_type: decision columns + checks; status/decision columns change only inside the decision functions
--      (app.type_decision), including for Admin/Manager writing the row directly (Raja 2026-10-02 12:57, step-1 contract)
--   2. notification (+ kind enum, RLS: recipient-only select / update of read_at; no app insert or delete)
--   3. 03's document_before_write — 07's body copied verbatim, changed only where marked "05":
--      app.type_merge (merge moves archived documents and keeps review state) + a share lock on a proposed type
--   4. 04's document_after_link skips a merge's rows (app.type_merge); private.link_moved (definer) links them
--      set-based afterwards — the plan's fallback: per-row linking made a 1,000-document merge take 2.0 s (dry run)
--   5. private helpers: type_item, period_conflicts, plan_add_type, merge_rows, notify (definer), decide_* cores
--   6. public: proposal_queue, preview_type_decision, approve_proposed_type, merge_proposed_type,
--      reject_proposed_type, mark_notifications_read, catalogue_metric (all SECURITY INVOKER)
--   7. reset_test_office purges notifications and decided proposals
-- No back-fill: existing proposed rows stay 'proposed'. No doc_type_proposal table (spec S6).

-- ── 1. doc_type decision columns ─────────────────────────────────────────────
alter table public.doc_type
  add column mapped_to_id     uuid references public.doc_type (id),
  add column decided_by       uuid references public.staff_user (id),
  add column decided_at       timestamptz,
  add column decision_comment text check (decision_comment is null or length(decision_comment) between 1 and 500);
alter table public.doc_type drop constraint doc_type_proposed_for_client;
alter table public.doc_type
  add constraint doc_type_proposed_for_client check ((status in ('proposed', 'mapped', 'rejected')) = (proposed_for_client_id is not null)),
  add constraint doc_type_mapped_to check ((status = 'mapped') = (mapped_to_id is not null)),
  add constraint doc_type_decided check (status not in ('mapped', 'rejected') or (decided_at is not null and decided_by is not null and not active));
create index doc_type_mapped_to_idx on public.doc_type (mapped_to_id);
create index doc_type_decided_by_idx on public.doc_type (decided_by);
create index doc_type_proposed_item_idx on public.doc_type (office_id, doc_group_id, lower(name)) where status = 'proposed';

-- Decision columns are writable by Admin/Manager (doc_type_update policy) only while app.type_decision is on,
-- which only the decision functions set. period_kind joins them: approved types keep their period kind (02),
-- except when "Edit & approve" sets it.
grant update (status, proposed_for_client_id, period_kind, mapped_to_id, decided_by, decided_at, decision_comment)
  on public.doc_type to authenticated;

-- 02's doc_type_before_write, unchanged except the block marked "05".
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
  -- 05: a proposal is decided only through the review queue's functions (they set app.type_decision).
  if coalesce(current_setting('app.type_decision', true), '') <> 'on' and (
       (tg_op = 'INSERT' and (new.status not in ('approved', 'proposed') or new.mapped_to_id is not null
                              or new.decided_by is not null or new.decided_at is not null or new.decision_comment is not null))
       or (tg_op = 'UPDATE' and (new.status, new.proposed_for_client_id, new.period_kind, new.doc_group_id, new.mapped_to_id,
                                 new.decided_by, new.decided_at, new.decision_comment)
                                is distinct from
                                (old.status, old.proposed_for_client_id, old.period_kind, old.doc_group_id, old.mapped_to_id,
                                 old.decided_by, old.decided_at, old.decision_comment))) then
    raise exception 'IMMUTABLE: a proposed type is approved, merged or rejected only from the review queue' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;

-- ── 2. Notifications (AC-13) ─────────────────────────────────────────────────
create type public.notification_kind as enum ('type_decision');
create table public.notification (
  id           uuid primary key default gen_random_uuid(),
  office_id    uuid not null references public.office (id),
  recipient_id uuid not null references public.staff_user (id),
  kind         public.notification_kind not null,
  entity_type  text not null check (entity_type in ('doc_type')),
  entity_id    uuid not null,
  data         jsonb not null default '{}', -- IDs and the decision only; names are read at display time
  created_at   timestamptz not null default now(),
  read_at      timestamptz
);
create index notification_recipient_idx on public.notification (recipient_id, created_at desc);
create index notification_office_idx on public.notification (office_id);
create index notification_unread_idx on public.notification (recipient_id) where read_at is null;
create trigger notification_no_delete before delete on public.notification
  for each row execute function private.forbid_delete_unless_purge();
alter table public.notification enable row level security;
create policy notification_select on public.notification for select to authenticated
  using (office_id = (select private.current_office_id()) and recipient_id = (select private.current_staff_id()));
create policy notification_update on public.notification for update to authenticated
  using (office_id = (select private.current_office_id()) and recipient_id = (select private.current_staff_id()))
  with check (office_id = (select private.current_office_id()) and recipient_id = (select private.current_staff_id()));
revoke all on public.notification from anon, authenticated;
grant select on public.notification to authenticated;
grant update (read_at) on public.notification to authenticated;

-- Written only by the decision functions (invoker) through this definer helper: tenant first, office staff only.
create or replace function private.notify(p_recipients uuid[], p_kind public.notification_kind, p_entity_type text,
                                          p_entity_id uuid, p_data jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_office uuid := private.current_office_id(); v_n integer;
begin
  if v_office is null then raise exception 'OFFICE_DENIED: no office' using errcode = '42501'; end if;
  insert into public.notification (office_id, recipient_id, kind, entity_type, entity_id, data)
    select v_office, s.id, p_kind, p_entity_type, p_entity_id, coalesce(p_data, '{}')
      from public.staff_user s
     where s.id = any (p_recipients) and s.office_id = v_office;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function private.notify(uuid[], public.notification_kind, text, uuid, jsonb) from public, anon;
grant execute on function private.notify(uuid[], public.notification_kind, text, uuid, jsonb) to authenticated;

create or replace function public.mark_notifications_read()
returns integer language plpgsql security invoker set search_path = '' as $$
declare v_n integer;
begin
  update public.notification set read_at = now()
   where recipient_id = (select private.current_staff_id()) and read_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.mark_notifications_read() from public, anon;
grant execute on function public.mark_notifications_read() to authenticated;

-- ── 3. 03's document_before_write: 07's body (20261001123125) verbatim + the lines marked "05" ──
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
    end if;
    new.classified_at := coalesce(old.classified_at,
      case when new.client_id is not null and new.doc_type_id is not null then now() end);
    v_dims := (new.client_id, new.doc_type_id, new.period_id, new.registration_id)
              is distinct from (old.client_id, old.doc_type_id, old.period_id, old.registration_id);
    -- 07 (AC-4): a new version, or a change of what the document is (client, type, period, registration), sends a
    -- reviewed or Needs-correction document back to To review, with a 'reset' row in its history.
    if old.status <> 'received' and new.status = old.status and not v_merge -- 05
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

  new.updated_at := now();
  return new;
end $$;

-- ── 4. Linking after a merge (04) ─────────────────────────────────────────────
-- 04's document_after_link (20260930120658) verbatim + the line marked "05": a merge's own document update
-- (app.type_merge = the moved rows' old type) is linked afterwards, set-based, by private.link_moved.
create or replace function private.document_after_link()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_item uuid; v_prev text := coalesce(current_setting('app.doc_write', true), '');
begin
  if coalesce(current_setting('app.purge_office', true), '') = new.office_id::text then return null; end if;
  if tg_op = 'UPDATE' and coalesce(current_setting('app.type_merge', true), '') = old.doc_type_id::text then return null; end if; -- 05
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

-- Links documents a merge moved (the same rule as document_after_link: not archived, client, type and period set),
-- in one statement, then recomputes each expected item touched once. Definer like 04's trigger (authenticated can't
-- write expected_doc_id); tenant first: only the caller's office's documents.
create or replace function private.link_moved(p_docs uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_office uuid := private.current_office_id();
  v_prev   text := coalesce(current_setting('app.doc_write', true), '');
  v_items  uuid[];
  i uuid;
begin
  if v_office is null then raise exception 'OFFICE_DENIED: no office' using errcode = '42501'; end if;
  perform set_config('app.doc_write', 'on', true);
  with x as (
    select d.id, d.expected_doc_id as old_item,
           case when d.archived_at is null and d.client_id is not null and d.doc_type_id is not null and d.period_id is not null
                then private.match_expected(d.office_id, d.client_id, d.doc_type_id, d.period_id, d.registration_id) end as item
      from public.document d where d.id = any (p_docs) and d.office_id = v_office
  ), upd as (
    update public.document d set expected_doc_id = x.item
      from x where d.id = x.id and d.expected_doc_id is distinct from x.item
    returning x.item, x.old_item)
  select array_agg(distinct u) into v_items
    from (select item as u from upd union select old_item from upd) z where u is not null;
  perform set_config('app.doc_write', v_prev, true);
  foreach i in array coalesce(v_items, '{}') loop
    perform private.recompute_expected(i, null);
  end loop;
end $$;
revoke all on function private.link_moved(uuid[]) from public, anon;
grant execute on function private.link_moved(uuid[]) to authenticated;
