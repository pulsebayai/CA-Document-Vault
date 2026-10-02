-- Feature 05 — migration B: type governance (spec AC-1 … AC-17; plan step 2). Needs migration A (enum values).
--   1. doc_type: decision columns + checks; status/decision columns change only inside the decision functions
--      (app.type_decision), including for Admin/Manager writing the row directly (Raja 2026-10-02 12:57, step-1 contract)
--   2. notification (+ kind enum, RLS: recipient-only select / update of read_at; no app insert or delete)
--   3. 03's document_before_write — 07's body copied verbatim, changed only where marked "05":
--      app.type_merge (merge moves archived documents and keeps review state) + a share lock on a proposed type
--   4. private helpers: type_item, period_conflicts, plan_add_type, merge_rows, notify (definer), decide_* cores
--   5. public: proposal_queue, preview_type_decision, approve_proposed_type, merge_proposed_type,
--      reject_proposed_type, mark_notifications_read, catalogue_metric (all SECURITY INVOKER)
--   6. reset_test_office purges notifications and decided proposals
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

-- ── 4. Private helpers (SECURITY INVOKER unless noted: RLS and the caller's role apply) ─────────────────
-- The pending rows of p_type's item = proposed rows with the same group + name (case-insensitive; spaces were
-- collapsed by create_proposed_type), earliest first (the survivor). p_lock: lock them, in id order, so two
-- decisions on one item queue up instead of deadlocking; the second then finds nothing pending.
create or replace function private.type_item(p_type uuid, p_lock boolean)
returns uuid[] language plpgsql set search_path = '' as $$
declare r public.doc_type; v uuid[];
begin
  select * into r from public.doc_type where id = p_type and office_id = private.current_office_id();
  if not found then raise exception 'NOT_FOUND: document type' using errcode = 'P0002'; end if;
  if r.status = 'proposed' then
    if p_lock then
      perform 1 from public.doc_type t
        where t.office_id = r.office_id and t.doc_group_id = r.doc_group_id and lower(t.name) = lower(r.name)
          and t.status = 'proposed'
        order by t.id for update;
    end if;
    select array_agg(t.id order by t.created_at, t.id) into v from public.doc_type t
     where t.office_id = r.office_id and t.doc_group_id = r.doc_group_id and lower(t.name) = lower(r.name)
       and t.status = 'proposed';
    if v is not null and p_type = any (v) then return v; end if;
    select * into r from public.doc_type where id = p_type;
  end if;
  if r.decided_at is not null then
    raise exception 'ALREADY_DECIDED: %', r.decided_by using errcode = 'P0001';
  end if;
  raise exception 'NOT_PROPOSED: this type is not waiting for a decision' using errcode = 'P0001';
end $$;

-- Documents of the item whose period doesn't fit p_kind (03's PERIOD_KIND rule).
create or replace function private.period_conflicts(p_rows uuid[], p_kind public.period_kind)
returns table (document_id uuid, doc_code text) language sql stable set search_path = '' as $$
  select d.id, d.doc_code
    from public.document d join public.period p on p.id = d.period_id
   where d.doc_type_id = any (p_rows)
     and not (p_kind in ('month', 'none')
              or (p_kind = 'quarter' and p.kind in ('quarter', 'year'))
              or (p_kind = 'year' and p.kind = 'year'))
   order by d.doc_code
$$;

-- Adds an approved type to a client's plan if it isn't there in any state (spec S1): the type's default schedule
-- from the earliest still-open period (04); the client group row is created or re-enabled as in 03's propose
-- (assigned to the incharge). The new row takes p_state, the proposing row's state before the decision, so a paused or
-- removed row stays so (AC-4). Archived clients are skipped (no plan changes on archived clients). Returns whether a
-- plan row was added.
create or replace function private.plan_add_type(p_client uuid, p_type uuid, p_state public.plan_state)
returns boolean language plpgsql set search_path = '' as $$
declare
  v_office uuid := private.current_office_id();
  v_staff  uuid := private.current_staff_id();
  t public.doc_type;
  v_incharge uuid;
  v_group uuid;
  v_state public.plan_state;
  v_plan uuid;
