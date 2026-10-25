-- Feature 10 step 9 — Client › Requested (spec AC-16, AC-18).
--   1. Send again carries the old request's open ad-hoc items over (they move, keeping their identity and
--      documents) instead of copying them: item kind 'carry' in upload_items / insert_upload_request.
--   2. Upload from Client › Requested: create_document_for_item files a document through 03's create_document and
--      links it to the ad-hoc item in the same transaction (client and type come from the item).

-- ── 1 ─────────────────────────────────────────────────────────────────────
create or replace function private.upload_items(p_client uuid, p_items jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_office uuid := private.current_office_id();
  v_today  date := private.office_today(v_office);
  v_out    jsonb := '[]'::jsonb;
  v_sched  uuid[] := '{}';
  e jsonb; t public.doc_type; v_period uuid; v_reg uuid; v_need date; v_note text; v_pii text;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'NO_ITEMS: choose at least one document to request' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception 'TOO_MANY_ITEMS: a request holds at most 50 documents' using errcode = '22023';
  end if;
  for e in select * from jsonb_array_elements(p_items) loop
    if e->>'kind' = 'scheduled' then
      v_sched := v_sched || (e->>'expected_doc_id')::uuid;
    elsif e->>'kind' = 'ad_hoc' then
      select * into t from public.doc_type
       where id = nullif(e->>'doc_type_id', '')::uuid and office_id = v_office and active and source = 'client'
         and (status = 'approved' or (status = 'proposed' and proposed_for_client_id = p_client));
      if not found then
        raise exception 'TYPE_INVALID: choose a document type this client can use' using errcode = '22023';
      end if;
      v_period := nullif(e->>'period_id', '')::uuid;
      if v_period is not null and (t.period_kind = 'none' or not exists (
           select 1 from public.period p where p.id = v_period and p.office_id = v_office and p.kind = t.period_kind)) then
        raise exception 'PERIOD_INVALID: the period doesn''t fit this document type' using errcode = '22023';
      end if;
      v_reg := nullif(e->>'registration_id', '')::uuid;
      if v_reg is not null and (t.registration_kind is null or not exists (
           select 1 from public.client_registration r
            where r.id = v_reg and r.client_id = p_client and r.active and r.kind = t.registration_kind)) then
        raise exception 'REGISTRATION_INVALID: choose one of this client''s active registrations of that kind' using errcode = '22023';
      end if;
      v_need := nullif(e->>'needed_by', '')::date;
      if v_need is not null and v_need < v_today then
        raise exception 'NEEDED_BY_PAST: the needed-by date can''t be in the past' using errcode = '22023';
      end if;
      v_note := nullif(btrim(coalesce(e->>'note', '')), '');
      if length(v_note) > 200 then
        raise exception 'NOTE_TOO_LONG: keep the note to 200 characters' using errcode = '22023';
      end if;
      v_pii := private.note_pii(v_note);
      if v_pii is not null then
        raise exception 'NOTE_PII: % — notes are shown to anyone with the link; remove numbers and IDs', v_pii
          using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object('kind', 'ad_hoc', 'doc_type_id', t.id, 'period_id', v_period,
        'registration_id', v_reg, 'needed_by', v_need, 'note', v_note);
    elsif e->>'kind' = 'carry' then
      -- 10 step 9 (Send again): an open ad-hoc item of the request being replaced moves to the new request.
      -- insert_upload_request checks it belongs to that request and is still open.
      if coalesce(e->>'item_id', '') !~ '^[0-9a-f-]{36}$' then
        raise exception 'ITEM_KIND: each item is scheduled, ad_hoc or carry' using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object('kind', 'carry', 'item_id', (e->>'item_id')::uuid);
    else
      raise exception 'ITEM_KIND: each item is scheduled, ad_hoc or carry' using errcode = '22023';
    end if;
  end loop;
  if cardinality(v_sched) > 0 then
    v_sched := private.follow_up_items(p_client, v_sched);  -- 06: open, the client's, not on hold; distinct
    v_out := (select coalesce(jsonb_agg(jsonb_build_object('kind', 'scheduled', 'expected_doc_id', x)), '[]'::jsonb)
                from unnest(v_sched) x) || v_out;
  end if;
  return v_out;
end $$;

create or replace function private.insert_upload_request(p_client uuid, p_follow_up uuid, p_token_hash text,
  p_items jsonb, p_replaces uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_office uuid := private.current_office_id(); v_me uuid := private.current_staff_id();
  v_id uuid; v_exp timestamptz; e jsonb; n_s int := 0; n_a int := 0; n_c int := 0;
begin
  if v_office is null or v_me is null
     or not exists (select 1 from public.client where id = p_client and office_id = v_office and archived_at is null)
     or not private.can_see_client(p_client) then
    raise exception 'NOT_FOUND: client' using errcode = 'P0002';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'BAD_TOKEN_HASH' using errcode = '22023';
  end if;
  if p_follow_up is not null and not exists (
       select 1 from public.follow_up f where f.id = p_follow_up and f.client_id = p_client and f.sent_by = v_me) then
    raise exception 'NOT_FOUND: follow-up' using errcode = 'P0002';
  end if;
  if p_replaces is not null then
    -- Review I1: "Send again" revokes the old link, so it follows the matrix row "Revoke an upload link someone
    -- else sent": your own link, or Admin/Manager. Checked before anything is written.
    if not exists (select 1 from public.upload_request q where q.id = p_replaces and q.office_id = v_office
                     and (q.created_by = v_me or private.has_role(array['admin', 'manager']::public.staff_role[]))) then
      raise exception 'NOT_FOUND: the request to replace' using errcode = 'P0002';
    end if;
  end if;
  v_exp := private.upload_expires_at(v_office);
  insert into public.upload_request (office_id, client_id, token_hash, created_by, expires_at, follow_up_id)
    values (v_office, p_client, p_token_hash, v_me, v_exp, p_follow_up)
    returning id into v_id;
  for e in select * from jsonb_array_elements(p_items) loop
    if e->>'kind' = 'scheduled' then
      insert into public.upload_request_item (office_id, request_id, kind, expected_doc_id)
        values (v_office, v_id, 'scheduled', (e->>'expected_doc_id')::uuid);
      n_s := n_s + 1;
    elsif e->>'kind' = 'carry' then
      -- Step 9: the item keeps its identity (and any documents linked to it) and moves to the new request.
      if p_replaces is null then
        raise exception 'ITEM_STATE: only Send again can carry a requested document over' using errcode = 'P0001';
      end if;
      perform set_config('app.upload_write', 'on', true);
      update public.upload_request_item set request_id = v_id
       where id = (e->>'item_id')::uuid and request_id = p_replaces and office_id = v_office
         and kind = 'ad_hoc' and status = 'open';
      if not found then
        raise exception 'ITEM_STATE: a requested document changed meanwhile; refresh and try again' using errcode = 'P0001';
      end if;
      perform set_config('app.upload_write', '', true);
      n_c := n_c + 1;
    else
      insert into public.upload_request_item (office_id, request_id, kind, doc_type_id, period_id, registration_id,
          needed_by, note)
        values (v_office, v_id, 'ad_hoc', (e->>'doc_type_id')::uuid, nullif(e->>'period_id', '')::uuid,
                nullif(e->>'registration_id', '')::uuid, nullif(e->>'needed_by', '')::date, nullif(e->>'note', ''));
      n_a := n_a + 1;
    end if;
  end loop;
  if p_replaces is not null then
    perform set_config('app.upload_write', 'on', true);
    update public.upload_request
       set revoked_at = coalesce(revoked_at, now()), revoked_by = coalesce(revoked_by, v_me), replaced_by = v_id
     where id = p_replaces and office_id = v_office and client_id = p_client and replaced_by is null;
    if not found then
      raise exception 'NOT_FOUND: the request to replace' using errcode = 'P0002';
    end if;
    perform set_config('app.upload_write', '', true);
  end if;
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, v_me, 'upload_request.created', 'upload_request', v_id::text, jsonb_strip_nulls(jsonb_build_object(
      'client_id', p_client, 'follow_up_id', p_follow_up, 'scheduled', n_s, 'ad_hoc', n_a + n_c, 'replaces', p_replaces)));
  return jsonb_build_object('request_id', v_id, 'expires_at', v_exp);
end $$;

-- ── 2 ─────────────────────────────────────────────────────────────────────
-- Definer: sets document.upload_request_item_id (no app role has that column). Called only by the invoker below
-- after its checks; re-checks office, client and type itself (tenant first).
create or replace function private.link_document_to_item(p_document uuid, p_item uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_office uuid := private.current_office_id(); i public.upload_request_item; r public.upload_request; d public.document;
begin
  select * into i from public.upload_request_item where id = p_item and office_id = v_office;
  select * into r from public.upload_request where id = i.request_id;
  select * into d from public.document where id = p_document and office_id = v_office;
  if i.id is null or d.id is null or i.kind <> 'ad_hoc' or d.client_id is distinct from r.client_id
     or d.doc_type_id is distinct from i.doc_type_id or d.upload_request_item_id is not null then
    raise exception 'ITEM_STATE: this requested document can''t be filed that way' using errcode = 'P0001';
  end if;
  perform private.begin_doc_write();
  update public.document set upload_request_item_id = p_item where id = p_document;
end $$;

-- AC-16 "Upload": staff file a document for an open (or received, D4) ad-hoc item. p = create_document's argument; client and type
-- are the item's, and the item's period / registration when it has them. One transaction: document + version +
-- 03's activity row + the link (the item becomes Received through its trigger) + one upload_request_item.filed row.
create or replace function public.create_document_for_item(p_item uuid, p jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare i public.upload_request_item; v_client uuid; v_res jsonb;
begin
  select * into i from public.upload_request_item where id = p_item;   -- RLS: only items of visible clients
  if not found then raise exception 'NOT_FOUND: requested document' using errcode = 'P0002'; end if;
  select q.client_id into v_client from public.upload_request q where q.id = i.request_id;
  if i.kind <> 'ad_hoc' or i.status not in ('open', 'received') then  -- D4: a received item still takes files
    raise exception 'ITEM_STATE: this requested document was cancelled' using errcode = 'P0001';
  end if;
  v_res := public.create_document(coalesce(p, '{}'::jsonb) || jsonb_build_object(
    'client_id', v_client, 'doc_type_id', i.doc_type_id,
    'period_id', coalesce(i.period_id::text, nullif(p->>'period_id', '')),
    'registration_id', coalesce(i.registration_id::text, nullif(p->>'registration_id', ''))));
  perform private.link_document_to_item((v_res->>'id')::uuid, p_item);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (i.office_id, private.current_staff_id(), 'upload_request_item.filed', 'upload_request_item', p_item::text,
            jsonb_build_object('client_id', v_client, 'document_id', v_res->>'id'));
  return v_res;
end $$;

revoke all on function private.link_document_to_item(uuid, uuid) from public, anon;
grant execute on function private.link_document_to_item(uuid, uuid) to authenticated;
revoke all on function public.create_document_for_item(uuid, jsonb) from public, anon;
grant execute on function public.create_document_for_item(uuid, jsonb) to authenticated;
