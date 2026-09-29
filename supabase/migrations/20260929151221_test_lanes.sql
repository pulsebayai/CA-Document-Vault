-- Test lanes (chore test-isolation, Raja 2026-09-29).
-- Up to three CI / Regression runs share the dev database at once. Each run leases one lane and uses
-- fixture offices and users suffixed with that lane (tests/support/test-data.ts), so concurrent runs
-- never reset each other's data. Test infrastructure only: no app code reads this table; only the
-- service role (scripts/test-lane.mjs) can touch it.

create table public.test_lane (
  lane         smallint primary key check (lane between 1 and 9),
  holder       text check (holder is null or length(holder) between 1 and 120),
  leased_until timestamptz,
  updated_at   timestamptz not null default now(),
  constraint test_lane_lease_complete check ((holder is null) = (leased_until is null))
);
insert into public.test_lane (lane) values (1), (2), (3);

alter table public.test_lane enable row level security; -- no policies: app roles see nothing
revoke all on public.test_lane from anon, authenticated;

-- Lease a free lane for p_minutes (a crashed run's lease simply expires). The same holder asking again
-- (e.g. a re-run step) gets its own lane back. Returns null when all lanes are busy — the caller waits.
create or replace function public.acquire_test_lane(p_holder text, p_minutes integer default 90)
returns smallint language plpgsql security invoker set search_path = '' as $$
declare v_lane smallint;
begin
  if p_holder is null or length(p_holder) not between 1 and 120 then
    raise exception 'BAD_HOLDER: holder must be 1–120 characters' using errcode = '22023';
  end if;
  if p_minutes is null or p_minutes not between 5 and 240 then
    raise exception 'BAD_MINUTES: lease must be 5–240 minutes' using errcode = '22023';
  end if;
  select lane into v_lane from public.test_lane
   where holder = p_holder and leased_until > now()
   for update;
  if not found then
    select lane into v_lane from public.test_lane
     where leased_until is null or leased_until <= now()
     order by lane
     for update skip locked
     limit 1;
    if not found then return null; end if;
  end if;
  update public.test_lane
     set holder = p_holder, leased_until = now() + make_interval(mins => p_minutes), updated_at = now()
   where lane = v_lane;
  return v_lane;
end $$;

-- Give a lane back. Only its current holder can release it; returns whether anything was released.
create or replace function public.release_test_lane(p_lane smallint, p_holder text)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.test_lane set holder = null, leased_until = null, updated_at = now()
   where lane = p_lane and holder = p_holder;
  return found;
end $$;

revoke all on function public.acquire_test_lane(text, integer), public.release_test_lane(smallint, text) from public, anon, authenticated;
grant execute on function public.acquire_test_lane(text, integer), public.release_test_lane(smallint, text) to service_role;
