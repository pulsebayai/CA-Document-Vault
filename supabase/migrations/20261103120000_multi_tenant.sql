-- Feature 17 — multi-tenant foundation (spec "Data model changes" 1–5; ACs 9–11, 14–20).
-- The data layer is already per firm (office_id + RLS everywhere). This migration adds only the shell around it:
--   1. private.deployment   — the deployment's tenancy mode, written by the bootstrap (no app grants)
--   2. office_single_guard  — in single mode, the database refuses a second real (non-test) office
--   3. office_update_admin  — Admins edit their own firm's name and branch (column grant: those two only)
--   4. bootstrap_office     — create / reuse / claim a firm's office + seed it (service role only)
--   5. test_tenancy_probe   — proves the guard and single-mode bootstrap in rolled-back blocks (service role only)
-- No business table, RLS policy on a business table or business function changes.

-- 1. Deployment mode -------------------------------------------------------------------------------------------
create table private.deployment (
  id     boolean primary key default true check (id),
  mode   text not null check (mode in ('multi', 'single')),
  set_at timestamptz not null default now()
);
revoke all on private.deployment from public, anon, authenticated;

-- 2. Single-office guard (AC-19, AC-20) -------------------------------------------------------------------------
-- Counts only real offices: automated-test offices (is_test) are created in every mode.
create or replace function private.office_single_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.is_test then return new; end if;
  if tg_op = 'UPDATE' and not old.is_test then return new; end if; -- a real office stays real; only test → real counts
  if coalesce((select d.mode from private.deployment d), 'multi') <> 'single' then return new; end if;
  if exists (select 1 from public.office o where not o.is_test and o.id <> new.id) then
    raise exception 'SINGLE_OFFICE: this deployment holds one firm' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function private.office_single_guard() from public, anon, authenticated;

create trigger office_single_guard before insert or update of is_test on public.office
  for each row execute function private.office_single_guard();

-- 3. Admins edit their own firm's name and branch (AC-9–11) -----------------------------------------------------
-- The column grant limits what any update can touch; the policy limits who and which row.
grant update (name, branch) on public.office to authenticated;
create policy office_update_admin on public.office for update to authenticated
  using (id = (select private.current_office_id()) and (select private.has_role('{admin}'::public.staff_role[])))
  with check (id = (select private.current_office_id()) and (select private.has_role('{admin}'::public.staff_role[])));

