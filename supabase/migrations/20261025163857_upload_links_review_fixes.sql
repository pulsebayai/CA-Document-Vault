-- Feature 10 step 8 — fixes from the pre-PR review and the security review of 10a (plan.md Deviations, step 8).
--   B1  the stored file name always ends in the stored object's extension (link_register).
--   I1  "Send again" can replace only your own link, unless you are Admin/Manager (insert_upload_request).
--   S-I1 NOT_ACTIVE from link_ticket / link_register is returned, not raised, so the failed-lookup row is kept.
--   I6  caps are checked under a row lock; tickets are capped per link (2 × max_files) — new column tickets_count.
--   I3  the ad-hoc item trigger fires on any change that decides "counts" (WHEN, not UPDATE OF: 03's BEFORE
--       trigger resets status without it being in the SET list).
--   I4  documents moved to another client or type no longer answer their item.
--   I5  channel 'upload_link' is set only by link_register and never changes (new guard trigger).

-- ── 1 ─────────────────────────────────────────────────────────────────────
alter table public.upload_request add column tickets_count integer not null default 0 check (tickets_count >= 0);
grant select (tickets_count) on public.upload_request to authenticated;

-- ── 2 ─────────────────────────────────────────────────────────────────────
create or replace function private.insert_upload_request(p_client uuid, p_follow_up uuid, p_token_hash text,
  p_items jsonb, p_replaces uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_office uuid := private.current_office_id(); v_me uuid := private.current_staff_id();
  v_id uuid; v_exp timestamptz; e jsonb; n_s int := 0; n_a int := 0;
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
  v_exp := private.upload_expires_at(v_office);
  insert into public.upload_request (office_id, client_id, token_hash, created_by, expires_at, follow_up_id)
    values (v_office, p_client, p_token_hash, v_me, v_exp, p_follow_up)
    returning id into v_id;
  for e in select * from jsonb_array_elements(p_items) loop
    if e->>'kind' = 'scheduled' then
      insert into public.upload_request_item (office_id, request_id, kind, expected_doc_id)
        values (v_office, v_id, 'scheduled', (e->>'expected_doc_id')::uuid);
      n_s := n_s + 1;
    else
      insert into public.upload_request_item (office_id, request_id, kind, doc_type_id, period_id, registration_id,
          needed_by, note)
        values (v_office, v_id, 'ad_hoc', (e->>'doc_type_id')::uuid, nullif(e->>'period_id', '')::uuid,
                nullif(e->>'registration_id', '')::uuid, nullif(e->>'needed_by', '')::date, nullif(e->>'note', ''));
      n_a := n_a + 1;
    end if;
  end loop;
  if p_replaces is not null then
    -- Review I1: "Send again" revokes the old link, so it follows the matrix row "Revoke an upload link someone
    -- else sent": your own link, or Admin/Manager.
    if not exists (select 1 from public.upload_request q where q.id = p_replaces and q.office_id = v_office
                     and (q.created_by = v_me or private.has_role(array['admin', 'manager']::public.staff_role[]))) then
      raise exception 'NOT_FOUND: the request to replace' using errcode = 'P0002';
    end if;
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
      'client_id', p_client, 'follow_up_id', p_follow_up, 'scheduled', n_s, 'ad_hoc', n_a, 'replaces', p_replaces)));
  return jsonb_build_object('request_id', v_id, 'expires_at', v_exp);
end $$;

