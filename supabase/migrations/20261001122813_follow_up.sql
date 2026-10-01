-- Feature 06 — Today & reminders, migration 1 (spec: sdlc/features/06-today-and-reminders/spec.md, plan step 2).
-- Tests written first: tests/rls/{follow-up,today,chasing-metric}.test.ts (contract: tests/support/expected.ts, "Feature 06").
-- ADDITIVE-ONLY EXCEPTION (schema lock: 07): new types, tables, functions, triggers and policies only.
-- No existing table, policy, trigger or function changes. FKs to client / expected_doc cascade ONLY so 02/04's
-- reset_test_office purge keeps working unchanged (it deletes expected_doc and client rows with app.purge_office set).
--
-- Sections
--   1. Types and tables (follow_up, follow_up_item), indexes incl. the email cap
--   2. Guards: no app writes, the finish transition only, no delete outside the test purge; RLS (select only)
--   3. Private helpers (definer: the only writers; invoker: item checks)
--   4. begin_email_reminder / finish_email_reminder (two-phase send) · record_follow_up (WhatsApp, call)
--   5. today_items (expected rows; 06's migration 2 adds To review / Ready to dispatch after 07 merges)
--   6. chasing_metric (metric 2)
--   7. Grants
--
-- "Today" everywhere is private.office_today(office): the date in India, or the test clock in an is_test office (04 D1).
-- A follow-up COUNTS as a reminder (row history, metric 2, the cap) when its status is sent, suppressed, opened or logged.

-- ── 1 ─────────────────────────────────────────────────────────────────────
create type public.follow_up_channel as enum ('email', 'whatsapp', 'phone');
create type public.follow_up_status as enum ('pending', 'sent', 'failed', 'suppressed', 'opened', 'logged');

create table public.follow_up (
  id                  uuid primary key default gen_random_uuid(),
  office_id           uuid not null references public.office (id),
  client_id           uuid not null references public.client (id) on delete cascade,  -- test purge only
  channel             public.follow_up_channel not null,
  status              public.follow_up_status not null,
  sent_by             uuid not null references public.staff_user (id),
  sent_at             timestamptz not null default now(),
  sent_on             date not null,                       -- office date: the cap's day; a call's date
  recipient           text check (recipient is null or length(recipient) between 3 and 254),  -- snapshot (spec decision 2)
  provider_message_id text check (provider_message_id is null or length(provider_message_id) between 1 and 200),
  error_code          text check (error_code is null or error_code ~ '^[A-Z0-9_]{1,64}$'),
  note                text check (note is null or length(note) between 1 and 300),
  finished_at         timestamptz,
  constraint follow_up_channel_status check (
       (channel = 'email'    and status in ('pending', 'sent', 'failed', 'suppressed'))
    or (channel = 'whatsapp' and status = 'opened')
    or (channel = 'phone'    and status = 'logged')),
  constraint follow_up_recipient check ((channel = 'phone') = (recipient is null)),
  constraint follow_up_note_phone check (note is null or channel = 'phone')
);
-- AC-8: one email per client per office day, in the database. Failed emails don't hold the day; a pending row
-- older than 10 minutes is closed as failed (TIMEOUT) by the next begin_email_reminder before it inserts.
create unique index follow_up_email_cap on public.follow_up (client_id, sent_on)
  where channel = 'email' and status in ('pending', 'sent', 'suppressed');
create index follow_up_client_sent_idx on public.follow_up (client_id, sent_at desc);
create index follow_up_office_day_idx on public.follow_up (office_id, sent_on) where channel = 'email';
create index follow_up_sent_by_idx on public.follow_up (sent_by);

create table public.follow_up_item (
  id              uuid primary key default gen_random_uuid(),
  office_id       uuid not null references public.office (id),
  follow_up_id    uuid not null references public.follow_up (id) on delete cascade,
  expected_doc_id uuid not null references public.expected_doc (id) on delete cascade,  -- test purge only
  unique (follow_up_id, expected_doc_id)
);
create index follow_up_item_expected_idx on public.follow_up_item (expected_doc_id);
create index follow_up_item_office_idx on public.follow_up_item (office_id);

-- ── 2 ─────────────────────────────────────────────────────────────────────
-- The only change ever made to a follow-up: pending → sent | failed | suppressed, by 06's definer helpers
-- (which set app.follow_up_write). Everything else, for every role including the service role, is refused.
create or replace function private.follow_up_before_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('app.follow_up_write', true), '') <> 'on'
     or old.status <> 'pending' or new.status not in ('sent', 'failed', 'suppressed')
     or (new.id, new.office_id, new.client_id, new.channel, new.sent_by, new.sent_at, new.sent_on)
        is distinct from (old.id, old.office_id, old.client_id, old.channel, old.sent_by, old.sent_at, old.sent_on)
     or new.recipient is distinct from old.recipient or new.note is distinct from old.note then
    raise exception 'IMMUTABLE: a follow-up only moves from pending to its result' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger follow_up_before_update before update on public.follow_up
  for each row execute function private.follow_up_before_update();
