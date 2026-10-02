-- Feature 06 — Today & reminders, migration 2 (plan step 9, after 07 merged): Today's document rows.
-- Tests written first: tests/rls/today-documents.test.ts (contract: tests/support/expected.ts, "step 9"); the
-- expected-item behaviour stays as tests/rls/today.test.ts pins it.
-- ADDITIVE-ONLY EXCEPTION: replaces only 06's own public.today_items (same signature; grants kept by
-- create or replace). Reads 07's document status, review and dispatch columns; changes nothing of 07's.
--
-- What changes
--   * p_show also takes 'to_review' and 'ready'.
--   * counts gain to_review and ready; the result gains clients (cards in scope and filter, for "N clients need
--     something"); each card gains to_review / ready counts and document rows after its expected rows.
--   * Document rows mirror 07's TS rules (src/lib/documents/state.ts) and search_documents' return_state:
--       to_review = filed (client + type), not archived, status 'received'                        (isToReview)
--       ready     = filed, not archived, an original, status reviewed | needs_correction, and no live
--                   dispatch_item (removed_at is null)                                             (isReadyToDispatch)
--   * Mine for a document = its client's ACTIVE plan row for that type → the ACTIVE group of the type's
--     doc_group → the client's incharge (the columns can_see_client uses). Archived clients are left out.
--   * Card order is unchanged (most overdue, then name); rows: Overdue → Due today → Due this week → To review →
--     Ready, documents oldest received first.

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
  if p_show is not null and p_show not in ('overdue', 'due_week', 'to_review', 'ready') then
    raise exception 'BAD_SHOW: show is overdue, due_week, to_review or ready' using errcode = '22023';
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
  ), docs as (
    select d.id, d.client_id, d.doc_code, d.received_as, d.received_on,
           (d.reviewed_at at time zone 'Asia/Kolkata')::date as reviewed_on, rv.full_name as reviewed_by,
           d.status = 'needs_correction' as needs_correction,
           t.name as type_name, dg.name as group_name, p.label as period_label,
           case when d.status = 'received' then 'to_review' else 'ready' end as kind
      from public.document d
      join public.client c on c.id = d.client_id and c.archived_at is null
      join public.doc_type t on t.id = d.doc_type_id
      join public.doc_group dg on dg.id = t.doc_group_id
      left join public.period p on p.id = d.period_id
      left join public.staff_user rv on rv.id = d.reviewed_by
      left join public.client_doc_type r on r.client_id = d.client_id and r.doc_type_id = d.doc_type_id and r.state = 'active'
      left join public.client_group g on g.client_id = d.client_id and g.doc_group_id = t.doc_group_id and g.state = 'active'
     where d.office_id = v_office and d.archived_at is null
       and d.client_id is not null and d.doc_type_id is not null
       and (d.status = 'received'
            or (d.received_as = 'original' and d.status in ('reviewed', 'needs_correction')
                and not exists (select 1 from public.dispatch_item di where di.document_id = d.id and di.removed_at is null)))
       and (p_scope = 'everyone' or coalesce(r.assigned_staff_id, g.assigned_staff_id, c.incharge_id) = v_me)
  ), shown as (
    select * from base
     where p_show is null or (p_show = 'overdue' and kind = 'overdue') or (p_show = 'due_week' and kind <> 'overdue')
  ), shown_docs as (
    select * from docs where p_show is null or p_show = kind
  ), card as (
    select x.client_id,
           (select count(*) from base b where b.client_id = x.client_id and b.kind = 'overdue') as n_overdue,
           (select count(*) from base b where b.client_id = x.client_id and b.kind <> 'overdue') as n_week,
           (select count(*) from docs k where k.client_id = x.client_id and k.kind = 'to_review') as n_review,
           (select count(*) from docs k where k.client_id = x.client_id and k.kind = 'ready') as n_ready
      from (select client_id from shown union select client_id from shown_docs) x
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
      'due_week', (select count(*) from base where kind <> 'overdue'),
      'to_review', (select count(*) from docs where kind = 'to_review'),
      'ready', (select count(*) from docs where kind = 'ready')),
    'clients', (select count(*) from ordered),
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
               'overdue', pg.n_overdue, 'due_week', pg.n_week, 'to_review', pg.n_review, 'ready', pg.n_ready,
               'rows',
                 coalesce((
                  select jsonb_agg(jsonb_build_object(
                           'expected_doc_id', s.id, 'kind', s.kind, 'group', s.group_name, 'type', s.type_name,
                           'period', s.period_label, 'reg_kind', s.reg_kind, 'state_code', s.state_code,
                           'overdue_from', s.overdue_from, 'days_late', s.days_late, 'reminders', s.reminders,
                           'reminded', h.reminded, 'last_reminded_on', h.last_on, 'last_reminded_by', h.last_by,
                           'last_channel', h.last_channel)
                         order by case s.kind when 'overdue' then 0 when 'due_today' then 1 else 2 end,
                                  s.overdue_from, s.group_sort, s.type_name, s.start_date, s.id)
                    from shown s join hist h on h.id = s.id
                   where s.client_id = pg.client_id), '[]'::jsonb)
                 || coalesce((
                  select jsonb_agg(jsonb_build_object(
                           'document_id', k.id, 'kind', k.kind, 'doc_code', k.doc_code, 'group', k.group_name,
                           'type', k.type_name, 'period', k.period_label, 'received_as', k.received_as,
                           'received_on', k.received_on, 'reviewed_on', k.reviewed_on, 'reviewed_by', k.reviewed_by,
                           'needs_correction', k.needs_correction)
                         order by case k.kind when 'to_review' then 0 else 1 end, k.received_on, k.doc_code)
                    from shown_docs k
                   where k.client_id = pg.client_id), '[]'::jsonb))
             order by pg.rn)
        from page pg), '[]'::jsonb))
    into v;
  return v;
end $$;