-- ── 3 ─────────────────────────────────────────────────────────────────────
create or replace function public.link_ticket(p_token_hash text, p_item_id uuid, p_file jsonb, p_ip_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.upload_request; i public.upload_request_item; v_ext text := lower(coalesce(p_file->>'ext', ''));
        v_size bigint := coalesce(nullif(p_file->>'size', '')::bigint, 0);
begin
  r := private.link_request(p_token_hash, p_ip_hash);
  -- Review (security I1): returned, not raised, so the failed-lookup row link_request wrote is kept (AC-9).
  if r.id is null then return jsonb_build_object('error', 'NOT_ACTIVE'); end if;
  select * into r from public.upload_request where id = r.id for update;  -- caps are checked under the row lock
  i := private.link_item(r.id, p_item_id);
  if not private.link_ext_allowed(v_ext) then
    raise exception 'FILE_TYPE_NOT_ALLOWED: send PDF, JPG, PNG, HEIC, Excel, CSV or Word files' using errcode = '22023';
  end if;
  if v_size <= 0 then raise exception 'FILE_EMPTY: the file is empty' using errcode = '22023'; end if;
  if v_size > 26214400 then raise exception 'FILE_TOO_LARGE: each file can be up to 25 MB' using errcode = '22023'; end if;
  if r.files_count >= r.max_files or r.bytes_total + v_size > r.max_bytes then
    raise exception 'CAP_REACHED: this link has received the maximum number of files' using errcode = '54000';
  end if;
  -- Review I6/I2: tickets are capped for the link's lifetime (2 × max_files), so unregistered uploads can't
  -- fill storage without limit.
  if r.tickets_count >= 2 * r.max_files then
    raise exception 'CAP_REACHED: this link has received the maximum number of files' using errcode = '54000';
  end if;
  if (select count(*) from public.link_attempt a
       where a.request_id = r.id and a.kind = 'ticket' and a.at > now() - interval '1 hour') >= 60 then
    raise exception 'RATE_LIMITED: too many uploads in a short time; please try again later' using errcode = '54000';
  end if;
  insert into public.link_attempt (office_id, request_id, ip_hash, kind) values (r.office_id, r.id, p_ip_hash, 'ticket');
  perform set_config('app.upload_write', 'on', true);
  update public.upload_request set tickets_count = tickets_count + 1 where id = r.id;
  perform set_config('app.upload_write', '', true);
  return jsonb_build_object('office_id', r.office_id, 'document_id', gen_random_uuid());
end $$;

create or replace function public.link_register(p_token_hash text, p_item_id uuid, p_file jsonb, p_ip_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.upload_request; i public.upload_request_item; e public.expected_doc;
  v_path text := p_file->>'storage_path'; v_doc uuid; v_size bigint; v_res jsonb; d public.document;
  v_type uuid; v_period uuid; v_reg uuid; v_ext text; v_name text;
begin
  r := private.link_request(p_token_hash, p_ip_hash);
  if r.id is null then return jsonb_build_object('error', 'NOT_ACTIVE'); end if;  -- keeps the AC-9 log row
  select * into r from public.upload_request where id = r.id for update;  -- review I6: caps under the row lock
  i := private.link_item(r.id, p_item_id);
  v_doc := private.document_id_from_path(v_path, r.office_id);   -- PATH: must be under the link's own office
  v_ext := substring(v_path from '\.([a-z]+)$');
  if not private.link_ext_allowed(v_ext) then
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
  -- Review B1: the stored name always ends in the stored object's extension, whatever name the browser sent
  -- ("invoice.exe" becomes "invoice.pdf"), so a download can never save as another type. 03's checks still apply.
  v_name := btrim(regexp_replace(coalesce(p_file->>'file_name', ''), '\.[^./\\]*$', ''), ' .');
  if v_name = '' then v_name := 'file'; end if;
  v_name := left(v_name, 170) || '.' || v_ext;
  -- 03's own filing path with the requester's identity (link_request set the JWT claims). NB: create_document is
  -- invoker, but called from this definer function it runs as the owner, so RLS policies do NOT apply here; the
  -- office, link, item and can_see_client checks above are the authorisation. Triggers that read auth.uid() see
  -- the requester.
  perform set_config('app.link_register', 'on', true);
  v_res := public.create_document(jsonb_build_object(
    'client_id', r.client_id, 'doc_type_id', v_type, 'period_id', v_period, 'registration_id', v_reg,
    'received_as', 'soft_copy', 'channel', 'upload_link',
    'file', jsonb_build_object('storage_path', v_path, 'file_name', v_name)));
  perform set_config('app.link_register', '', true);
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
create or replace function private.recompute_request_item(p_item uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare i public.upload_request_item; r public.upload_request; v_on date;
begin
  select * into i from public.upload_request_item where id = p_item for update;
  if i.id is null or i.kind <> 'ad_hoc' or i.status = 'cancelled' then return; end if;
  select * into r from public.upload_request where id = i.request_id;
  -- Review I4: a document staff moved to another client or type no longer answers this item.
  select min(d.received_on) into v_on from public.document d
   where d.upload_request_item_id = p_item and d.office_id = i.office_id
     and d.client_id = r.client_id and d.doc_type_id = i.doc_type_id
     and d.archived_at is null and d.status <> 'needs_correction'
     and d.created_at > coalesce(i.reopened_at, '-infinity'::timestamptz);
  perform set_config('app.upload_write', 'on', true);
  if v_on is not null and (i.status <> 'received' or i.received_on is distinct from v_on) then
    update public.upload_request_item set status = 'received', received_on = v_on where id = p_item;
  elsif v_on is null and i.status = 'received' then
    update public.upload_request_item set status = 'open', received_on = null where id = p_item;
  end if;
  perform set_config('app.upload_write', '', true);
end $$;

-- ── 5 ─────────────────────────────────────────────────────────────────────
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
             'files', (select count(*) from public.document d where d.upload_request_item_id = it.id and d.archived_at is null
                        and d.client_id = r.client_id and d.doc_type_id = coalesce(e.doc_type_id, it.doc_type_id)))) as j
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

-- ── 6 ─────────────────────────────────────────────────────────────────────
-- I5: "from client link" is decided by the channel (badge, download-only until reviewed). Only link_register may
-- file a document with channel upload_link, and no one can change a document's channel to or from it.
create or replace function private.document_channel_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('app.purge_office', true), '') <> '' then return new; end if;
  if tg_op = 'INSERT' then
    if new.channel = 'upload_link' and coalesce(current_setting('app.link_register', true), '') <> 'on' then
      raise exception 'CHANNEL_LOCKED: only client upload links file documents with this channel' using errcode = '42501';
    end if;
  elsif (old.channel = 'upload_link') is distinct from (new.channel = 'upload_link') then
    raise exception 'CHANNEL_LOCKED: the channel of a document sent by upload link can''t change' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function private.document_channel_guard() from public, anon, authenticated;
create trigger document_channel_guard before insert or update of channel on public.document
  for each row execute function private.document_channel_guard();

-- ── 7 ─────────────────────────────────────────────────────────────────────
-- I3 + I4: re-check the item whenever something that decides "counts" changes, including 03's review reset.
drop trigger document_after_request_item_update on public.document;
create trigger document_after_request_item_update after update on public.document
  for each row when ((new.upload_request_item_id is not null or old.upload_request_item_id is not null)
    and (old.upload_request_item_id is distinct from new.upload_request_item_id
      or old.status is distinct from new.status
      or old.archived_at is distinct from new.archived_at
      or old.client_id is distinct from new.client_id
      or old.doc_type_id is distinct from new.doc_type_id))
  execute function private.document_after_request_item();
