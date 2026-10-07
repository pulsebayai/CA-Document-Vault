-- 09 volume test, seeding part B: a year of expected items for "e2e office volume" (test office only).
-- Why SQL: the office-wide daily job is longer than the API's 8 s statement timeout at 1,000 clients; it runs here as
-- the database owner, exactly as pg_cron runs it (no timeout). Run ONE statement at a time (Supabase connector or
-- SQL editor); each prints its time. Order: after part A (clients imported by VOLUME=1), before part C.
-- Each step = one month-start daily run for all 1,000 clients (every monthly type asks on the 1st).

-- Part 0 (only to start over): retire the old office and let the next VOLUME=1 run create a fresh one.
-- A reset office is not reused: reset_test_office keeps activity (append-only), and those stale rows would distort
-- the Activity timings (09 review I-3). Remove its storage objects first (Storage API) if you want the space back.
-- do $$ declare o uuid; begin
--   select id into o from public.office where name = 'e2e office volume' and is_test;
--   perform public.reset_test_office(o);
--   update public.office set name = 'e2e office volume retired ' || to_char(now(), 'YYYY-MM-DD HH24MI') where id = o;
-- end $$;

-- Step n (repeat with :as_of = 2026-05-01, 2026-06-01, … 2027-04-01, then 2027-04-15):
do $$
declare o uuid; t0 timestamptz := clock_timestamp(); r jsonb; v_as_of date := '2026-05-01'; -- ← change per step
begin
  select id into o from public.office where name = 'e2e office volume' and is_test;
  if o is null then raise exception 'no test office named "e2e office volume"'; end if;
  update public.office set test_today = v_as_of where id = o;
  r := private.run_office_expected(o, v_as_of);
  raise notice 'volume generate %: % ms %', v_as_of, round(extract(epoch from clock_timestamp() - t0) * 1000), r;
end $$;