create trigger follow_up_no_delete before delete on public.follow_up
  for each row execute function private.forbid_delete_unless_purge();
create trigger follow_up_item_no_update before update on public.follow_up_item
  for each row execute function private.forbid_change();
create trigger follow_up_item_no_delete before delete on public.follow_up_item
  for each row execute function private.forbid_delete_unless_purge();

alter table public.follow_up enable row level security;
alter table public.follow_up_item enable row level security;
-- AC-16: visible iff the user can see the client. No INSERT/UPDATE/DELETE policies or grants: writes go only
-- through the functions below.
create policy follow_up_select on public.follow_up for select to authenticated
  using (office_id = (select private.current_office_id()) and private.can_see_client(client_id));
create policy follow_up_item_select on public.follow_up_item for select to authenticated
  using (office_id = (select private.current_office_id())
         and exists (select 1 from public.follow_up f where f.id = follow_up_id));
revoke all on public.follow_up, public.follow_up_item from anon, authenticated;
grant select on public.follow_up, public.follow_up_item to authenticated;

-- ── 3 ─────────────────────────────────────────────────────────────────────
-- Items of a reminder: ≥ 1, all the client's, all open (pending; row and group not paused; client not archived).
-- Invoker, so expected_doc RLS applies too. Returns the distinct ids.
create or replace function private.follow_up_items(p_client uuid, p_items uuid[])
returns uuid[] language plpgsql stable set search_path = '' as $$
declare v uuid[] := array(select distinct x from unnest(coalesce(p_items, '{}'::uuid[])) x where x is not null);
begin
  if cardinality(v) = 0 then
    raise exception 'NO_ITEMS: choose at least one document to remind about' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(v) i(id)
     where not exists (
       select 1 from public.expected_doc e
         join public.client c on c.id = e.client_id and c.archived_at is null
         join public.client_doc_type r on r.id = e.client_doc_type_id
         join public.client_group g on g.id = r.client_group_id
        where e.id = i.id and e.client_id = p_client and e.status = 'pending'
          and r.state <> 'paused' and g.state <> 'paused')) then
    raise exception 'ITEMS_INVALID: every document must be one of this client''s open items' using errcode = '22023';
  end if;
  return v;
end $$;

-- The visible client (RLS + can_see_client), or NOT_FOUND.
create or replace function private.follow_up_client(p_client uuid)
returns public.client language plpgsql stable set search_path = '' as $$
declare c public.client;
begin
  select * into c from public.client
   where id = p_client and office_id = (select private.current_office_id()) and private.can_see_client(id);
  if not found then raise exception 'NOT_FOUND: client' using errcode = 'P0002'; end if;
  return c;
end $$;

-- Definer: the only INSERT path. Re-checks office and visibility (defence in depth), writes the items, and the
-- activity row when the follow-up is already final (WhatsApp, call). AC-17: activity holds IDs, channel, status
-- and the item count only — never the recipient, message text or note.
create or replace function private.insert_follow_up(p_client uuid, p_channel public.follow_up_channel,
  p_status public.follow_up_status, p_on date, p_recipient text, p_note text, p_items uuid[])
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_office uuid := private.current_office_id(); v_me uuid := private.current_staff_id(); v_id uuid;
begin
  if v_office is null or v_me is null
     or not exists (select 1 from public.client where id = p_client and office_id = v_office)
     or not private.can_see_client(p_client) then
    raise exception 'NOT_FOUND: client' using errcode = 'P0002';
  end if;
  insert into public.follow_up (office_id, client_id, channel, status, sent_by, sent_on, recipient, note, finished_at)
    values (v_office, p_client, p_channel, p_status, v_me, p_on, p_recipient, p_note,
            case when p_status = 'pending' then null else now() end)
    returning id into v_id;
  insert into public.follow_up_item (office_id, follow_up_id, expected_doc_id)
    select v_office, v_id, x from unnest(p_items) x;
  if p_status <> 'pending' then
    perform private.follow_up_activity(v_id);
  end if;
  return v_id;
