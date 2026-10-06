-- Feature 05 — migration D: pre-PR review fixes (Raja 2026-10-03 14:08: "Ok to write migration D"; I-4 decisions:
-- merged name → refused with a pointer, rejected name → may be proposed again). SQL gate: pending.
--   I-1  retired (merged / rejected) types stay out of plans: a guard on client_doc_type, and the decisions clear
--        the "restore to" state of rows a switched-off group had removed; existing rows cleaned up.
--   I-4  create_proposed_type: 03's body + the lines marked "D".
--   N-1  document_before_write: 05's body (20261002081451) verbatim + the lines marked "D" (lock order).
--   N-2  merge_target locks the target FOR NO KEY UPDATE (was FOR SHARE).
--   N-3  type_item locks and collects the item's rows in one statement.
-- Every other line of the replaced functions is verbatim from its latest migration.

-- ── 1. I-1: guard ─────────────────────────────────────────────────────────────
-- A plan row whose type is merged or rejected stays removed, with nothing to restore. Runs after 02's
-- client_doc_type_before_write (trigger names fire in order), so it has the last word on state_before_disable.
-- A group re-enable restoring such a row (state_before_disable left from before this migration) keeps it removed
-- instead of failing the whole re-enable; any other attempt to switch it on, pause it or add it is refused.
create or replace function private.client_doc_type_retired_guard()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if exists (select 1 from public.doc_type t where t.id = new.doc_type_id and t.status in ('mapped', 'rejected')) then
    if new.state <> 'removed' then
      if tg_op = 'UPDATE' and old.state = 'removed' and old.state_before_disable is not null then
        new.state := 'removed';
        new.paused_at := null;
      else
        raise exception 'TYPE_RETIRED: this type was merged or rejected and can''t be collected' using errcode = '23514';
      end if;
    end if;
    new.state_before_disable := null;
  end if;
  return new;
end $$;
revoke all on function private.client_doc_type_retired_guard() from public, anon;
create trigger client_doc_type_retired_guard before insert or update on public.client_doc_type
  for each row execute function private.client_doc_type_retired_guard();

-- Existing rows of retired types (dev today): removed, nothing to restore. app.plan_bulk skips 02's role and
-- state_before_disable handling for this one statement; the guard above clears it.
select set_config('app.plan_bulk', 'on', true);
update public.client_doc_type r set state = 'removed'
  from public.doc_type t
 where t.id = r.doc_type_id and t.status in ('mapped', 'rejected')
   and (r.state <> 'removed' or r.state_before_disable is not null);
select set_config('app.plan_bulk', '', true);

-- ── 2. I-1: the decisions clear what a re-enable would restore ────────────────
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
  v_added   integer := 0;
  v_removed integer;
  v_states  jsonb;
  v_ids     uuid[] := '{}';
  v_moved   uuid[];
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
      returning id, client_id),
    logged as (
      insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
        select v_office, v_staff, 'document.type_merged', 'document', id::text,
               jsonb_build_object('client_id', client_id, 'from_type_id', r, 'to_type_id', p_target)
          from moved)
    select coalesce(array_agg(id), '{}') into v_moved from moved;
    v_ids := v_ids || v_moved;
  end loop;
  perform set_config('app.type_merge', '', true);
  v_docs := cardinality(v_ids);
  perform private.link_moved(v_ids); -- 04's linking, set-based (the AFTER trigger skipped these rows)

  update public.doc_type t set aliases = t.aliases || v_name
   where t.id = p_target and lower(t.name) <> lower(v_name)
     and not exists (select 1 from unnest(t.aliases) a where lower(a) = lower(v_name));

  perform set_config('app.type_decision', 'on', true);
  update public.doc_type set status = 'mapped', active = false, mapped_to_id = p_target,
      decided_by = v_staff, decided_at = now(), decision_comment = p_comment
   where id = any (p_rows);
  perform set_config('app.type_decision', '', true);
  -- D (review I-1): rows a switched-off group had already removed keep nothing to restore (the guard clears it).
  update public.client_doc_type set state = 'removed' where doc_type_id = any (p_rows) and state_before_disable is not null;

  select count(*) into v_after from public.expected_doc
   where doc_type_id = p_target and client_id = any (v_clients) and status = 'received';
  return jsonb_build_object('documents', v_docs, 'clients', cardinality(v_clients), 'plan_added', v_added,
                            'received', v_after - v_before, 'plan_removed', v_removed);
