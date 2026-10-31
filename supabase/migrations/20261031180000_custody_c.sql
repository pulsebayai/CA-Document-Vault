-- 13-hard-copy-custody · migration C (pre-PR review, 2026-10-31). Replaces three of 13's own functions; only the lines
-- marked "13 pre-PR review" change:
--   public.custody_backfill  I-3: refuses offices that aren't test offices (the data step already ran in migration A)
--   public.set_custody       nit 3: locks documents in ID order, so overlapping bulk selections can't deadlock
--   public.custody_metric    I-2: documents placed by the backfill are left out of "placed within 2 working days"
-- and document_custody.at defaults to clock_timestamp(): two steps written in one transaction (S2's implied in office
-- + ready) had the same now() and no stable order (found by custody.test.ts after this review).

create or replace function public.custody_backfill(p_office uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ready     integer;
  v_in_office integer;
begin
  -- 13 pre-PR review I-3: the data step ran for every office in migration A; afterwards it serves test offices only,
  -- so a stray service-role call can't place a real office's documents without a person or a history row.
  if not exists (select 1 from public.office o where o.id = p_office and o.is_test) then
    raise exception 'NOT_TEST_OFFICE: the custody backfill ran in the migration; now only test offices' using errcode = '42501';
  end if;
  perform set_config('app.doc_custody', 'backfill', true);
  update public.document d
     set custody = 'ready', in_office_at = coalesce(d.reviewed_at, d.created_at), ready_at = coalesce(d.reviewed_at, d.created_at)
   where d.office_id = p_office and d.custody is null and d.received_as = 'hard_copy' and d.returnable
     and d.client_id is not null and d.doc_type_id is not null
     and (d.status in ('reviewed', 'needs_correction')
          or exists (select 1 from public.dispatch_item i where i.document_id = d.id and i.removed_at is null));
  get diagnostics v_ready = row_count;
  update public.document d
     set custody = 'in_office', in_office_at = coalesce(d.reviewed_at, d.created_at)
   where d.office_id = p_office and d.custody is null and d.received_as = 'hard_copy'
     and d.client_id is not null and d.doc_type_id is not null
     and (d.status in ('reviewed', 'needs_correction')
          or exists (select 1 from public.dispatch_item i where i.document_id = d.id and i.removed_at is null));
  get diagnostics v_in_office = row_count;
  perform set_config('app.doc_custody', '', true);
  return jsonb_build_object('in_office', v_in_office, 'ready', v_ready);
end $$;

create or replace function public.set_custody(p_ids uuid[], p_step text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_staff  uuid := private.current_staff_id();
  v_done   uuid[] := '{}';
  v_skip   jsonb := '[]'::jsonb;
  v_reason text;
  v_id     uuid;
  d        public.document;
begin
  if v_staff is null then raise exception 'ROLE_REQUIRED: sign in as active staff' using errcode = '42501'; end if;
  if p_step is null or p_step not in ('in_office', 'ready') then
    raise exception 'STEP_INVALID: in_office or ready' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_ids), 0) > 200 then
    raise exception 'TOO_MANY: up to 200 documents at a time' using errcode = '22023';
  end if;
  perform private.begin_doc_write();
  -- 13 pre-PR review nit 3: lock in a stable order (like create_dispatch) so overlapping bulk selections can't deadlock.
  for v_id in select distinct x from unnest(coalesce(p_ids, '{}')) x order by x loop
    v_reason := null;
    begin
      select * into d from public.document x where x.id = v_id for update; -- RLS: an invisible document is not found
      if not found then v_reason := 'NOT_FOUND';
      elsif d.archived_at is not null then v_reason := 'ARCHIVED';
      elsif d.client_id is null or d.doc_type_id is null then v_reason := 'NOT_CLASSIFIED';
      elsif d.received_as <> 'hard_copy' then v_reason := 'SOFT_COPY';
      elsif d.status = 'received' then v_reason := 'NOT_REVIEWED';
      elsif p_step = 'in_office' and d.custody is not null then v_reason := 'ALREADY';
      elsif p_step = 'ready' and not d.returnable then v_reason := 'NOT_RETURNABLE';
      elsif p_step = 'ready' and d.custody is null then v_reason := 'NOT_IN_OFFICE';
      elsif p_step = 'ready' and d.custody = 'ready' then v_reason := 'ALREADY';
      else
        perform set_config('app.doc_custody', v_id::text, true);
        insert into public.document_custody (office_id, document_id, step, implied, actor_id)
          values (d.office_id, v_id, p_step::public.custody_event, false, v_staff);
        if p_step = 'in_office' then
          update public.document set custody = 'in_office', in_office_at = now(), in_office_by = v_staff where id = v_id;
        else
          update public.document set custody = 'ready', ready_at = now(), ready_by = v_staff where id = v_id;
        end if;
        perform set_config('app.doc_custody', '', true);
        insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
          values (d.office_id, v_staff, 'document.' || p_step, 'document', v_id::text,
                  jsonb_build_object('client_id', d.client_id, 'doc_type_id', d.doc_type_id));
        v_done := v_done || v_id;
      end if;
    exception when others then
      v_reason := coalesce(nullif(split_part(sqlerrm, ':', 1), ''), 'ERROR');
    end;
    if v_reason is not null then
      v_skip := v_skip || jsonb_build_object('id', v_id, 'reason', v_reason);
    end if;
  end loop;
  return jsonb_build_object('done', to_jsonb(v_done), 'skipped', v_skip);