end $$;

create or replace function private.follow_up_activity(p_id uuid)
returns void language sql security definer set search_path = '' as $$
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
  select f.office_id, f.sent_by,
         case f.channel when 'email' then 'reminder.email' when 'whatsapp' then 'reminder.whatsapp' else 'reminder.call' end,
         'follow_up', f.id::text,
         jsonb_build_object('client_id', f.client_id, 'channel', f.channel, 'status', f.status,
                            'items', (select count(*) from public.follow_up_item i where i.follow_up_id = f.id))
    from public.follow_up f where f.id = p_id
$$;

-- Definer: pending → result (the trigger accepts it only with app.follow_up_write), plus the activity row.
create or replace function private.finish_follow_up(p_id uuid, p_status public.follow_up_status,
  p_provider_id text, p_error_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform set_config('app.follow_up_write', 'on', true);
  update public.follow_up
     set status = p_status, provider_message_id = p_provider_id, error_code = p_error_code, finished_at = now()
   where id = p_id and status = 'pending';
  get diagnostics n = row_count;
  perform set_config('app.follow_up_write', '', true);
  if n > 0 then perform private.follow_up_activity(p_id); end if;
end $$;

-- Definer: a client's email still pending after 10 minutes never reached a result (the provider call times out
-- after 10 s); close it as failed / TIMEOUT so it neither holds the day's email nor stays "sending" forever.
create or replace function private.close_stale_emails(p_client uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in select f.id from public.follow_up f
            where f.client_id = p_client and f.channel = 'email' and f.status = 'pending'
              and f.sent_at <= now() - interval '10 minutes'
              and f.office_id = private.current_office_id() loop
    perform private.finish_follow_up(r.id, 'failed', null, 'TIMEOUT');
  end loop;
end $$;

-- Definer (a Limited user cannot see every client's follow-ups): the office's emails today that use provider
-- quota — sent, or pending for under 10 minutes. Suppressed and failed emails never reached Brevo.
create or replace function private.office_emails_today(p_today date)
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::integer from public.follow_up f
   where f.office_id = private.current_office_id() and f.sent_on = p_today and f.channel = 'email'
     and (f.status = 'sent' or (f.status = 'pending' and f.sent_at > now() - interval '10 minutes'))
$$;

-- ── 4 ─────────────────────────────────────────────────────────────────────
-- AC-8 / AC-14, phase 1: record the email as pending BEFORE the provider is called. The server action then calls
-- the mailer and finish_email_reminder. p_daily_max is EMAIL_DAILY_MAX from the server's environment: a pending row
-- sends nothing by itself (only the server action calls Brevo), so a caller cannot raise the ceiling for real sends.
create or replace function public.begin_email_reminder(p_client uuid, p_items uuid[], p_daily_max integer default 200)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c public.client; v_items uuid[]; v_today date; v_id uuid;
begin
  c := private.follow_up_client(p_client);
  v_items := private.follow_up_items(p_client, p_items);
  if c.email is null then
    raise exception 'NO_EMAIL: this client has no email address' using errcode = '22023';
  end if;
  v_today := private.office_today(c.office_id);
  perform private.close_stale_emails(p_client);
  if exists (select 1 from public.follow_up f
              where f.client_id = p_client and f.sent_on = v_today and f.channel = 'email'
                and f.status in ('pending', 'sent', 'suppressed')) then
    raise exception 'ALREADY_EMAILED_TODAY: one email per client per day' using errcode = '23505';
  end if;
  if private.office_emails_today(v_today) >= greatest(coalesce(p_daily_max, 200), 0) then
    raise exception 'DAILY_LIMIT: the office''s daily email limit is reached' using errcode = '54000';
  end if;
  begin
    v_id := private.insert_follow_up(p_client, 'email', 'pending', v_today, c.email, null, v_items);
  exception when unique_violation then
    raise exception 'ALREADY_EMAILED_TODAY: one email per client per day' using errcode = '23505';
  end;
  return jsonb_build_object('id', v_id, 'recipient', c.email);
end $$;

-- Phase 2: the mailer's result. Only the sender, only from pending.
create or replace function public.finish_email_reminder(p_id uuid, p_status text, p_provider_id text default null,
  p_error_code text default null)
returns void language plpgsql security invoker set search_path = '' as $$
declare f public.follow_up;
begin
  if p_status is null or p_status not in ('sent', 'failed', 'suppressed') then
    raise exception 'BAD_STATUS: an email ends sent, failed or suppressed' using errcode = '22023';
  end if;
  select * into f from public.follow_up where id = p_id and channel = 'email';
  if not found then raise exception 'NOT_FOUND: follow-up' using errcode = 'P0002'; end if;
  if f.sent_by <> private.current_staff_id() then
    raise exception 'NOT_SENDER: only the person sending the email records its result' using errcode = '42501';
  end if;
  if f.status <> 'pending' then
    raise exception 'NOT_PENDING: this email already has a result' using errcode = 'P0001';
  end if;
  perform private.finish_follow_up(p_id, p_status::public.follow_up_status,
    nullif(left(btrim(coalesce(p_provider_id, '')), 200), ''), nullif(p_error_code, ''));
end $$;

-- AC-9 / AC-11: WhatsApp click-to-chat (opened; not capped) and a logged call (date not in the future; note ≤ 300).
create or replace function public.record_follow_up(p_client uuid, p_items uuid[], p_channel text,
  p_on date default null, p_note text default null)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare c public.client; v_items uuid[]; v_today date; v_note text;
begin
  if p_channel is null or p_channel not in ('whatsapp', 'phone') then
    raise exception 'BAD_CHANNEL: record WhatsApp or a call here; email goes through begin_email_reminder' using errcode = '22023';
  end if;
  c := private.follow_up_client(p_client);
  v_items := private.follow_up_items(p_client, p_items);
  v_today := private.office_today(c.office_id);
  if p_channel = 'whatsapp' then
    if c.mobile is null then
      raise exception 'NO_MOBILE: this client has no mobile number' using errcode = '22023';
    end if;
    return private.insert_follow_up(p_client, 'whatsapp', 'opened', v_today, c.mobile, null, v_items);
  end if;
  if coalesce(p_on, v_today) > v_today then
    raise exception 'FUTURE_DATE: a call cannot be logged for a future date' using errcode = '22023';
  end if;
  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if length(v_note) > 300 then
    raise exception 'NOTE_TOO_LONG: keep the note to 300 characters' using errcode = '22023';
  end if;
  return private.insert_follow_up(p_client, 'phone', 'logged', coalesce(p_on, v_today), null, v_note, v_items);
end $$;

-- ── 5 ─────────────────────────────────────────────────────────────────────
-- AC-2…AC-5: the Today screen in one call. Rows = pending expected items, not on hold, client not archived,
-- overdue or overdue within the next 7 days (Key definitions). Kinds: overdue (today ≥ overdue_from),
-- due_today (today = overdue_from − 1), due_week (the rest); the "Due this week" count includes due_today.
-- Scope: mine = effective assignee (type → group → incharge, the columns of can_see_client) is the caller;
-- everyone = all the caller can see (RLS). Counts cover the whole scope; p_show filters the cards (enums only).
-- Cards: most overdue items first, then name; 30 per page (p_limit 1–100, for tests). Card badges count the
-- client's rows in scope regardless of p_show. Invoker: RLS applies throughout.
create or replace function public.today_items(p_scope text, p_show text default null, p_page integer default 0,
  p_limit integer default 30)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_office uuid := private.current_office_id();
  v_me uuid := private.current_staff_id();
  v_today date;
  v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_page integer := greatest(coalesce(p_page, 0), 0);
  v jsonb;
begin
  if p_scope is null or p_scope not in ('mine', 'everyone') then
    raise exception 'BAD_SCOPE: scope is mine or everyone' using errcode = '22023';
  end if;
  if p_show is not null and p_show not in ('overdue', 'due_week') then
    raise exception 'BAD_SHOW: show is overdue or due_week' using errcode = '22023';
  end if;
  v_today := private.office_today(v_office);

  with base as (
    select e.id, e.client_id, e.overdue_from, r.reminders, t.name as type_name, dg.name as group_name, dg.sort as group_sort,
           p.label as period_label, p.start_date, reg.kind as reg_kind,
           case when reg.kind = 'gstin' then coalesce(reg.state_code, substr(reg.number, 1, 2)) end as state_code,
           case when e.overdue_from <= v_today then 'overdue'
                when e.overdue_from = v_today + 1 then 'due_today' else 'due_week' end as kind,
           case when e.overdue_from <= v_today then v_today - e.overdue_from + 1 end as days_late
      from public.expected_doc e
      join public.client c on c.id = e.client_id and c.archived_at is null
      join public.client_doc_type r on r.id = e.client_doc_type_id
      join public.client_group g on g.id = r.client_group_id
      join public.doc_type t on t.id = e.doc_type_id
      join public.doc_group dg on dg.id = t.doc_group_id
      join public.period p on p.id = e.period_id
      left join public.client_registration reg on reg.id = e.registration_id
     where e.office_id = v_office and e.status = 'pending'
       and r.state <> 'paused' and g.state <> 'paused'
       and e.overdue_from <= v_today + 7
       and (p_scope = 'everyone' or coalesce(r.assigned_staff_id, g.assigned_staff_id, c.incharge_id) = v_me)
  ), shown as (
    select * from base
     where p_show is null or (p_show = 'overdue') = (kind = 'overdue')
  ), card as (
    select b.client_id,
           count(*) filter (where b.kind = 'overdue') as n_overdue,
           count(*) filter (where b.kind <> 'overdue') as n_week
      from base b where b.client_id in (select client_id from shown)
     group by b.client_id
  ), ordered as (
    select k.*, cl.name, cl.incharge_id,
           row_number() over (order by k.n_overdue desc, lower(cl.name), cl.id) as rn
      from card k join public.client cl on cl.id = k.client_id
  ), page as (
    select * from ordered where rn > v_page * v_limit and rn <= (v_page + 1) * v_limit
  ), hist as (
    select s.id,
           h.n as reminded, h.last_on, h.last_by, h.last_channel
      from shown s
      cross join lateral (
        select count(*) as n,
               (array_agg(f.sent_on order by f.sent_on desc, f.sent_at desc))[1] as last_on,
               (array_agg(st.full_name order by f.sent_on desc, f.sent_at desc))[1] as last_by,
               (array_agg(f.channel::text order by f.sent_on desc, f.sent_at desc))[1] as last_channel
          from public.follow_up_item fi
          join public.follow_up f on f.id = fi.follow_up_id
          join public.staff_user st on st.id = f.sent_by
         where fi.expected_doc_id = s.id and f.status in ('sent', 'suppressed', 'opened', 'logged')
      ) h
     where s.client_id in (select client_id from page)
  )
  select jsonb_build_object(
    'today', v_today,
    'counts', jsonb_build_object(
      'overdue', (select count(*) from base where kind = 'overdue'),
      'due_week', (select count(*) from base where kind <> 'overdue')),
    'has_more', exists (select 1 from ordered where rn > (v_page + 1) * v_limit),
    'cards', coalesce((
      select jsonb_agg(jsonb_build_object(
               'client_id', pg.client_id, 'name', pg.name,
               'incharge', (select s.full_name from public.staff_user s where s.id = pg.incharge_id),
               'assignees', coalesce((
                  select jsonb_agg(jsonb_build_object('group', dg.name, 'name', s.full_name) order by dg.sort, dg.name)
                    from public.client_group g
                    join public.doc_group dg on dg.id = g.doc_group_id
                    join public.staff_user s on s.id = g.assigned_staff_id
                   where g.client_id = pg.client_id and g.state = 'active'), '[]'::jsonb),
               'overdue', pg.n_overdue, 'due_week', pg.n_week,
               'rows', (
                  select jsonb_agg(jsonb_build_object(
                           'expected_doc_id', s.id, 'kind', s.kind, 'group', s.group_name, 'type', s.type_name,
                           'period', s.period_label, 'reg_kind', s.reg_kind, 'state_code', s.state_code,
                           'overdue_from', s.overdue_from, 'days_late', s.days_late, 'reminders', s.reminders,
                           'reminded', h.reminded, 'last_reminded_on', h.last_on, 'last_reminded_by', h.last_by,
                           'last_channel', h.last_channel)
                         order by case s.kind when 'overdue' then 0 when 'due_today' then 1 else 2 end,
                                  s.overdue_from, s.group_sort, s.type_name, s.start_date, s.id)
                    from shown s join hist h on h.id = s.id
                   where s.client_id = pg.client_id))
             order by pg.rn)
        from page pg), '[]'::jsonb))
    into v;
  return v;
end $$;

-- ── 6 ─────────────────────────────────────────────────────────────────────
-- AC-15 / metric 2 (chasing load). Items received in [p_from, p_to] (clients not archived); a reminder counts for
-- an item when it is a counting follow-up that includes the item, recorded on or before the day it was received
-- (sent_on ≤ received_on). Admin/Manager, like collection_metric.
create or replace function public.chasing_metric(p_from date, p_to date)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_office uuid := private.current_office_id(); v jsonb;
begin
  if not private.has_role(array['admin', 'manager']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: only Admin or Manager can see the chasing metric' using errcode = '42501';
  end if;
  with rec as (
    select e.id, e.received_on
      from public.expected_doc e
      join public.client c on c.id = e.client_id and c.archived_at is null
     where e.office_id = v_office and e.status = 'received' and e.received_on between p_from and p_to
  ), pairs as (
    select r.id, f.channel
      from rec r
      join public.follow_up_item fi on fi.expected_doc_id = r.id
      join public.follow_up f on f.id = fi.follow_up_id
     where f.status in ('sent', 'suppressed', 'opened', 'logged') and f.sent_on <= r.received_on
  ), n as (
    select (select count(*) from rec) as received, (select count(*) from pairs) as reminders,
           (select count(distinct id) from pairs) as reminded_items
  )
  select jsonb_build_object(
    'received', n.received,
    'reminders', n.reminders,
    'per_item', case when n.received = 0 then null else round(n.reminders::numeric / n.received, 2) end,
    'needed_pct', case when n.received = 0 then null else round(100.0 * n.reminded_items / n.received, 1) end,
    'by_channel', jsonb_build_object(
      'email', (select count(*) from pairs where channel = 'email'),
      'whatsapp', (select count(*) from pairs where channel = 'whatsapp'),
      'phone', (select count(*) from pairs where channel = 'phone')))
    into v from n;
  return v;
end $$;

-- ── 7 ─────────────────────────────────────────────────────────────────────
revoke all on function
  private.follow_up_before_update(), private.follow_up_items(uuid, uuid[]), private.follow_up_client(uuid),
  private.insert_follow_up(uuid, public.follow_up_channel, public.follow_up_status, date, text, text, uuid[]),
  private.follow_up_activity(uuid), private.finish_follow_up(uuid, public.follow_up_status, text, text),
  private.close_stale_emails(uuid), private.office_emails_today(date)
  from public, anon, authenticated;
-- Called from the invoker functions below (private is not exposed through the API). Each definer helper
-- re-derives office and caller from the JWT and touches only the caller's office.
grant execute on function
  private.follow_up_items(uuid, uuid[]), private.follow_up_client(uuid),
  private.insert_follow_up(uuid, public.follow_up_channel, public.follow_up_status, date, text, text, uuid[]),
  private.finish_follow_up(uuid, public.follow_up_status, text, text),
  private.close_stale_emails(uuid), private.office_emails_today(date)
  to authenticated;

revoke all on function
  public.begin_email_reminder(uuid, uuid[], integer), public.finish_email_reminder(uuid, text, text, text),
  public.record_follow_up(uuid, uuid[], text, date, text), public.today_items(text, text, integer, integer),
  public.chasing_metric(date, date)
  from public, anon;
grant execute on function
  public.begin_email_reminder(uuid, uuid[], integer), public.finish_email_reminder(uuid, text, text, text),
  public.record_follow_up(uuid, uuid[], text, date, text), public.today_items(text, text, integer, integer),
  public.chasing_metric(date, date)
  to authenticated;
