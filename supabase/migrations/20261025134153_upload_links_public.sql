-- Feature 10 — Client upload links, migration C: the public path (spec AC-6…AC-15, AC-20, AC-21; plan step 4).
-- Schema + architecture lock: 10. Tests first: tests/rls/upload-links-public.test.ts.
--
-- The client has no session. The server (src/lib/upload-links/public.ts, server-only, service role) calls three
-- SECURITY DEFINER functions with the token's SHA-256 and a salted hash of the caller's IP. EXECUTE is granted to
-- service_role only. Each function checks, in this order: IP throttle → token → office (tenant) → link state →
-- item → file rules → caps → per-link throttle. Every "this link can't be used" answer is the same (NOT_ACTIVE),
-- whatever the reason, so a caller learns nothing about tokens (AC-8).
--
-- P1 (plan, approved 2026-10-25): a link upload is filed by 03's unchanged create_document, run AS THE REQUESTER:
-- the transaction-local JWT claims are switched to the requester before any filing or visibility check, so
-- 03's triggers, DOC-IDs, 04's linking and 07's To review behave exactly as for a staff upload, and the link stops
-- working when the requester is no longer active or can no longer see the client. A second activity row,
-- document.link_upload (actor null), records that the client did it.
--
-- Sections
--   1. upload_request_item.reopened_at; set_request_item records it (04's reopen rule)
--   2. Private helpers: throttle, resolve, act-as-requester, active check, item on link
--   3. link_open · link_ticket · link_register
--   4. Ad-hoc item status trigger on document (AC-12)
--   5. Test-office helper for the caps (service role, is_test only)
--   6. Grants

-- ── 1 ─────────────────────────────────────────────────────────────────────
alter table public.upload_request_item add column reopened_at timestamptz;

create or replace function private.set_request_item(p_id uuid, p_to public.upload_item_status, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_office uuid := private.current_office_id(); v_me uuid := private.current_staff_id(); v_client uuid;
begin
  perform set_config('app.upload_write', 'on', true);
  if p_to = 'cancelled' then
    update public.upload_request_item i
       set status = 'cancelled', cancel_reason = p_reason, cancelled_by = v_me, cancelled_at = now()
      from public.upload_request r
     where i.id = p_id and i.office_id = v_office and i.kind = 'ad_hoc' and i.status = 'open' and r.id = i.request_id
    returning r.client_id into v_client;
  else
    -- Reopen ("still waiting for more"): documents filed before now no longer count; the next one received does.
    update public.upload_request_item i set status = 'open', received_on = null, reopened_at = now()
      from public.upload_request r
     where i.id = p_id and i.office_id = v_office and i.kind = 'ad_hoc' and i.status = 'received' and r.id = i.request_id
    returning r.client_id into v_client;
  end if;
  perform set_config('app.upload_write', '', true);
  if v_client is null then
    raise exception 'ITEM_STATE: this requested document can''t be changed that way now' using errcode = 'P0001';
  end if;
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, v_me, case p_to when 'cancelled' then 'upload_request_item.cancelled' else 'upload_request_item.reopened' end,
            'upload_request_item', p_id::text, jsonb_build_object('client_id', v_client));
end $$;

-- ── 2 ─────────────────────────────────────────────────────────────────────
-- AC-9: ≥ 20 failed lookups from one IP in 10 minutes → that IP gets NOT_ACTIVE for everything for 10 minutes.
create or replace function private.link_ip_blocked(p_ip_hash text)
returns boolean language sql stable security definer set search_path = '' as $$
  select count(*) >= 20 from public.link_attempt a
   where a.ip_hash = p_ip_hash and a.kind = 'lookup_failed' and a.at > now() - interval '10 minutes'
$$;

create or replace function private.link_fail(p_ip_hash text, p_request public.upload_request)
returns void language sql security definer set search_path = '' as $$
  insert into public.link_attempt (office_id, request_id, ip_hash, kind)
  values (p_request.office_id, p_request.id, p_ip_hash, 'lookup_failed')
$$;

-- Switches this transaction's identity to the requester (P1). Local to the transaction.
create or replace function private.link_act_as(p_staff uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_staff, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_staff::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
end $$;

-- The request for a token hash, acting as its requester; null when the link can't be used for any reason:
-- unknown, revoked, expired (office day ≥ expiry date, IST), client archived, requester inactive or no longer
-- able to see the client. Logs a failed lookup (AC-9) when it returns null.
create or replace function private.link_request(p_token_hash text, p_ip_hash text)
returns public.upload_request language plpgsql security definer set search_path = '' as $$
declare r public.upload_request;
begin
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'BAD_IP_HASH' using errcode = '22023';
  end if;
  if private.link_ip_blocked(p_ip_hash) then return null; end if;
  if p_token_hash is not null and p_token_hash ~ '^[0-9a-f]{64}$' then
    select * into r from public.upload_request where token_hash = p_token_hash;
  end if;
  if r.id is null then
    insert into public.link_attempt (ip_hash, kind) values (p_ip_hash, 'lookup_failed');
    return null;
  end if;
  perform private.link_act_as(r.created_by);
  if r.revoked_at is not null
     or private.office_today(r.office_id) >= (r.expires_at at time zone 'Asia/Kolkata')::date
     or private.current_staff_id() is null
     or private.current_office_id() is distinct from r.office_id
     or not exists (select 1 from public.client c where c.id = r.client_id and c.office_id = r.office_id and c.archived_at is null)
     or not private.can_see_client(r.client_id) then
    perform private.link_fail(p_ip_hash, r);
    return null;
  end if;
  return r;
end $$;

-- An item of this request that still takes uploads (D4): scheduled items unless waived; ad-hoc unless cancelled.
create or replace function private.link_item(p_request uuid, p_item uuid)
returns public.upload_request_item language plpgsql stable security definer set search_path = '' as $$
declare i public.upload_request_item;
begin
  select it.* into i from public.upload_request_item it
    left join public.expected_doc e on e.id = it.expected_doc_id
   where it.id = p_item and it.request_id = p_request
     and ((it.kind = 'scheduled' and e.status in ('pending', 'received'))
       or (it.kind = 'ad_hoc' and it.status in ('open', 'received')));
  if i.id is null then
    raise exception 'ITEM_NOT_ON_LINK: this document is not on this link' using errcode = 'P0002';
  end if;
  return i;
end $$;

create or replace function private.link_ext_allowed(p_ext text)
returns boolean language sql immutable set search_path = '' as $$
  select lower(coalesce(p_ext, '')) in ('pdf', 'jpg', 'jpeg', 'png', 'heic', 'xlsx', 'xls', 'csv', 'docx') -- D3: no zip
$$;

-- ── 3 ─────────────────────────────────────────────────────────────────────
-- AC-6: the page's data. Only: firm name, requester's first name, dates, caps, and per item its labels (group,
-- type, period, the registration's state code — never the number), needed-by, note, state and the count of files
-- uploaded to it. Never the client's name, code, PAN, GSTIN, email or mobile, or any existing document.
create or replace function public.link_open(p_token_hash text, p_ip_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.upload_request; v_items jsonb;
begin
  r := private.link_request(p_token_hash, p_ip_hash);
  if r.id is null then return jsonb_build_object('active', false); end if;
  select coalesce(jsonb_agg(x.j order by x.sort, x.created_at), '[]'::jsonb) into v_items from (
    select it.created_at, case it.kind when 'scheduled' then 0 else 1 end as sort,
           jsonb_strip_nulls(jsonb_build_object(
             'id', it.id, 'kind', it.kind,
             'group', g.name, 'type', t.name, 'period', p.label,
             'state_code', case when t.registration_kind = 'gstin' then reg.state_code end,
             'reg_kind', t.registration_kind,
             'needed_by', it.needed_by, 'note', it.note,
             'received', case when it.kind = 'scheduled' then e.status = 'received' else it.status = 'received' end,
             'files', (select count(*) from public.document d where d.upload_request_item_id = it.id and d.archived_at is null))) as j
      from public.upload_request_item it
      left join public.expected_doc e on e.id = it.expected_doc_id
      join public.doc_type t on t.id = coalesce(e.doc_type_id, it.doc_type_id)
      join public.doc_group g on g.id = t.doc_group_id
      left join public.period p on p.id = coalesce(e.period_id, it.period_id)
      left join public.client_registration reg on reg.id = coalesce(e.registration_id, it.registration_id)
     where it.request_id = r.id
       and ((it.kind = 'scheduled' and e.status in ('pending', 'received'))
         or (it.kind = 'ad_hoc' and it.status in ('open', 'received')))) x;
  return jsonb_build_object(
    'active', true,
    'firm', (select o.name from public.office o where o.id = r.office_id),
    'requester', (select split_part(btrim(s.full_name), ' ', 1) from public.staff_user s where s.id = r.created_by),
    'sent_on', (r.created_at at time zone 'Asia/Kolkata')::date,
    'open_until', ((r.expires_at at time zone 'Asia/Kolkata')::date - 1),
    'files_count', r.files_count, 'max_files', r.max_files, 'bytes_total', r.bytes_total, 'max_bytes', r.max_bytes,
    'items', v_items);
end $$;

-- AC-7: before a browser upload. p_file: {ext, size}. Returns {office_id, document_id}; the server then signs
-- an upload URL for office/<office>/doc/<document>/<version>.<ext> (03's path). No row is written for a ticket
-- except the throttle log.
create or replace function public.link_ticket(p_token_hash text, p_item_id uuid, p_file jsonb, p_ip_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.upload_request; i public.upload_request_item; v_ext text := lower(coalesce(p_file->>'ext', ''));
        v_size bigint := coalesce(nullif(p_file->>'size', '')::bigint, 0);
begin
  r := private.link_request(p_token_hash, p_ip_hash);
  if r.id is null then raise exception 'NOT_ACTIVE: this link is no longer active' using errcode = 'P0001'; end if;
  i := private.link_item(r.id, p_item_id);
  if not private.link_ext_allowed(v_ext) then
    raise exception 'FILE_TYPE_NOT_ALLOWED: send PDF, JPG, PNG, HEIC, Excel, CSV or Word files' using errcode = '22023';
  end if;
  if v_size <= 0 then raise exception 'FILE_EMPTY: the file is empty' using errcode = '22023'; end if;
  if v_size > 26214400 then raise exception 'FILE_TOO_LARGE: each file can be up to 25 MB' using errcode = '22023'; end if;
  if r.files_count >= r.max_files or r.bytes_total + v_size > r.max_bytes then
    raise exception 'CAP_REACHED: this link has received the maximum number of files' using errcode = '54000';
  end if;
  if (select count(*) from public.link_attempt a
       where a.request_id = r.id and a.kind = 'ticket' and a.at > now() - interval '1 hour') >= 60 then
    raise exception 'RATE_LIMITED: too many uploads in a short time; please try again later' using errcode = '54000';
  end if;
  insert into public.link_attempt (office_id, request_id, ip_hash, kind) values (r.office_id, r.id, p_ip_hash, 'ticket');
  return jsonb_build_object('office_id', r.office_id, 'document_id', gen_random_uuid());
end $$;

-- AC-7, AC-11…AC-13, AC-15, AC-21: after the browser's PUT. p_file: {storage_path, file_name}. Files one
-- document classified by the item, as the requester (P1). Idempotent per stored object (the document id in the
-- path): registering the same object again returns the same document.
create or replace function public.link_register(p_token_hash text, p_item_id uuid, p_file jsonb, p_ip_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.upload_request; i public.upload_request_item; e public.expected_doc;
  v_path text := p_file->>'storage_path'; v_doc uuid; v_size bigint; v_res jsonb; d public.document;
  v_type uuid; v_period uuid; v_reg uuid;
begin
  r := private.link_request(p_token_hash, p_ip_hash);
  if r.id is null then raise exception 'NOT_ACTIVE: this link is no longer active' using errcode = 'P0001'; end if;
  i := private.link_item(r.id, p_item_id);
  v_doc := private.document_id_from_path(v_path, r.office_id);   -- PATH: must be under the link's own office
  if not private.link_ext_allowed(substring(v_path from '\.([a-z]+)$')) then
    raise exception 'FILE_TYPE_NOT_ALLOWED: send PDF, JPG, PNG, HEIC, Excel, CSV or Word files' using errcode = '22023';
  end if;
  select * into d from public.document where id = v_doc;
  if d.id is not null then
    if d.upload_request_item_id = i.id then
      return jsonb_build_object('document_id', d.id, 'doc_code', d.doc_code, 'duplicate', true);
    end if;
    raise exception 'DUPLICATE: this file is already registered' using errcode = '23505';
  end if;
  select (o.metadata->>'size')::bigint into v_size from storage.objects o where o.bucket_id = 'documents' and o.name = v_path;
  if v_size is null then raise exception 'OBJECT_MISSING: the uploaded file was not found in storage' using errcode = '23514'; end if;
  if r.files_count >= r.max_files or r.bytes_total + v_size > r.max_bytes then
    raise exception 'CAP_REACHED: this link has received the maximum number of files' using errcode = '54000';
  end if;
  if i.kind = 'scheduled' then
    select * into e from public.expected_doc where id = i.expected_doc_id;
    v_type := e.doc_type_id; v_period := e.period_id; v_reg := e.registration_id;
  else
    v_type := i.doc_type_id; v_period := i.period_id; v_reg := i.registration_id;
  end if;
  -- 03's own filing path, as the requester (link_request switched the identity).
  v_res := public.create_document(jsonb_build_object(
    'client_id', r.client_id, 'doc_type_id', v_type, 'period_id', v_period, 'registration_id', v_reg,
    'received_as', 'soft_copy', 'channel', 'upload_link',
    'file', jsonb_build_object('storage_path', v_path, 'file_name', p_file->>'file_name')));
  perform private.begin_doc_write();
  update public.document set upload_request_item_id = i.id where id = (v_res->>'id')::uuid;
  perform set_config('app.upload_write', 'on', true);
  update public.upload_request set files_count = files_count + 1, bytes_total = bytes_total + v_size where id = r.id;
  perform set_config('app.upload_write', '', true);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (r.office_id, null, 'document.link_upload', 'document', v_res->>'id',
            jsonb_build_object('client_id', r.client_id, 'request_id', r.id, 'item_id', i.id));
  -- D6: one bell notification to the requester per link per day (IDs only; text built at display time).
  if not exists (select 1 from public.notification n
                  where n.kind = 'link_upload' and n.entity_id = r.id
                    and (n.created_at at time zone 'Asia/Kolkata')::date = (now() at time zone 'Asia/Kolkata')::date) then
    perform private.notify(array[r.created_by], 'link_upload', 'upload_request', r.id, jsonb_build_object('request_id', r.id));
  end if;
  return jsonb_build_object('document_id', v_res->>'id', 'doc_code', v_res->>'doc_code', 'duplicate', false);
end $$;

-- ── 4 ─────────────────────────────────────────────────────────────────────
-- AC-12: an ad-hoc item is Received while a counting document (not archived, not Needs correction — 07's rule)
-- filed after its last reopen exists; received on = the earliest such document's received on. Cancelled items
-- are left alone. Scheduled items need nothing here: 04's linking already marks their expected document.
create or replace function private.recompute_request_item(p_item uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare i public.upload_request_item; v_on date;
begin
  select * into i from public.upload_request_item where id = p_item for update;
  if i.id is null or i.kind <> 'ad_hoc' or i.status = 'cancelled' then return; end if;
  select min(d.received_on) into v_on from public.document d
   where d.upload_request_item_id = p_item and d.archived_at is null and d.status <> 'needs_correction'
     and d.created_at > coalesce(i.reopened_at, '-infinity'::timestamptz);
  perform set_config('app.upload_write', 'on', true);
  if v_on is not null and (i.status <> 'received' or i.received_on is distinct from v_on) then
    update public.upload_request_item set status = 'received', received_on = v_on where id = p_item;
  elsif v_on is null and i.status = 'received' then
    update public.upload_request_item set status = 'open', received_on = null where id = p_item;
  end if;
  perform set_config('app.upload_write', '', true);
end $$;

create or replace function private.document_after_request_item()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.upload_request_item_id is not null
     and old.upload_request_item_id is distinct from new.upload_request_item_id then
    perform private.recompute_request_item(old.upload_request_item_id);
  end if;
  if new.upload_request_item_id is not null then
    perform private.recompute_request_item(new.upload_request_item_id);
  end if;
  return null;
end $$;
-- Fires only for documents that belong (or belonged) to an item, and only when what decides "counts" changes,
-- so ordinary saves pay nothing.
create trigger document_after_request_item_insert after insert on public.document
  for each row when (new.upload_request_item_id is not null)
  execute function private.document_after_request_item();
create trigger document_after_request_item_update after update of upload_request_item_id, status, archived_at on public.document
  for each row when (new.upload_request_item_id is not null or old.upload_request_item_id is not null)
  execute function private.document_after_request_item();

-- ── 5 ─────────────────────────────────────────────────────────────────────
-- Tests only: lower a link's caps in an is_test office (the real caps are 30 files / 300 MB, D5).
create or replace function public.test_set_link_caps(p_request uuid, p_max_files integer, p_max_bytes bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.upload_request r join public.office o on o.id = r.office_id
                  where r.id = p_request and o.is_test) then
    raise exception 'NOT_TEST_OFFICE: only links in offices flagged is_test can be changed' using errcode = '42501';
  end if;
  perform set_config('app.upload_write', 'on', true);
  update public.upload_request set max_files = p_max_files, max_bytes = p_max_bytes where id = p_request;
  perform set_config('app.upload_write', '', true);
end $$;

-- ── 6 ─────────────────────────────────────────────────────────────────────
revoke all on function
  private.link_ip_blocked(text), private.link_fail(text, public.upload_request), private.link_act_as(uuid),
  private.link_request(text, text), private.link_item(uuid, uuid), private.link_ext_allowed(text),
  private.recompute_request_item(uuid), private.document_after_request_item()
  from public, anon, authenticated;
revoke all on function
  public.link_open(text, text), public.link_ticket(text, uuid, jsonb, text), public.link_register(text, uuid, jsonb, text),
  public.test_set_link_caps(uuid, integer, bigint)
  from public, anon, authenticated;
grant execute on function
  public.link_open(text, text), public.link_ticket(text, uuid, jsonb, text), public.link_register(text, uuid, jsonb, text),
  public.test_set_link_caps(uuid, integer, bigint)
  to service_role;
