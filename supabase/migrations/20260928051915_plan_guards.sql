-- Feature 02 step 13 — fixes for the pre-PR review (tests: tests/rls/plan-guards.test.ts).
-- Additive: replaces one function, adds two triggers. No data change.

-- 1. AC-20 / S2: pause and resume are Admin/Manager only. Switching a paused group off (→ removed) and on
--    again (→ active) was a way round that for Staff, so switching off a paused group is Admin/Manager only.
create or replace function public.disable_client_group(p_client_id uuid, p_doc_group_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_group uuid; v_state public.plan_state;
begin
  if not private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: Limited users cannot change collection plans' using errcode = '42501';
  end if;
  select g.id, g.state into v_group, v_state from public.client_group g
    where g.client_id = p_client_id and g.doc_group_id = p_doc_group_id and g.office_id = private.current_office_id();
  if not found then raise exception 'NOT_FOUND: group is not enabled for this client' using errcode = 'P0002'; end if;
  if v_state = 'paused' and not private.is_privileged() then
    raise exception 'ROLE_REQUIRED: only Admin or Manager can switch off a paused group' using errcode = '42501';
  end if;
  perform set_config('app.plan_bulk', 'on', true);
  update public.client_doc_type set state_before_disable = state, state = 'removed'
   where client_group_id = v_group and state_before_disable is null;
  update public.client_group set state = 'removed' where id = v_group and state <> 'removed';
  perform set_config('app.plan_bulk', 'off', true);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (private.current_office_id(), private.current_staff_id(), 'client_group.disabled', 'client_group', v_group::text,
            jsonb_build_object('client_id', p_client_id, 'doc_group_id', p_doc_group_id));
end $$;

-- 2. AC-10 / AC-12: groups are assigned to the incharge when enabled. When the incharge changes, groups
--    still assigned to the old incharge follow the new one (groups a Manager assigned to someone else stay).
--    Otherwise a Limited ex-incharge keeps seeing the client through those groups. A trigger, so every path
--    (update_client, a direct update) is covered. Runs as the caller: only Admin/Manager can change the
--    incharge (client_before_write), and they may assign groups.
create or replace function private.client_after_incharge_change()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_n integer;
begin
  update public.client_group set assigned_staff_id = new.incharge_id
   where client_id = new.id and office_id = new.office_id and assigned_staff_id = old.incharge_id;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
      values (new.office_id, private.current_staff_id(), 'client_group.reassigned', 'client', new.id::text,
              jsonb_build_object('client_id', new.id, 'from_staff_id', old.incharge_id, 'to_staff_id', new.incharge_id, 'groups', v_n));
  end if;
  return null;
end $$;

create trigger client_after_incharge_change after update of incharge_id on public.client
  for each row when (old.incharge_id is distinct from new.incharge_id)
  execute function private.client_after_incharge_change();

-- 3. Tenant isolation: a plan row's start period must be one of its own office's periods
--    (the FK alone accepts any office's period id).
create or replace function private.client_doc_type_period_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.start_period_id is not null and not exists (
      select 1 from public.period p where p.id = new.start_period_id and p.office_id = new.office_id) then
    raise exception 'PERIOD_OFFICE: start period belongs to another office' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger client_doc_type_period_guard before insert or update of start_period_id on public.client_doc_type
  for each row execute function private.client_doc_type_period_guard();

revoke all on function private.client_after_incharge_change(), private.client_doc_type_period_guard() from public, anon;