begin
  if exists (select 1 from public.client_doc_type where client_id = p_client and doc_type_id = p_type) then return false; end if;
  select * into t from public.doc_type where id = p_type and office_id = v_office;
  select c.incharge_id into v_incharge from public.client c
   where c.id = p_client and c.office_id = v_office and c.archived_at is null;
  if not found then return false; end if;
  select g.id, g.state into v_group, v_state from public.client_group g
   where g.client_id = p_client and g.doc_group_id = t.doc_group_id;
  if v_group is null then
    insert into public.client_group (office_id, client_id, doc_group_id, assigned_staff_id, state)
      values (v_office, p_client, t.doc_group_id, v_incharge, 'active') returning id into v_group;
    insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
      values (v_office, v_staff, 'client_group.enabled', 'client_group', v_group::text,
              jsonb_build_object('client_id', p_client, 'doc_group_id', t.doc_group_id));
  elsif v_state = 'removed' then
    update public.client_group set state = 'active' where id = v_group;
    insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
      values (v_office, v_staff, 'client_group.enabled', 'client_group', v_group::text,
              jsonb_build_object('client_id', p_client, 'doc_group_id', t.doc_group_id));
  end if;
  insert into public.client_doc_type (office_id, client_id, doc_type_id, client_group_id, frequency,
      ask_after_months, ask_day, overdue_after_months, overdue_day, reminders, start_period_id, state)
    values (v_office, p_client, t.id, v_group, t.default_frequency, t.ask_after_months, t.ask_day,
            t.overdue_after_months, t.overdue_day, t.reminders,
            private.earliest_open_period(v_office, t.default_frequency, t.overdue_after_months, t.overdue_day,
                                         private.office_today(v_office)), coalesce(p_state, 'active'))
    returning id into v_plan;
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, v_staff, 'client_doc_type.added', 'client_doc_type', v_plan::text,
            jsonb_build_object('client_id', p_client, 'doc_type_id', t.id));
  return true;
end $$;