end $$;

create or replace function public.custody_metric(p_from date, p_to date)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_office uuid := private.current_office_id();
  v_today  date;
  v        jsonb;
begin
  if not private.has_role(array['admin', 'manager']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: Admin or Manager only' using errcode = '42501';
  end if;
  v_today := private.office_today(v_office);
  with rv as (
    select d.id, (d.reviewed_at at time zone 'Asia/Kolkata')::date as reviewed_on
      from public.document d
     where d.office_id = v_office and d.archived_at is null and d.received_as = 'hard_copy'
       and d.client_id is not null and d.doc_type_id is not null and d.status in ('reviewed', 'needs_correction')
       and (d.reviewed_at at time zone 'Asia/Kolkata')::date between p_from and p_to
       -- 13 pre-PR review I-2 (AC-18): leave out documents placed by the migration's backfill (no person, no history).
       and not (d.custody is not null and d.in_office_by is null
                and not exists (select 1 from public.document_custody h where h.document_id = d.id))
  ), placed as (
    select r.id from rv r
     where exists (
       select 1 from public.document_custody h
        where h.document_id = r.id and h.step = 'in_office' and not h.implied
          and (select count(*) from generate_series(r.reviewed_on + 1, (h.at at time zone 'Asia/Kolkata')::date, interval '1 day') g
                where extract(isodow from g) < 6) <= 2)
  ), sent as (
    select dp.dispatched_on - (max(h.at) at time zone 'Asia/Kolkata')::date as days
      from public.dispatch_item i
      join public.dispatch dp on dp.id = i.dispatch_id
      join public.document_custody h on h.document_id = i.document_id and h.step = 'ready' and not h.implied
     where i.office_id = v_office and i.removed_at is null and dp.dispatched_on between p_from and p_to
     group by i.id, dp.dispatched_on
  )
  select jsonb_build_object(
    'reviewed', (select count(*) from rv),
    'placed_2d', (select count(*) from placed),
    'ready_to_dispatched_median_days', (select percentile_cont(0.5) within group (order by days) from sent),
    'held_now', (select count(*) from public.document d
                  where d.office_id = v_office
                    and private.custody_held(exists (select 1 from public.dispatch_item di where di.document_id = d.id and di.removed_at is null),
                                             d.archived_at is not null, d.returnable, d.custody, d.in_office_at, v_today)))
    into v;
  return v;
end $$;

alter table public.document_custody alter column at set default clock_timestamp();
