-- Feature 04 — pre-PR review follow-ups (sdlc-reviewer 2026-10-01). Schema lock: 04. Tests: tests/rls/expected-followups.test.ts.
--
-- 1. (Important 1) Changing a plan row's frequency left its pending items open forever (monthly → "as needed" kept
--    every pending month Overdue in the Clients list, metric 1 and the Expected count; monthly → quarterly kept the
--    months next to the new quarter item). Now: pending items whose period kind no longer matches the new frequency
--    (all of them for "as needed") are waived with a new system code `schedule_changed` ("Schedule changed").
--    Changing back restores that row's `schedule_changed` items of the matching kind whose overdue-from is still ahead.
-- 2. (Nit 1) System waivers come back when their cause goes away, on R1's line (only items not yet overdue):
--    a re-activated GSTIN/TAN restores its `registration_inactive` items; moving the start period earlier restores
--    `before_start` items from the new start on.
-- 3. (Nit 2) private.recompute_expected checks the tenant first, like every other definer helper.
-- 4. (Nit 3) private.earliest_open_period falls back to the period containing p_today (the office clock) before the
--    real-date private.current_period_id.
-- Activity: restores write `expected.waive_undone` (actor null, code only), as R1 does.

-- ── 1a. New waiver code ─────────────────────────────────────────────────────
alter table public.expected_doc drop constraint expected_doc_waived_code_check;
alter table public.expected_doc add constraint expected_doc_waived_code_check
  check (waived_code in ('manual', 'removed_from_plan', 'registration_inactive', 'before_start', 'schedule_changed'));

