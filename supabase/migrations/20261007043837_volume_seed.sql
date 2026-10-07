-- 09 volume test (chore, R1 gate; plan approved by Raja 2026-10-07). TEST-ONLY seeding helpers.
-- Both functions are SECURITY INVOKER: every row goes through the same RLS, triggers and guards as the app.
-- Both refuse unless the caller is an active Admin of an office with is_test = true, so they do nothing on a real
-- office in dev, staging or prod (staging/prod offices are never named "e2e office …", roadmap rule).
-- No table, column, policy, trigger or existing function changes.

-- seed_test_documents: files up to 1,000 documents in one call by looping 03's create_document
-- (DOC-IDs, 04 linking, 07 review state, activity rows all as in the app). Each element of p_docs is a
-- create_document payload; soft copies need their storage object uploaded first (as in the app).
-- Dry run 2026-10-07 (rolled back): 1,000 hard copies in 3.0 s, under the 8 s statement timeout.
create or replace function public.seed_test_documents(p_docs jsonb)
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  v_office uuid := private.current_office_id();
  d jsonb;
  n integer := 0;
begin
  if not private.has_role(array['admin']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: only Admin can seed test data' using errcode = '42501';
  end if;
  if not exists (select 1 from public.office o where o.id = v_office and o.is_test) then
    raise exception 'NOT_TEST_OFFICE: seeding is for test offices only' using errcode = '42501';
  end if;
  if jsonb_typeof(p_docs) <> 'array' or jsonb_array_length(p_docs) > 1000 then
    raise exception 'SEED_FORMAT: an array of at most 1,000 create_document payloads' using errcode = '22023';
  end if;
  for d in select e.value from jsonb_array_elements(p_docs) as e(value) loop
    perform public.create_document(d);
    n := n + 1;
  end loop;
  return n;
end $$;

-- seed_test_activity: adds p_count activity rows (≤ 20,000 per call; dry run 2026-10-07: 50,000 took 7.9 s, too close to the 8 s timeout) copied from the office's own real rows
-- (same action, entity type, entity ID and data, so 08's Limited visibility helper resolves real clients),
-- spread at random between p_from and p_to. The actor is the caller: activity_insert_self allows only that.
-- ACTIVITY_PII still checks every row. Append-only like all activity; reset_test_office purges it.
create or replace function public.seed_test_activity(p_count integer, p_from timestamptz, p_to timestamptz)
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  v_office uuid := private.current_office_id();
  v_staff  uuid := private.current_staff_id();
  v_src    integer;
  v_n      integer;
begin
  if not private.has_role(array['admin']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: only Admin can seed test data' using errcode = '42501';
  end if;
  if not exists (select 1 from public.office o where o.id = v_office and o.is_test) then
    raise exception 'NOT_TEST_OFFICE: seeding is for test offices only' using errcode = '42501';
  end if;
  if p_count is null or p_count < 1 or p_count > 20000 or p_from is null or p_to is null or p_to <= p_from then
    raise exception 'SEED_FORMAT: 1–20,000 rows and p_from < p_to' using errcode = '22023';
  end if;
  select count(*) into v_src from public.activity a where a.office_id = v_office;
  if v_src = 0 then raise exception 'SEED_SOURCE: the office has no activity to copy' using errcode = '22023'; end if;

  with src as materialized (
    select row_number() over (order by s.id) as rn, s.action, s.entity_type, s.entity_id, s.data
      from public.activity s where s.office_id = v_office
  ), pick as materialized (
    select 1 + floor(random() * v_src)::integer as rn, p_from + random() * (p_to - p_from) as at
      from generate_series(1, p_count)
  )
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data, created_at)
  select v_office, v_staff, src.action, src.entity_type, src.entity_id, src.data, pick.at
    from pick join src using (rn);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.seed_test_documents(jsonb) from public, anon;
grant execute on function public.seed_test_documents(jsonb) to authenticated;
revoke all on function public.seed_test_activity(integer, timestamptz, timestamptz) from public, anon;
grant execute on function public.seed_test_activity(integer, timestamptz, timestamptz) to authenticated;