-- Merges proposed rows into an approved target (AC-5, AC-6): plan rows removed and the target added; every
-- document (archived included) moved with app.type_merge, one document.type_merged row each; the proposed name
-- becomes an alias; the rows are retired. 04's AFTER trigger links each moved document. Callers have locked the
-- rows and checked role, target and period fit. Returns { documents, clients, plan_added, received, plan_removed }.
create or replace function private.merge_rows(p_rows uuid[], p_target uuid, p_comment text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_office  uuid := private.current_office_id();
  v_staff   uuid := private.current_staff_id();
  v_clients uuid[];
  v_name    text;
  v_before  integer;
  v_after   integer;
  v_docs    integer := 0;
  v_n       integer;
  v_added   integer := 0;
  v_removed integer;
  v_states  jsonb;
  r uuid;
  c uuid;
begin
  select array_agg(distinct t.proposed_for_client_id) into v_clients from public.doc_type t where t.id = any (p_rows);
  select t.name into v_name from public.doc_type t where t.id = p_rows[1]; -- the earliest row's spelling
  -- Each client's proposed plan row state before the decision (a client has one row per item: names are unique per
  -- group per client). 'active' wins if, unusually, there are several.
  select jsonb_object_agg(client_id, st) into v_states from (
    select r2.client_id, (array_agg(r2.state order by r2.state))[1]::text as st
      from public.client_doc_type r2 where r2.doc_type_id = any (p_rows) group by r2.client_id) x;
  select count(*) into v_before from public.expected_doc
   where doc_type_id = p_target and client_id = any (v_clients) and status = 'received';

  with removed as (
    update public.client_doc_type set state = 'removed'
     where doc_type_id = any (p_rows) and state <> 'removed'
    returning id, client_id)
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    select v_office, v_staff, 'client_doc_type.removed', 'client_doc_type', id::text,
           jsonb_build_object('fields', jsonb_build_array('state'), 'client_id', client_id)
      from removed;
  get diagnostics v_removed = row_count;
  foreach c in array v_clients loop
    if private.plan_add_type(c, p_target, coalesce((v_states->>c::text)::public.plan_state, 'active')) then
      v_added := v_added + 1;
    end if;
  end loop;

  foreach r in array p_rows loop
    perform private.begin_doc_write();
    perform set_config('app.type_merge', r::text, true);
    with moved as (
      update public.document set doc_type_id = p_target
       where office_id = v_office and doc_type_id = r
      returning id, client_id)
    insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
      select v_office, v_staff, 'document.type_merged', 'document', id::text,
             jsonb_build_object('client_id', client_id, 'from_type_id', r, 'to_type_id', p_target)
        from moved;
    get diagnostics v_n = row_count;
    v_docs := v_docs + v_n;
  end loop;
  perform set_config('app.type_merge', '', true);

  update public.doc_type t set aliases = t.aliases || v_name
   where t.id = p_target and lower(t.name) <> lower(v_name)
     and not exists (select 1 from unnest(t.aliases) a where lower(a) = lower(v_name));

  perform set_config('app.type_decision', 'on', true);
  update public.doc_type set status = 'mapped', active = false, mapped_to_id = p_target,
      decided_by = v_staff, decided_at = now(), decision_comment = p_comment
   where id = any (p_rows);
  perform set_config('app.type_decision', '', true);

  select count(*) into v_after from public.expected_doc
   where doc_type_id = p_target and client_id = any (v_clients) and status = 'received';
  return jsonb_build_object('documents', v_docs, 'clients', cardinality(v_clients), 'plan_added', v_added,
                            'received', v_after - v_before, 'plan_removed', v_removed);
end $$;

create or replace function private.decision_comment(p_comment text)
returns text language plpgsql immutable set search_path = '' as $$
declare v text := nullif(btrim(coalesce(p_comment, '')), '');
begin
  if length(v) > 500 then raise exception 'COMMENT_TOO_LONG: a comment has at most 500 characters' using errcode = '23514'; end if;
  return v;
end $$;

