-- Feature 07 — migration D (PR #25 review questions 1 and 2, Raja approved 2026-10-01 21:15).
-- 1. update_document and add_document_version lock the document row before reading its status, so a review that
--    commits in between can't make the activity row miss `review_reset` or apply a corrected date to a document
--    that was just reviewed.
-- 2. A dispatched original (in a live packet) can't change client or "received as": undo the dispatch first.
--    Otherwise the packet's client and the document's would differ, and Return/state would disagree.
-- Both functions are 20261001123125's versions, changed only on the lines marked "D". Grants are kept (create or replace).

create or replace function public.update_document(p_id uuid, p jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  d public.document;
  n public.document;
  v_fields text[] := '{}';
  k text;
  v_reset boolean; -- 07
begin
  perform private.begin_doc_write(); -- review hardening: only functions write documents
  select * into d from public.document where id = p_id for update; -- D: lock, so the reset flag reads the current status
  if not found then raise exception 'NOT_FOUND: document' using errcode = 'P0002'; end if;
  if d.archived_at is not null then raise exception 'ARCHIVED: unarchive the document before changing it' using errcode = 'P0001'; end if;
  n := d;
  if p ? 'client_id'       then n.client_id       := nullif(p->>'client_id', '')::uuid; end if;
  if p ? 'doc_type_id'     then n.doc_type_id     := nullif(p->>'doc_type_id', '')::uuid; end if;
  if p ? 'period_id'       then n.period_id       := nullif(p->>'period_id', '')::uuid; end if;
  if p ? 'registration_id' then n.registration_id := nullif(p->>'registration_id', '')::uuid; end if;
  if p ? 'received_as'     then n.received_as     := (p->>'received_as')::public.received_as; end if;
  if p ? 'channel'         then n.channel         := (p->>'channel')::public.doc_channel; end if;
  if p ? 'received_on'     then n.received_on     := (p->>'received_on')::date; end if;
  if p ? 'received_by'     then n.received_by     := (p->>'received_by')::uuid; end if;
  if p ? 'remark'          then n.remark          := nullif(btrim(p->>'remark'), ''); end if;
  if n.received_as = 'soft_copy' and d.version_count = 0 then
    raise exception 'SOFT_COPY_NEEDS_FILE: a soft copy needs a file' using errcode = '23514';
  end if;
  foreach k in array array['client_id', 'doc_type_id', 'period_id', 'registration_id', 'received_as',
                           'channel', 'received_on', 'received_by', 'remark'] loop
    if (to_jsonb(n)->k) is distinct from (to_jsonb(d)->k) then v_fields := v_fields || k; end if;
  end loop;
  if cardinality(v_fields) = 0 then return; end if;
  -- D: a dispatched original keeps its client and stays an original (its packet would no longer match).
  if (v_fields && array['client_id', 'received_as'])
     and exists (select 1 from public.dispatch_item i where i.document_id = p_id and i.removed_at is null) then
    raise exception 'DISPATCHED: undo the dispatch before changing the client or how it was received' using errcode = 'P0001';
  end if;

  update public.document set client_id = n.client_id, doc_type_id = n.doc_type_id, period_id = n.period_id,
      registration_id = n.registration_id, received_as = n.received_as, channel = n.channel,
      received_on = n.received_on, received_by = n.received_by, remark = n.remark
    where id = p_id
    returning status = 'received' and d.status <> 'received' into v_reset; -- 07

  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (d.office_id, private.current_staff_id(),
            case when v_fields && array['client_id', 'doc_type_id'] then 'document.classified' else 'document.updated' end,
            'document', p_id::text,
            jsonb_strip_nulls(jsonb_build_object('fields', to_jsonb(v_fields), 'client_id', n.client_id, 'doc_type_id', n.doc_type_id,
              'review_reset', case when v_reset then true end))); -- 07
end $$;

create or replace function public.add_document_version(p_document_id uuid, p_file jsonb, p_received_on date default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare d public.document; v_id uuid; v_no integer; v_on boolean := false; v_status public.document_status;
begin
  perform private.begin_doc_write(); -- review hardening: only functions write documents
  select * into d from public.document where id = p_document_id for update; -- D: lock (status read for the corrected date and the reset flag)
  if not found then raise exception 'NOT_FOUND: document' using errcode = 'P0002'; end if;
  if d.archived_at is not null then raise exception 'ARCHIVED: unarchive the document before changing it' using errcode = 'P0001'; end if;
  if p_received_on is not null and d.status = 'needs_correction' and p_received_on <> d.received_on then -- 07
    update public.document set received_on = p_received_on where id = d.id; -- the trigger refuses a future date
    v_on := true;
  end if;
  insert into public.document_version (office_id, document_id, storage_path, file_name)
    values (d.office_id, d.id, p_file->>'storage_path', p_file->>'file_name')
    returning id, version_no into v_id, v_no;
  select x.status into v_status from public.document x where x.id = d.id; -- 07
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (d.office_id, private.current_staff_id(), 'document.version_added', 'document', d.id::text,
            jsonb_strip_nulls(jsonb_build_object('version_id', v_id, 'version_no', v_no,
              'fields', case when v_on then to_jsonb(array['received_on']) end,
              'review_reset', case when d.status <> 'received' and v_status = 'received' then true end)));
  return jsonb_build_object('version_id', v_id, 'version_no', v_no);
end $$;