end $$;

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
  -- D (review I-1): nothing left for a later group re-enable to restore (the guard clears it).
  update public.client_doc_type set state = 'removed' where doc_type_id = any (v_rows) and state_before_disable is not null;
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, v_staff, 'doc_type.rejected', 'doc_type', v_rows[1]::text,
            jsonb_build_object('doc_type_ids', to_jsonb(v_rows), 'documents', 0,
                               'clients', (select count(distinct t.proposed_for_client_id) from public.doc_type t where t.id = any (v_rows)),
                               'plan_rows', jsonb_build_object('removed', v_removed, 'added', 0)));
  perform private.notify((select array_agg(distinct x.proposed_by) from public.doc_type x where x.id = any (v_rows)),
                         'type_decision', 'doc_type', v_rows[1],
                         jsonb_build_object('decision', 'rejected', 'doc_type_id', v_rows[1]));
end $$;

-- ── 3. I-4: re-proposing a retired name ───────────────────────────────────────
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
  v_target   text; -- D
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
  -- D (review I-4, Raja 2026-10-03): retired rows don't block. A name approved, or waiting for this client, is a
  -- duplicate; a name merged for this client points to its target; a rejected name may be proposed again.
  if exists (select 1 from public.doc_type t
              where t.doc_group_id = p_doc_group_id and lower(t.name) = lower(v_name)
                and (t.status = 'approved' or (t.status = 'proposed' and t.proposed_for_client_id = p_client_id))) then
    raise exception 'DUPLICATE_TYPE: a type with this name already exists in this group' using errcode = '23505';
  end if;
  select m.name into v_target from public.doc_type t join public.doc_type m on m.id = t.mapped_to_id
   where t.doc_group_id = p_doc_group_id and lower(t.name) = lower(v_name) and t.status = 'mapped'
     and t.proposed_for_client_id = p_client_id
   order by t.decided_at desc limit 1;
  if v_target is not null then
    raise exception 'MERGED_INTO: %', v_target using errcode = '23505';
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

-- ── 4. N-1: lock order when filing under a proposed type ──────────────────────
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

-- ── 5. N-2, N-3: locks in the decision helpers ────────────────────────────────
create or replace function private.type_item(p_type uuid, p_lock boolean)
returns uuid[] language plpgsql set search_path = '' as $$
declare r public.doc_type; v uuid[];
begin
  select * into r from public.doc_type where id = p_type and office_id = private.current_office_id();
  if not found then raise exception 'NOT_FOUND: document type' using errcode = 'P0002'; end if;
  if r.status = 'proposed' then
    -- D (review N-3): lock and collect in one statement, so a same-name row committed in between can't join the
    -- item unlocked.
    if p_lock then
      select array_agg(s.id order by s.created_at, s.id) into v from (
        select t.id, t.created_at from public.doc_type t
         where t.office_id = r.office_id and t.doc_group_id = r.doc_group_id and lower(t.name) = lower(r.name)
           and t.status = 'proposed'
         order by t.id for update) s;
    else
      select array_agg(t.id order by t.created_at, t.id) into v from public.doc_type t
       where t.office_id = r.office_id and t.doc_group_id = r.doc_group_id and lower(t.name) = lower(r.name)
         and t.status = 'proposed';
    end if;
    if v is not null and p_type = any (v) then return v; end if;
    select * into r from public.doc_type where id = p_type;
  end if;
  if r.decided_at is not null then
    raise exception 'ALREADY_DECIDED: %', r.decided_by using errcode = 'P0001';
  end if;
  raise exception 'NOT_PROPOSED: this type is not waiting for a decision' using errcode = 'P0001';
end $$;

create or replace function private.merge_target(p_target uuid, p_rows uuid[])
returns public.doc_type language plpgsql set search_path = '' as $$
declare t public.doc_type;
begin
  select * into t from public.doc_type
   where id = p_target and office_id = private.current_office_id() for no key update; -- D (review N-2): merge_rows updates its aliases; two merges into one target queue instead of deadlocking
  if not found or t.status <> 'approved' or not t.active or t.source <> 'client' or t.id = any (p_rows) then
    raise exception 'TARGET_INVALID: merge into an approved, active type collected from the client' using errcode = '23514';
  end if;
  return t;
end $$;