create or replace function private.require_decider()
returns void language plpgsql stable set search_path = '' as $$
begin
  if not private.has_role(array['admin', 'manager']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: only Admin or Manager can decide proposed types' using errcode = '42501';
  end if;
end $$;

-- An approved, active, client-source type of this office that isn't part of the item.
create or replace function private.merge_target(p_target uuid, p_rows uuid[])
returns public.doc_type language plpgsql set search_path = '' as $$
declare t public.doc_type;
begin
  select * into t from public.doc_type
   where id = p_target and office_id = private.current_office_id() for share;
  if not found or t.status <> 'approved' or not t.active or t.source <> 'client' or t.id = any (p_rows) then
    raise exception 'TARGET_INVALID: merge into an approved, active type collected from the client' using errcode = '23514';
  end if;
  return t;
end $$;

-- Merge core (AC-5 … AC-7, AC-14, AC-13).
create or replace function private.decide_merge(p_type uuid, p_target uuid, p_comment text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_comment text;
  v_rows uuid[];
  t public.doc_type;
  v_bad integer;
  v_res jsonb;
begin
  perform private.require_decider();
  v_comment := private.decision_comment(p_comment);
  v_rows := private.type_item(p_type, true);
  t := private.merge_target(p_target, v_rows);
  select count(*) into v_bad from private.period_conflicts(v_rows, t.period_kind);
  if v_bad > 0 then
    raise exception 'PERIOD_KIND: % documents don''t fit a % type', v_bad, t.period_kind using errcode = '23514';
  end if;
  v_res := private.merge_rows(v_rows, t.id, v_comment);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (private.current_office_id(), private.current_staff_id(), 'doc_type.merged', 'doc_type', v_rows[1]::text,
            jsonb_build_object('doc_type_ids', to_jsonb(v_rows), 'target_id', t.id, 'documents', v_res->'documents',
                               'clients', v_res->'clients', 'plan_rows', jsonb_build_object('removed', v_res->'plan_removed',
                               'added', v_res->'plan_added')));
  perform private.notify((select array_agg(distinct x.proposed_by) from public.doc_type x where x.id = any (v_rows)),
                         'type_decision', 'doc_type', v_rows[1],
                         jsonb_build_object('decision', 'merged', 'doc_type_id', v_rows[1], 'target_id', t.id));
  return v_res - 'plan_removed';
end $$;

-- Approve / Edit & approve core (AC-2 … AC-4). edits = 02's add-type fields; absent keys keep the survivor's value.
create or replace function private.decide_approve(p jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_office  uuid := private.current_office_id();
  v_staff   uuid := private.current_staff_id();
  v_type    uuid := nullif(p->>'type_id', '')::uuid;
  e         jsonb := coalesce(p->'edits', '{}'::jsonb);
  v_comment text;
  v_rows    uuid[];
  s public.doc_type;
  n public.doc_type;
  v_id      uuid;
  v_bad     integer;
  v_res     jsonb := jsonb_build_object('documents', 0, 'clients', 1, 'plan_added', 0, 'received', 0, 'plan_removed', 0);
  v_before  integer;
  v_after   integer;
  v_old_name text;
  v_docs    integer;
  v_clients integer;
begin
  perform private.require_decider();
  v_comment := private.decision_comment(p->>'comment');
  v_rows := private.type_item(v_type, true);
  select count(*) into v_docs from public.document d where d.doc_type_id = any (v_rows);
  select count(distinct t.proposed_for_client_id) into v_clients from public.doc_type t where t.id = any (v_rows);
  select * into s from public.doc_type where id = v_rows[1];
  v_old_name := s.name;
  n := s;
  if e ? 'name' then n.name := btrim(regexp_replace(coalesce(e->>'name', ''), '\s+', ' ', 'g')); end if;
  if e ? 'doc_group_id' then n.doc_group_id := (e->>'doc_group_id')::uuid; end if;
  if e ? 'period_kind' then n.period_kind := (e->>'period_kind')::public.period_kind; end if;
  if e ? 'default_frequency' then n.default_frequency := (e->>'default_frequency')::public.frequency; end if;
  if e ? 'ask_after_months' then n.ask_after_months := (e->>'ask_after_months')::smallint; end if;
  if e ? 'ask_day' then n.ask_day := (e->>'ask_day')::smallint; end if;
  if e ? 'overdue_after_months' then n.overdue_after_months := (e->>'overdue_after_months')::smallint; end if;
  if e ? 'overdue_day' then n.overdue_day := (e->>'overdue_day')::smallint; end if;
  if e ? 'registration_kind' then n.registration_kind := (e->>'registration_kind')::public.registration_kind; end if;
  if e ? 'reminders' then n.reminders := coalesce((e->>'reminders')::boolean, false); end if;
  if e ? 'aliases' then
    n.aliases := coalesce((select array_agg(distinct btrim(x)) from jsonb_array_elements_text(e->'aliases') x
                            where btrim(x) <> ''), '{}');
  end if;
  if lower(n.name) <> lower(v_old_name)
     and not exists (select 1 from unnest(n.aliases) a where lower(a) = lower(v_old_name)) then
    n.aliases := n.aliases || v_old_name; -- renamed: the proposed name stays findable (AC-3)
  end if;
  if length(n.name) not between 1 and 120 then
    raise exception 'NAME_INVALID: a type name has 1–120 characters' using errcode = '23514';
  end if;
  if not exists (select 1 from public.doc_group g where g.id = n.doc_group_id and g.office_id = v_office and g.active) then
    raise exception 'NOT_FOUND: group' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.doc_type t where t.office_id = v_office and t.doc_group_id = n.doc_group_id
              and lower(t.name) = lower(n.name) and t.status = 'approved') then
    raise exception 'DUPLICATE_TYPE: an approved type with this name already exists in this group' using errcode = '23505';
  end if;
  select count(*) into v_bad from private.period_conflicts(v_rows, n.period_kind);
  if v_bad > 0 then
    raise exception 'PERIOD_KIND: % documents don''t fit a % type', v_bad, n.period_kind using errcode = '23514';
  end if;

  if n.doc_group_id = s.doc_group_id then
    -- Same group: the survivor itself becomes the approved type.
    perform set_config('app.type_decision', 'on', true);
    update public.doc_type set name = n.name, aliases = n.aliases, period_kind = n.period_kind,
        default_frequency = n.default_frequency, ask_after_months = n.ask_after_months, ask_day = n.ask_day,
        overdue_after_months = n.overdue_after_months, overdue_day = n.overdue_day,
        registration_kind = n.registration_kind, reminders = n.reminders,
        status = 'approved', active = true, proposed_for_client_id = null,
        decided_by = v_staff, decided_at = now(), decision_comment = v_comment
     where id = s.id;
    perform set_config('app.type_decision', '', true);
    v_id := s.id;
    select count(*) into v_before from public.expected_doc where doc_type_id = v_id and status = 'received';
    -- AC-4: the survivor's plan row takes the approved schedule (state kept; 04's triggers generate if active).
    with changed as (
      update public.client_doc_type r
         set frequency = n.default_frequency, ask_after_months = n.ask_after_months, ask_day = n.ask_day,
             overdue_after_months = n.overdue_after_months, overdue_day = n.overdue_day, reminders = n.reminders,
             start_period_id = case when n.default_frequency = 'as_needed' then r.start_period_id
                                    else private.earliest_open_period(v_office, n.default_frequency, n.overdue_after_months,
                                                                      n.overdue_day, private.office_today(v_office)) end
       where r.doc_type_id = v_id
         and (r.frequency, r.ask_after_months, r.ask_day, r.overdue_after_months, r.overdue_day, r.reminders)
             is distinct from
             (n.default_frequency, n.ask_after_months, n.ask_day, n.overdue_after_months, n.overdue_day, n.reminders)
      returning r.id, r.client_id)
    insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
      select v_office, v_staff, 'client_doc_type.updated', 'client_doc_type', id::text,
             jsonb_build_object('fields', jsonb_build_array('frequency', 'schedule', 'reminders', 'start_period_id'),
                                'client_id', client_id)
        from changed;
    select count(*) into v_after from public.expected_doc where doc_type_id = v_id and status = 'received';
    if cardinality(v_rows) > 1 then
      v_res := private.merge_rows(v_rows[2:], v_id, v_comment);
    end if;
    v_res := jsonb_set(v_res, '{received}', to_jsonb((v_res->>'received')::integer + v_after - v_before));
  else
    -- Group change: plan rows can't move (02), so a new approved type in the new group takes the whole item.
    insert into public.doc_type (office_id, doc_group_id, code, name, aliases, period_kind, default_frequency, source,
        ask_after_months, ask_day, overdue_after_months, overdue_day, registration_kind, reminders, status, proposed_by, active)
      values (v_office, n.doc_group_id, 't_' || replace(gen_random_uuid()::text, '-', ''), n.name, n.aliases, n.period_kind,
              n.default_frequency, 'client', n.ask_after_months, n.ask_day, n.overdue_after_months, n.overdue_day,
              n.registration_kind, n.reminders, 'approved', s.proposed_by, true)
      returning id into v_id;
    perform set_config('app.type_decision', 'on', true);
    update public.doc_type set decided_by = v_staff, decided_at = now(), decision_comment = v_comment where id = v_id;
    perform set_config('app.type_decision', '', true);
    -- The proposed name is the new type's own name or already an alias; merge_rows won't add it twice.
    v_res := private.merge_rows(v_rows, v_id, v_comment);
  end if;

  v_res := v_res || jsonb_build_object('documents', v_docs, 'clients', v_clients);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, v_staff, 'doc_type.approved', 'doc_type', v_rows[1]::text,
            jsonb_build_object('doc_type_ids', to_jsonb(v_rows), 'type_id', v_id, 'documents', v_res->'documents',
                               'clients', v_res->'clients', 'plan_rows', jsonb_build_object('removed', v_res->'plan_removed',
                               'added', v_res->'plan_added'), 'fields',
                               (select coalesce(jsonb_agg(k), '[]') from jsonb_object_keys(e) k)));
  perform private.notify((select array_agg(distinct x.proposed_by) from public.doc_type x where x.id = any (v_rows)),
                         'type_decision', 'doc_type', v_rows[1],
                         jsonb_strip_nulls(jsonb_build_object('decision', 'approved', 'doc_type_id', v_rows[1],
                           'target_id', case when v_id <> v_rows[1] then v_id end)));
  return (v_res - 'plan_removed') || jsonb_build_object('type_id', v_id);