create or replace function private.auto_waive(p_ids uuid[], p_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_reason text := case p_code when 'removed_from_plan' then 'Removed from plan'
                                     when 'registration_inactive' then 'Registration inactive'
                                     when 'before_start' then 'Before start period'
                                     when 'schedule_changed' then 'Schedule changed' end;
begin
  if p_ids is null or cardinality(p_ids) = 0 then return; end if;
  with w as (
    update public.expected_doc e
       set status = 'waived', waived_code = p_code, waived_reason = v_reason, waived_by = null, waived_at = now()
     where e.id = any (p_ids) and e.status = 'pending'
    returning e.id, e.office_id, e.client_id
  )
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
  select w.office_id, null, 'expected.auto_waived', 'expected_doc', w.id::text, jsonb_build_object('code', p_code, 'client_id', w.client_id)
    from w;
end $$;

-- ── 2. Restore system waivers of one code whose overdue-from date is still ahead (generalises R1's helper) ──
create or replace function private.restore_waived_items(p_ids uuid[], p_code text, p_today date)
returns void language plpgsql security definer set search_path = '' as $$
declare v_done uuid[]; i uuid;
begin
  if p_ids is null or cardinality(p_ids) = 0 then return; end if;
  with w as (
    update public.expected_doc e
       set status = 'pending', waived_code = null, waived_reason = null, waived_by = null, waived_at = null
     where e.id = any (p_ids) and e.status = 'waived' and e.waived_code = p_code and e.overdue_from > p_today
    returning e.id, e.office_id, e.client_id
  ), a as (
    insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    select w.office_id, null, 'expected.waive_undone', 'expected_doc', w.id::text,
           jsonb_build_object('code', p_code, 'client_id', w.client_id)
      from w
  )
  select array_agg(w.id) into v_done from w;
  foreach i in array coalesce(v_done, '{}') loop
    perform private.recompute_expected(i, null); -- linked documents decide received
  end loop;
end $$;
revoke all on function private.restore_waived_items(uuid[], text, date) from public, anon, authenticated;

-- ── 1b + 2. Plan-row trigger (bulk-defer version + frequency change + start moved earlier) ──
create or replace function private.client_doc_type_after_expected()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[]; v_today date;
begin
  if (select auth.uid()) is not null and new.office_id is distinct from private.current_office_id() then return null; end if;
  if tg_op = 'UPDATE' then
    v_today := private.office_today(new.office_id);
    if new.state = 'removed' and old.state <> 'removed' then
      select array_agg(id) into v_ids from public.expected_doc where client_doc_type_id = new.id and status = 'pending';
      perform private.auto_waive(v_ids, 'removed_from_plan');
    elsif old.state = 'removed' and new.state <> 'removed'
          and exists (select 1 from public.client_group g where g.id = new.client_group_id and g.state <> 'removed') then
      select array_agg(id) into v_ids from public.expected_doc
       where client_doc_type_id = new.id and status = 'waived' and waived_code = 'removed_from_plan';
      perform private.restore_removed_items(v_ids, v_today);
    end if;
    -- Frequency changed: items of the old kind no longer apply (all of them for "as needed"); back again → restore.
    if new.frequency is distinct from old.frequency then
      select array_agg(e.id) into v_ids
        from public.expected_doc e join public.period p on p.id = e.period_id
       where e.client_doc_type_id = new.id and e.status = 'pending'
         and (new.frequency = 'as_needed' or p.kind <> private.frequency_kind(new.frequency));
      perform private.auto_waive(v_ids, 'schedule_changed');
      if new.frequency <> 'as_needed' then
        select array_agg(e.id) into v_ids
          from public.expected_doc e join public.period p on p.id = e.period_id
         where e.client_doc_type_id = new.id and e.status = 'waived' and e.waived_code = 'schedule_changed'
           and p.kind = private.frequency_kind(new.frequency);
        perform private.restore_waived_items(v_ids, 'schedule_changed', v_today);
      end if;
    end if;
    if new.start_period_id is not null and new.start_period_id is distinct from old.start_period_id then
      select array_agg(e.id) into v_ids
        from public.expected_doc e join public.period p on p.id = e.period_id
       where e.client_doc_type_id = new.id and e.status = 'pending'
         and p.start_date < (select sp.start_date from public.period sp where sp.id = new.start_period_id);
      perform private.auto_waive(v_ids, 'before_start');
      -- Start moved earlier: "Before start period" items from the new start on come back (if still ahead).
      select array_agg(e.id) into v_ids
        from public.expected_doc e join public.period p on p.id = e.period_id
       where e.client_doc_type_id = new.id and e.status = 'waived' and e.waived_code = 'before_start'
         and p.start_date >= (select sp.start_date from public.period sp where sp.id = new.start_period_id);
      perform private.restore_waived_items(v_ids, 'before_start', v_today);
    end if;
    if new.ask_after_months is not null
       and (new.ask_after_months, new.ask_day, new.overdue_after_months, new.overdue_day)
           is distinct from (old.ask_after_months, old.ask_day, old.overdue_after_months, old.overdue_day) then
      update public.expected_doc e
         set ask_on = private.offset_date(p.end_date, new.ask_after_months, new.ask_day),
             overdue_from = private.offset_date(p.end_date, new.overdue_after_months, new.overdue_day)
        from public.period p
       where p.id = e.period_id and e.client_doc_type_id = new.id and e.status = 'pending';
    end if;
  end if;
  if new.state = 'active' then
    if private.expected_deferred() then
      perform private.expected_note_client(new.client_id);
    else
      perform private.generate_expected(new.office_id, new.client_id, new.id, private.office_today(new.office_id));
    end if;
  end if;
  return null;
end $$;

-- ── 2. Registration trigger (bulk-defer version + re-activation restores) ──
create or replace function private.client_registration_after_expected()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  if (select auth.uid()) is not null and new.office_id is distinct from private.current_office_id() then return null; end if;
  if new.active and (tg_op = 'INSERT' or not old.active) then
    if tg_op = 'UPDATE' then
      select array_agg(id) into v_ids from public.expected_doc
       where registration_id = new.id and status = 'waived' and waived_code = 'registration_inactive';
      perform private.restore_waived_items(v_ids, 'registration_inactive', private.office_today(new.office_id));
    end if;
    if private.expected_deferred() then
      perform private.expected_note_client(new.client_id);
    else
      perform private.generate_expected(new.office_id, new.client_id, null, private.office_today(new.office_id));
    end if;
  elsif tg_op = 'UPDATE' and old.active and not new.active then
    select array_agg(id) into v_ids from public.expected_doc where registration_id = new.id and status = 'pending';
    perform private.auto_waive(v_ids, 'registration_inactive');
  end if;
  return null;
end $$;

-- ── 3. Tenant check in recompute_expected (otherwise unchanged) ──
create or replace function private.recompute_expected(p_item uuid, p_new_doc uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare e public.expected_doc; v_doc uuid; v_on date;
begin
  select * into e from public.expected_doc where id = p_item for update;
  if not found or e.status = 'waived' then return; end if;
  if (select auth.uid()) is not null and e.office_id is distinct from private.current_office_id() then return; end if;
  if e.status = 'received' then
    select d.received_on into v_on from public.document d
     where d.id = e.completed_by_document_id and d.expected_doc_id = e.id and d.archived_at is null;
    if found then
      if v_on is distinct from e.received_on then
        update public.expected_doc set received_on = v_on where id = e.id;
      end if;
      return;
    end if;
  end if;
  select d.id, d.received_on into v_doc, v_on from public.document d
   where d.expected_doc_id = e.id and d.archived_at is null
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

-- ── 4. Start-period fallback uses the office clock first ──
create or replace function private.earliest_open_period(p_office uuid, p_frequency public.frequency,
  p_overdue_after integer, p_overdue_day integer, p_today date)
returns uuid language sql stable security invoker set search_path = '' as $$
  select coalesce(
    (select p.id from public.period p
      where p.office_id = p_office and p.kind = private.frequency_kind(p_frequency)
        and private.offset_date(p.end_date, p_overdue_after, p_overdue_day) > p_today
      order by p.start_date limit 1),
    (select p.id from public.period p
      where p.office_id = p_office and p.kind = private.frequency_kind(p_frequency)
        and p_today between p.start_date and p.end_date
      limit 1),
    private.current_period_id(p_office, p_frequency))
$$;