-- 4. Bootstrap a firm (AC-14–18) -------------------------------------------------------------------------------
-- p = {name, branch?, mode, test?}. mode = the TENANCY_MODE the operator's script ran with.
--   reuse  : an office with exactly this name and no staff (a re-run after a failed invite; Kushal's seeded row)
--   claim  : single mode only — the one real office, with no staff, gets this name (the 2026-09-25 seed row)
--   create : otherwise; the guard refuses a second real office in single mode
-- Refused: a firm that already has staff (ALREADY_SET_UP); a mode different from the deployment's (DEPLOYMENT_MODE).
-- test = true (automated tests, the script's --test): works only on test offices and never reads or writes the
-- deployment mode, so dev (shared, never bootstrapped for real) keeps no deployment row and gains no real firm.
create or replace function public.bootstrap_office(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_name   text := btrim(coalesce(p->>'name', ''));
  v_branch text := nullif(btrim(coalesce(p->>'branch', '')), '');
  v_mode   text := lower(btrim(coalesce(p->>'mode', '')));
  v_test   boolean := coalesce((p->>'test')::boolean, false);
  v_dep    text;
  v_office uuid;
  v_result text;
  v_real   integer;
begin
  if length(v_name) not between 1 and 120 then raise exception 'NAME_INVALID' using errcode = '22023'; end if;
  if v_branch is not null and length(v_branch) > 120 then raise exception 'BRANCH_INVALID' using errcode = '22023'; end if;
  if v_mode not in ('multi', 'single') then raise exception 'MODE_INVALID' using errcode = '22023'; end if;

  if not v_test then
    select d.mode into v_dep from private.deployment d for update;
    if v_dep is null then
      insert into private.deployment (mode) values (v_mode);
    elsif v_dep <> v_mode then
      raise exception 'DEPLOYMENT_MODE: this deployment is %', v_dep using errcode = '22023';
    end if;
  end if;

  select o.id into v_office from public.office o
   where o.is_test = v_test and o.name = v_name
   order by o.created_at limit 1 for update;
  if v_office is not null then
    if exists (select 1 from public.staff_user s where s.office_id = v_office) then
      raise exception 'ALREADY_SET_UP: this firm already has staff' using errcode = '23505';
    end if;
    if v_branch is not null then update public.office set branch = v_branch where id = v_office; end if;
    v_result := 'reused';
  elsif v_mode = 'single' and not v_test then
    select count(*) into v_real from public.office o where not o.is_test;
    if v_real = 1 then
      select o.id into v_office from public.office o where not o.is_test for update;
      if exists (select 1 from public.staff_user s where s.office_id = v_office) then
        raise exception 'SINGLE_OFFICE: this deployment holds one firm' using errcode = '23514';
      end if;
      update public.office set name = v_name, branch = v_branch where id = v_office;
      v_result := 'claimed';
    end if;
  end if;

  if v_office is null then
    insert into public.office (name, branch, is_test) values (v_name, v_branch, v_test) returning id into v_office;
    v_result := 'created';
  end if;

  perform private.seed_catalogue(v_office);                -- 02: groups, types, financial years (idempotent)
  perform private.seed_preferred_formats(v_office, true);  -- 11: the six real-office preferences (idempotent)
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, null, 'office.bootstrapped', 'office', v_office::text, jsonb_build_object('result', v_result));
  return jsonb_build_object('office_id', v_office, 'result', v_result);
end $$;
revoke all on function public.bootstrap_office(jsonb) from public, anon, authenticated;
grant execute on function public.bootstrap_office(jsonb) to service_role;

-- 5. Test probe for the guard and the single-mode bootstrap (AC-16, AC-17, AC-19, AC-20) -----------------------
-- Runs each scenario inside a block that is rolled back, so nothing it does survives, and returns what happened.
-- Inside the block the existing real offices are flagged as test offices, so the scenario starts from "no firm yet"
-- whatever the database holds (dev, CI's local stack). Refuses to run when a deployment mode is set (staging/prod).
create or replace function public.test_tenancy_probe()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r      jsonb := '{}'::jsonb;
  v_one  uuid;
  v_t    uuid;
  v_b    jsonb;
begin
  if exists (select 1 from private.deployment) then
    raise exception 'NOT_TEST_DEPLOYMENT: a deployment mode is set' using errcode = '42501';
  end if;

  -- single: guard + claim + mode mismatch
  begin
    update public.office set is_test = true where not is_test;
    insert into private.deployment (mode) values ('single');
    insert into public.office (name) values ('probe firm one') returning id into v_one;
    begin
      insert into public.office (name) values ('probe firm two');
      r := r || jsonb_build_object('single_second_real', 'allowed');
    exception when others then r := r || jsonb_build_object('single_second_real', sqlerrm); end;
    begin
      insert into public.office (name, is_test) values ('e2e office probe', true) returning id into v_t;
      r := r || jsonb_build_object('single_test_office', 'allowed');
    exception when others then r := r || jsonb_build_object('single_test_office', sqlerrm); end;
    begin
      update public.office set is_test = false where id = v_t;
      r := r || jsonb_build_object('single_test_to_real', 'allowed');
    exception when others then r := r || jsonb_build_object('single_test_to_real', sqlerrm); end;
    v_b := public.bootstrap_office(jsonb_build_object('name', 'Probe Claimed', 'branch', 'Probe Branch', 'mode', 'single'));
    r := r || jsonb_build_object('single_bootstrap', v_b->>'result',
      'single_claimed_same_row', (v_b->>'office_id')::uuid = v_one,
      'single_claimed_name', (select name from public.office where id = v_one));
    begin
      perform public.bootstrap_office(jsonb_build_object('name', 'Probe Other', 'mode', 'multi'));
      r := r || jsonb_build_object('mode_mismatch', 'allowed');
    exception when others then r := r || jsonb_build_object('mode_mismatch', sqlerrm); end;
    raise exception 'PROBE_ROLLBACK';
  exception when others then
    if sqlerrm <> 'PROBE_ROLLBACK' then raise; end if;
  end;

  -- multi: no guard, and the bootstrap never renames another firm
  begin
    update public.office set is_test = true where not is_test;
    insert into private.deployment (mode) values ('multi');
    insert into public.office (name) values ('probe firm one') returning id into v_one;
    insert into public.office (name) values ('probe firm two');
    r := r || jsonb_build_object('multi_second_real', 'allowed');
    v_b := public.bootstrap_office(jsonb_build_object('name', 'Probe New Firm', 'mode', 'multi'));
    r := r || jsonb_build_object('multi_bootstrap', v_b->>'result',
      'multi_other_firm_kept', (select name from public.office where id = v_one));
    raise exception 'PROBE_ROLLBACK';
  exception when others then
    if sqlerrm <> 'PROBE_ROLLBACK' then raise; end if;
  end;

  -- no deployment row (dev today): no guard
  begin
    update public.office set is_test = true where not is_test;
    insert into public.office (name) values ('probe firm one');
    insert into public.office (name) values ('probe firm two');
    r := r || jsonb_build_object('unset_second_real', 'allowed');
    raise exception 'PROBE_ROLLBACK';
  exception when others then
    if sqlerrm <> 'PROBE_ROLLBACK' then raise; end if;
  end;
  return r;
end $$;
revoke all on function public.test_tenancy_probe() from public, anon, authenticated;
grant execute on function public.test_tenancy_probe() to service_role;