end $$;

revoke all on function private.type_item(uuid, boolean), private.period_conflicts(uuid[], public.period_kind),
  private.plan_add_type(uuid, uuid, public.plan_state), private.merge_rows(uuid[], uuid, text), private.decision_comment(text),
  private.require_decider(), private.merge_target(uuid, uuid[]), private.decide_merge(uuid, uuid, text),
  private.decide_approve(jsonb) from public, anon;
grant execute on function private.type_item(uuid, boolean), private.period_conflicts(uuid[], public.period_kind),
  private.plan_add_type(uuid, uuid, public.plan_state), private.merge_rows(uuid[], uuid, text), private.decision_comment(text),
  private.require_decider(), private.merge_target(uuid, uuid[]), private.decide_merge(uuid, uuid, text),
  private.decide_approve(jsonb) to authenticated;

-- ── 5. Public functions (SECURITY INVOKER: RLS and column grants apply as the caller) ──────────────────

-- The queue (AC-1): one item per group + name, oldest first. Admin/Manager only (Raja 2026-10-02 12:57).
create or replace function public.proposal_queue()
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_office uuid := private.current_office_id(); v jsonb;
begin
  perform private.require_decider();
  with rows as (
    select t.id, t.name, t.doc_group_id, t.proposed_by, t.proposed_for_client_id, t.created_at,
           first_value(t.id) over w as survivor, first_value(t.name) over w as item_name
      from public.doc_type t
     where t.office_id = v_office and t.status = 'proposed'
    window w as (partition by t.doc_group_id, lower(t.name) order by t.created_at, t.id)
  ), items as (
    select r.survivor, min(r.item_name) as name, min(r.doc_group_id::text)::uuid as doc_group_id,
           array_agg(r.id order by r.created_at, r.id) as type_ids,
           array_agg(distinct r.proposed_by) as proposed_by,
           min(r.created_at) as proposed_at,
           array_agg(distinct r.proposed_for_client_id) as client_ids
      from rows r group by r.survivor
  )
  select jsonb_build_object(
    'waiting', (select count(*) from items),
    'items', coalesce(jsonb_agg(jsonb_build_object(
        'type_id', i.survivor, 'type_ids', to_jsonb(i.type_ids), 'name', i.name, 'doc_group_id', i.doc_group_id,
        'group_name', g.name, 'proposed_by', to_jsonb(i.proposed_by), 'proposed_at', i.proposed_at,
        'client_count', cardinality(i.client_ids),
        'clients', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.name)
                               from public.client c where c.id = any (i.client_ids)), '[]'::jsonb),
        'document_count', (select count(*) from public.document d where d.doc_type_id = any (i.type_ids)))
      order by i.proposed_at, i.survivor), '[]'::jsonb))
    into v
    from items i join public.doc_group g on g.id = i.doc_group_id;
  return v;
