-- Feature 05 — migration B, part 3 of 3: public functions + reset_test_office (sections 6–7 of the reviewed migration B;
-- SQL gate approved by Raja 2026-10-02 13:30).

-- ── 6. Public functions (SECURITY INVOKER: RLS and column grants apply as the caller) ──────────────────

-- The queue (AC-1): one item per group + name, oldest first. Admin/Manager only (Raja 2026-10-02 12:57).
create or replace function public.proposal_queue()
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_office uuid := private.current_office_id(); v jsonb;
begin
  perform private.require_decider();
  with prop as (
    select t.id, t.name, t.doc_group_id, t.proposed_by, t.proposed_for_client_id, t.created_at,
           first_value(t.id) over w as survivor, first_value(t.name) over w as item_name
      from public.doc_type t
     where t.office_id = v_office and t.status = 'proposed'
    window w as (partition by t.doc_group_id, lower(t.name) order by t.created_at, t.id)
  ), items as (
    select r.survivor, min(r.item_name) as name, min(r.doc_group_id::text)::uuid as doc_group_id,
           array_agg(r.id order by r.created_at, r.id) as type_ids,
           array_agg(distinct r.proposed_by) as proposed_by,
           min(r.created_at) as proposed_at,
           array_agg(distinct r.proposed_for_client_id) as client_ids
      from prop r group by r.survivor
  )
  select jsonb_build_object(
    'waiting', (select count(*) from items),
    'items', coalesce(jsonb_agg(jsonb_build_object(
        'type_id', i.survivor, 'type_ids', to_jsonb(i.type_ids), 'name', i.name, 'doc_group_id', i.doc_group_id,
        'group_name', g.name, 'proposed_by', to_jsonb(i.proposed_by), 'proposed_at', i.proposed_at,
        'client_count', cardinality(i.client_ids),
        'clients', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.name)
                               from public.client c where c.id = any (i.client_ids)), '[]'::jsonb),
        'document_count', (select count(*) from public.document d where d.doc_type_id = any (i.type_ids)))
      order by i.proposed_at, i.survivor), '[]'::jsonb))
    into v
    from items i join public.doc_group g on g.id = i.doc_group_id;
  return v;
end $$;

-- AC-8 / AC-7 / AC-3: what a decision would do, without writing. The decision runs for real inside a
-- sub-transaction that is then rolled back, so the numbers are the decision's own (spec test "preview = effect").
-- A period conflict is reported (with the documents) instead of running.
create or replace function public.preview_type_decision(p jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_action text := p->>'action';
  v_type   uuid := nullif(p->>'type_id', '')::uuid;
  v_target uuid := nullif(p->>'target_id', '')::uuid;
  v_rows   uuid[];
  v_kind   public.period_kind;
  v_conf   jsonb;
  v_res    jsonb;
begin
  perform private.require_decider();
  if v_action not in ('approve', 'merge') then raise exception 'INVALID: action' using errcode = '22023'; end if;
  v_rows := private.type_item(v_type, false);
  if v_action = 'merge' then
    v_kind := (private.merge_target(v_target, v_rows)).period_kind;
  else
    select coalesce((p->'edits'->>'period_kind')::public.period_kind, t.period_kind) into v_kind
      from public.doc_type t where t.id = v_rows[1];
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('document_id', c.document_id, 'doc_code', c.doc_code) order by c.doc_code), '[]')
    into v_conf from private.period_conflicts(v_rows, v_kind) c;
  if jsonb_array_length(v_conf) > 0 then
    return jsonb_build_object(
      'documents', (select count(*) from public.document d where d.doc_type_id = any (v_rows)),
      'clients', (select count(distinct t.proposed_for_client_id) from public.doc_type t where t.id = any (v_rows)),
      'plan_added', 0, 'received', 0, 'conflicts', v_conf);
  end if;
  begin
    if v_action = 'merge' then
      v_res := private.decide_merge(v_type, v_target, null);
    else
      v_res := private.decide_approve(jsonb_build_object('type_id', v_type, 'edits', coalesce(p->'edits', '{}'::jsonb)));
    end if;
    raise exception 'PREVIEW_ROLLBACK';
  exception when others then
    if sqlerrm <> 'PREVIEW_ROLLBACK' then raise; end if;
  end;
  return jsonb_build_object('documents', v_res->'documents', 'clients', v_res->'clients',
                            'plan_added', v_res->'plan_added', 'received', v_res->'received', 'conflicts', '[]'::jsonb);
end $$;

