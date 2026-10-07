-- 09 volume test, V4: the daily job (private.run_office_expected) timed inside the database, as pg_cron runs it.
-- Read-only in effect: everything happens in one block that ends with an exception, so nothing is kept.
-- Run with the Supabase connector or the SQL editor; the result is in the error message ("V4 …").
do $$
declare o uuid; t0 timestamptz; r jsonb; out text := '';
begin
  select id into o from public.office where name = 'e2e office volume' and is_test;
  if o is null then raise exception 'no test office named "e2e office volume"'; end if;
  -- V4a: a normal day (the seeded clock again: every plan row scanned, nothing new to create).
  t0 := clock_timestamp(); r := private.run_office_expected(o, '2027-04-15');
  out := out || format('V4a normal day: %s ms %s; ', round(extract(epoch from clock_timestamp() - t0) * 1000), r);
  -- V4b: the next month start, worst case (all 1,000 clients have monthly types asking on the 1st).
  t0 := clock_timestamp(); r := private.run_office_expected(o, '2027-05-01');
  out := out || format('V4b month start (all clients monthly): %s ms %s', round(extract(epoch from clock_timestamp() - t0) * 1000), r);
  raise exception 'V4 % (rolled back)', out;
end $$;