end $$;

-- AC-8 / AC-7 / AC-3: what a decision would do, without writing. The decision runs for real inside a
-- sub-transaction that is then rolled back, so the numbers are the decision's own (spec test "preview = effect").
-- A period conflict is reported (with the documents) instead of running.
create or replace function public.preview_type_decision(p jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_action text := p->>'action';
  v_type   uuid := nullif(p->>'type_id', '')::uuid;
  v_target uuid := nullif(p->>'target_id', '')::uuid;
  v_rows   uuid[];
  v_kind   public.period_kind;
  v_conf   jsonb;
  v_res    jsonb;
begin
  perform private.require_decider();
  if v_action not in ('approve', 'merge') then raise exception 'INVALID: action' using errcode = '22023'; end if;
  v_rows := private.type_item(v_type, false);
  if v_action = 'merge' then
    v_kind := (private.merge_target(v_target, v_rows)).period_kind;
  else
    select coalesce((p->'edits'->>'period_kind')::public.period_kind, t.period_kind) into v_kind
      from public.doc_type t where t.id = v_rows[1];
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('document_id', c.document_id, 'doc_code', c.doc_code) order by c.doc_code), '[]')
    into v_conf from private.period_conflicts(v_rows, v_kind) c;
  if jsonb_array_length(v_conf) > 0 then
    return jsonb_build_object(
      'documents', (select count(*) from public.document d where d.doc_type_id = any (v_rows)),
      'clients', (select count(distinct t.proposed_for_client_id) from public.doc_type t where t.id = any (v_rows)),
      'plan_added', 0, 'received', 0, 'conflicts', v_conf);
  end if;
  begin
    if v_action = 'merge' then
      v_res := private.decide_merge(v_type, v_target, null);
    else
      v_res := private.decide_approve(jsonb_build_object('type_id', v_type, 'edits', coalesce(p->'edits', '{}'::jsonb)));
    end if;
    raise exception 'PREVIEW_ROLLBACK';
  exception when others then
    if sqlerrm <> 'PREVIEW_ROLLBACK' then raise; end if;
  end;
  return jsonb_build_object('documents', v_res->'documents', 'clients', v_res->'clients',
                            'plan_added', v_res->'plan_added', 'received', v_res->'received', 'conflicts', '[]'::jsonb);
