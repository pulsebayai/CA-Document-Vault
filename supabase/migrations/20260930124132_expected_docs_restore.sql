-- Feature 04, R1 (Raja 2026-09-30, from the step-2 SQL review): switching a removed row or group back on restores
-- its "Removed from plan" items that are not overdue yet (overdue from > today). Items already overdue stay waived,
-- the same line resume draws for generation (AC-12). Test first: expected-plan.test.ts › "(R1)".
-- Changes only 04's two plan triggers and adds one definer helper; schema lock: 04.

-- System undo of removed_from_plan waivers: back to pending, then status from linked documents (a document filed
-- while waived makes it received). One activity row per item, actor = system, code only (AC-18).
create or replace function private.restore_removed_items(p_ids uuid[], p_today date)
returns void language plpgsql security definer set search_path = '' as $$
declare v_done uuid[]; i uuid;
begin
  if p_ids is null or cardinality(p_ids) = 0 then return; end if;
  with w as (
    update public.expected_doc e
       set status = 'pending', waived_code = null, waived_reason = null, waived_by = null, waived_at = null
     where e.id = any (p_ids) and e.status = 'waived' and e.waived_code = 'removed_from_plan' and e.overdue_from > p_today
    returning e.id, e.office_id, e.client_id
  ), a as (
    insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    select w.office_id, null, 'expected.waive_undone', 'expected_doc', w.id::text,
           jsonb_build_object('code', 'removed_from_plan', 'client_id', w.client_id)
      from w
  )
  select array_agg(w.id) into v_done from w;
  foreach i in array coalesce(v_done, '{}') loop
    perform private.recompute_expected(i, null);
  end loop;
end $$;

-- Row: as before, plus restore when the row leaves 'removed' (its own re-add, or re-enabling its group, which
-- restores each row's previous state) while its group is not removed.
create or replace function private.client_doc_type_after_expected()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  if (select auth.uid()) is not null and new.office_id is distinct from private.current_office_id() then return null; end if;
  if tg_op = 'UPDATE' then
    if new.state = 'removed' and old.state <> 'removed' then
      select array_agg(id) into v_ids from public.expected_doc where client_doc_type_id = new.id and status = 'pending';
      perform private.auto_waive(v_ids, 'removed_from_plan');
    elsif old.state = 'removed' and new.state <> 'removed'
          and exists (select 1 from public.client_group g where g.id = new.client_group_id and g.state <> 'removed') then
      select array_agg(id) into v_ids from public.expected_doc
       where client_doc_type_id = new.id and status = 'waived' and waived_code = 'removed_from_plan';
      perform private.restore_removed_items(v_ids, private.office_today(new.office_id));
    end if;
    if new.start_period_id is not null and new.start_period_id is distinct from old.start_period_id then
      select array_agg(e.id) into v_ids
        from public.expected_doc e join public.period p on p.id = e.period_id
       where e.client_doc_type_id = new.id and e.status = 'pending'
         and p.start_date < (select sp.start_date from public.period sp where sp.id = new.start_period_id);
      perform private.auto_waive(v_ids, 'before_start');
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
    perform private.generate_expected(new.office_id, new.client_id, new.id, private.office_today(new.office_id));
  end if;
  return null;
end $$;

-- Group: as before, plus restore when the group leaves 'removed', for its rows that are not removed themselves
-- (rows switched off with the group are still 'removed' here; their own trigger restores them as they come back).
create or replace function private.client_group_after_expected()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  if (select auth.uid()) is not null and new.office_id is distinct from private.current_office_id() then return null; end if;
  if new.state = 'removed' and old.state <> 'removed' then
    select array_agg(e.id) into v_ids from public.expected_doc e join public.client_doc_type r on r.id = e.client_doc_type_id
     where r.client_group_id = new.id and e.status = 'pending';
    perform private.auto_waive(v_ids, 'removed_from_plan');
  else
    if old.state = 'removed' and new.state <> 'removed' then
      select array_agg(e.id) into v_ids from public.expected_doc e join public.client_doc_type r on r.id = e.client_doc_type_id
       where r.client_group_id = new.id and r.state <> 'removed' and e.status = 'waived' and e.waived_code = 'removed_from_plan';
      perform private.restore_removed_items(v_ids, private.office_today(new.office_id));
    end if;
    if new.state = 'active' and old.state <> 'active' then
      perform private.generate_expected(new.office_id, new.client_id, null, private.office_today(new.office_id));
    end if;
  end if;
  return null;
end $$;

revoke all on function private.restore_removed_items(uuid[], date) from public, anon, authenticated;