-- AC-2 / AC-3 / AC-4. p = { type_id, edits?, comment? } → { type_id (the approved type), documents, clients, plan_added, received }
create or replace function public.approve_proposed_type(p jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  return private.decide_approve(p);
end $$;

-- AC-5 … AC-7 → { documents, clients, plan_added, received }
create or replace function public.merge_proposed_type(p_type uuid, p_target uuid, p_comment text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  return private.decide_merge(p_type, p_target, p_comment);
end $$;

-- AC-9: only an item with no documents (archived included); reason 1–500; rows retired, plan rows removed.
create or replace function public.reject_proposed_type(p_type uuid, p_comment text)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_office  uuid := private.current_office_id();
  v_staff   uuid := private.current_staff_id();
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  v_rows    uuid[];
  v_docs    integer;
  v_removed integer;
begin
  perform private.require_decider();
  if v_comment is null or length(v_comment) > 500 then
    raise exception 'REASON_REQUIRED: give a reason of 1–500 characters' using errcode = '23514';
  end if;
  v_rows := private.type_item(p_type, true);
  select count(*) into v_docs from public.document d where d.doc_type_id = any (v_rows);
  if v_docs > 0 then
    raise exception 'HAS_DOCUMENTS: % documents use this type; merge it into an approved type instead', v_docs using errcode = 'P0001';
  end if;
  with removed as (
    update public.client_doc_type set state = 'removed'
     where doc_type_id = any (v_rows) and state <> 'removed'
    returning id, client_id)
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    select v_office, v_staff, 'client_doc_type.removed', 'client_doc_type', id::text,
           jsonb_build_object('fields', jsonb_build_array('state'), 'client_id', client_id)
      from removed;
  get diagnostics v_removed = row_count;
  perform set_config('app.type_decision', 'on', true);
  update public.doc_type set status = 'rejected', active = false, decided_by = v_staff, decided_at = now(),
      decision_comment = v_comment
   where id = any (v_rows);
  perform set_config('app.type_decision', '', true);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, v_staff, 'doc_type.rejected', 'doc_type', v_rows[1]::text,
            jsonb_build_object('doc_type_ids', to_jsonb(v_rows), 'documents', 0,
                               'clients', (select count(distinct t.proposed_for_client_id) from public.doc_type t where t.id = any (v_rows)),
                               'plan_rows', jsonb_build_object('removed', v_removed, 'added', 0)));
  perform private.notify((select array_agg(distinct x.proposed_by) from public.doc_type x where x.id = any (v_rows)),
                         'type_decision', 'doc_type', v_rows[1],
                         jsonb_build_object('decision', 'rejected', 'doc_type_id', v_rows[1]));
end $$;

-- Metric 3 (AC-16): classified, non-archived documents under approved types ÷ all classified, non-archived;
-- plus the queue: items waiting and the oldest one's age in office days. Admin/Manager only.
create or replace function public.catalogue_metric()
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_office uuid := private.current_office_id(); v_approved bigint; v_total bigint; v_oldest timestamptz;
begin
  if not private.has_role(array['admin', 'manager']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: only Admin or Manager can see the catalogue metric' using errcode = '42501';
  end if;
  select count(*) filter (where t.status = 'approved'), count(*) into v_approved, v_total
    from public.document d join public.doc_type t on t.id = d.doc_type_id
   where d.office_id = v_office and d.classified_at is not null and d.archived_at is null;
  select min(t.created_at) into v_oldest from public.doc_type t where t.office_id = v_office and t.status = 'proposed';
  return jsonb_build_object(
    'approved', v_approved, 'total', v_total,
    'approved_pct', case when v_total = 0 then null else round(100.0 * v_approved / v_total, 1) end,
    'waiting', (select count(distinct (t.doc_group_id, lower(t.name))) from public.doc_type t
                 where t.office_id = v_office and t.status = 'proposed'),
    'oldest_days', case when v_oldest is null then null
                        else private.office_today(v_office) - (v_oldest at time zone 'Asia/Kolkata')::date end);
end $$;

revoke all on function public.proposal_queue(), public.preview_type_decision(jsonb), public.approve_proposed_type(jsonb),
  public.merge_proposed_type(uuid, uuid, text), public.reject_proposed_type(uuid, text), public.catalogue_metric()
  from public, anon;
grant execute on function public.proposal_queue(), public.preview_type_decision(jsonb), public.approve_proposed_type(jsonb),
  public.merge_proposed_type(uuid, uuid, text), public.reject_proposed_type(uuid, text), public.catalogue_metric()
  to authenticated;

-- ── 7. reset_test_office: 07's body + notifications and decided proposals (lines marked "05") ──────────
create or replace function public.reset_test_office(p_office_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.office where id = p_office_id and is_test) then
    raise exception 'NOT_TEST_OFFICE: only offices flagged is_test can be reset' using errcode = '42501';
  end if;
  perform set_config('app.purge_office', p_office_id::text, true);
  delete from public.notification        where office_id = p_office_id; -- 05
  delete from public.dispatch_item       where office_id = p_office_id; -- 07
  delete from public.dispatch            where office_id = p_office_id; -- 07
  delete from public.document_review     where office_id = p_office_id; -- 07
  update public.expected_doc set completed_by_document_id = null where office_id = p_office_id and completed_by_document_id is not null;
  update public.document set current_version_id = null, expected_doc_id = null
   where office_id = p_office_id and (current_version_id is not null or expected_doc_id is not null);
  delete from public.expected_doc        where office_id = p_office_id;
  delete from public.document_version    where office_id = p_office_id;
  delete from public.document            where office_id = p_office_id;
  delete from public.doc_counter         where office_id = p_office_id;
  delete from public.client_doc_type     where office_id = p_office_id;
  delete from public.client_group        where office_id = p_office_id;
  delete from public.doc_type            where office_id = p_office_id and status <> 'approved'; -- 05: + mapped, rejected
  delete from public.client_registration where office_id = p_office_id;
  delete from public.client_contact      where office_id = p_office_id;
  delete from public.client              where office_id = p_office_id;
  delete from public.period              where office_id = p_office_id;
  delete from public.financial_year      where office_id = p_office_id;
  delete from public.doc_type            where office_id = p_office_id;
  delete from public.doc_group           where office_id = p_office_id;
  perform set_config('app.purge_office', '', true);
  update public.office set client_code_counter = 0, test_today = null where id = p_office_id;
  perform private.seed_catalogue(p_office_id);
end $$;