end $$;

-- AC-2 / AC-3 / AC-4. p = { type_id, edits?, comment? } → { type_id (the approved type), documents, clients, plan_added, received }
create or replace function public.approve_proposed_type(p jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  return private.decide_approve(p);
end $$;

-- AC-5 … AC-7 → { documents, clients, plan_added, received }
create or replace function public.merge_proposed_type(p_type uuid, p_target uuid, p_comment text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  return private.decide_merge(p_type, p_target, p_comment);
end $$;

-- AC-9: only an item with no documents (archived included); reason 1–500; rows retired, plan rows removed.
create or replace function public.reject_proposed_type(p_type uuid, p_comment text)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_office  uuid := private.current_office_id();
  v_staff   uuid := private.current_staff_id();
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  v_rows    uuid[];
  v_docs    integer;
  v_removed integer;
begin
  perform private.require_decider();
  if v_comment is null or length(v_comment) > 500 then
    raise exception 'REASON_REQUIRED: give a reason of 1–500 characters' using errcode = '23514';
  end if;
  v_rows := private.type_item(p_type, true);
  select count(*) into v_docs from public.document d where d.doc_type_id = any (v_rows);
  if v_docs > 0 then
    raise exception 'HAS_DOCUMENTS: % documents use this type; merge it into an approved type instead', v_docs using errcode = 'P0001';
  end if;
  with removed as (
    update public.client_doc_type set state = 'removed'
     where doc_type_id = any (v_rows) and state <> 'removed'
    returning id, client_id)
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    select v_office, v_staff, 'client_doc_type.removed', 'client_doc_type', id::text,
           jsonb_build_object('fields', jsonb_build_array('state'), 'client_id', client_id)
      from removed;
  get diagnostics v_removed = row_count;
  perform set_config('app.type_decision', 'on', true);
  update public.doc_type set status = 'rejected', active = false, decided_by = v_staff, decided_at = now(),
      decision_comment = v_comment
   where id = any (v_rows);
  perform set_config('app.type_decision', '', true);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, v_staff, 'doc_type.rejected', 'doc_type', v_rows[1]::text,
            jsonb_build_object('doc_type_ids', to_jsonb(v_rows), 'documents', 0,
                               'clients', (select count(distinct t.proposed_for_client_id) from public.doc_type t where t.id = any (v_rows)),
                               'plan_rows', jsonb_build_object('removed', v_removed, 'added', 0)));
  perform private.notify((select array_agg(distinct x.proposed_by) from public.doc_type x where x.id = any (v_rows)),
                         'type_decision', 'doc_type', v_rows[1],
                         jsonb_build_object('decision', 'rejected', 'doc_type_id', v_rows[1]));
end $$;

-- Metric 3 (AC-16): classified, non-archived documents under approved types ÷ all classified, non-archived;
-- plus the queue: items waiting and the oldest one's age in office days. Admin/Manager only.
create or replace function public.catalogue_metric()
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_office uuid := private.current_office_id(); v_approved bigint; v_total bigint; v_oldest timestamptz;
begin
  if not private.has_role(array['admin', 'manager']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: only Admin or Manager can see the catalogue metric' using errcode = '42501';
  end if;
  select count(*) filter (where t.status = 'approved'), count(*) into v_approved, v_total
    from public.document d join public.doc_type t on t.id = d.doc_type_id
   where d.office_id = v_office and d.classified_at is not null and d.archived_at is null;
  select min(t.created_at) into v_oldest from public.doc_type t where t.office_id = v_office and t.status = 'proposed';
  return jsonb_build_object(
    'approved', v_approved, 'total', v_total,
    'approved_pct', case when v_total = 0 then null else round(100.0 * v_approved / v_total, 1) end,
    'waiting', (select count(distinct (t.doc_group_id, lower(t.name))) from public.doc_type t
                 where t.office_id = v_office and t.status = 'proposed'),
    'oldest_days', case when v_oldest is null then null
                        else private.office_today(v_office) - (v_oldest at time zone 'Asia/Kolkata')::date end);
end $$;

revoke all on function public.proposal_queue(), public.preview_type_decision(jsonb), public.approve_proposed_type(jsonb),
  public.merge_proposed_type(uuid, uuid, text), public.reject_proposed_type(uuid, text), public.catalogue_metric()
  from public, anon;
grant execute on function public.proposal_queue(), public.preview_type_decision(jsonb), public.approve_proposed_type(jsonb),
  public.merge_proposed_type(uuid, uuid, text), public.reject_proposed_type(uuid, text), public.catalogue_metric()
  to authenticated;

-- ── 6. reset_test_office: 07's body + notifications and decided proposals (lines marked "05") ──────────
create or replace function public.reset_test_office(p_office_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.office where id = p_office_id and is_test) then
    raise exception 'NOT_TEST_OFFICE: only offices flagged is_test can be reset' using errcode = '42501';
  end if;
  perform set_config('app.purge_office', p_office_id::text, true);
  delete from public.notification        where office_id = p_office_id; -- 05
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
  delete from public.doc_type            where office_id = p_office_id and status <> 'approved'; -- 05: + mapped, rejected
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
