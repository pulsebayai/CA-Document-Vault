-- Feature 10 — Client upload links, migration B: staff functions (spec AC-1…AC-5, AC-16, AC-18, AC-21;
-- plan step 2). Schema + architecture lock: 10. Tests first: tests/rls/upload-links-staff.test.ts.
--
-- Deviation from plan step 2 (recorded in plan.md): 06's begin_email_reminder / record_follow_up are NOT changed.
-- Sending a link uses two new functions that reuse 06's private helpers (client check, item check, stale-email
-- close, the per-client cap, the office ceiling, insert_follow_up), so 06's functions and tests stay untouched
-- and a request may hold ad-hoc items only (06's functions require ≥ 1 expected item).
--
-- Sections
--   1. Note PII check (AC-4) — the same patterns as src/lib/upload-links/note.ts (test vectors shared)
--   2. Item parsing and checks (invoker: RLS applies)
--   3. Definer writers (the only INSERT/UPDATE paths; app.upload_write)
--   4. Public functions: begin_link_email · record_link_whatsapp · retry_link_email · revoke_upload_request ·
--      cancel_request_item · reopen_request_item
--   5. Grants
--
-- Link expiry (D2): open through the 14th office day after creation (IST): expires_at = start of day 15 in India.
-- A test office's clock (office.test_today) moves that day like every other 04/06 date rule.

-- Migration A's expiry check compared with real time; a link's expiry follows the office day instead (D2, and
-- test offices run on a past clock), so the check goes. Active = office today < the expiry date (IST).
alter table public.upload_request drop constraint upload_request_expiry;

-- ── 1 ─────────────────────────────────────────────────────────────────────
-- Returns the first kind of personal data found, or null. Notes are shown to anyone holding the link.
create or replace function private.note_pii(p text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p is null then null
    when upper(p) ~ '[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]' then 'GSTIN'
    when upper(p) ~ '[A-Z]{5}[0-9]{4}[A-Z]' then 'PAN'
    when upper(p) ~ '[A-Z]{4}[0-9]{5}[A-Z]' then 'TAN'
    when p ~ '[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+' then 'EMAIL'
    when regexp_replace(p, '[[:space:]().+-]', '', 'g') ~ '(91)?[6-9][0-9]{9}' then 'MOBILE'
    when regexp_replace(p, '[[:space:]-]', '', 'g') ~ '[0-9]{9,}' then 'NUMBER'
  end
$$;

-- ── 2 ─────────────────────────────────────────────────────────────────────
-- p_items: [{kind:'scheduled', expected_doc_id} | {kind:'ad_hoc', doc_type_id, period_id?, registration_id?,
-- needed_by?, note?}], 1–50 entries. Returns the normalised array. Scheduled items go through 06's check (open,
-- the client's, not on hold). Ad-hoc types must be usable for this client: active, client-source, approved — or
-- proposed for this very client (03's inline proposal, Staff+ only, made before calling).
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
    else
      raise exception 'ITEM_KIND: each item is scheduled or ad_hoc' using errcode = '22023';
    end if;
  end loop;
  if cardinality(v_sched) > 0 then
    v_sched := private.follow_up_items(p_client, v_sched);  -- 06: open, the client's, not on hold; distinct
    v_out := (select coalesce(jsonb_agg(jsonb_build_object('kind', 'scheduled', 'expected_doc_id', x)), '[]'::jsonb)
                from unnest(v_sched) x) || v_out;
  end if;
  return v_out;
end $$;

create or replace function private.upload_scheduled_ids(p_items jsonb)
returns uuid[] language sql immutable set search_path = '' as $$
  select coalesce(array_agg((e->>'expected_doc_id')::uuid), '{}')
    from jsonb_array_elements(p_items) e where e->>'kind' = 'scheduled'
$$;

-- The visible request, or NOT_FOUND (RLS + the client check).
create or replace function private.upload_request_visible(p_id uuid)
returns public.upload_request language plpgsql stable set search_path = '' as $$
declare r public.upload_request;
begin
  select q.id, q.office_id, q.client_id, null::text, q.created_by, q.created_at, q.expires_at, q.revoked_at,
         q.revoked_by, q.replaced_by, q.follow_up_id, q.max_files, q.max_bytes, q.files_count, q.bytes_total
    into r from public.upload_request q
   where q.id = p_id and q.office_id = (select private.current_office_id());
  if not found then raise exception 'NOT_FOUND: upload request' using errcode = 'P0002'; end if;
  return r;
end $$;

create or replace function private.upload_expires_at(p_office uuid)
returns timestamptz language sql stable set search_path = '' as $$
  select ((private.office_today(p_office) + 15)::timestamp at time zone 'Asia/Kolkata')
$$;

-- ── 3 ─────────────────────────────────────────────────────────────────────
-- Definer: the only INSERT path for requests and items. Re-derives office and caller from the JWT and re-checks
-- the client (defence in depth). p_items is the output of private.upload_items. One activity row.
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

-- Definer: a failed email's link was never delivered, so its token is replaced and a new follow-up attached.
create or replace function private.rotate_upload_token(p_id uuid, p_token_hash text, p_follow_up uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_office uuid := private.current_office_id(); v_me uuid := private.current_staff_id(); v_client uuid;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'BAD_TOKEN_HASH' using errcode = '22023';
  end if;
  perform set_config('app.upload_write', 'on', true);
  update public.upload_request set token_hash = p_token_hash, follow_up_id = p_follow_up
   where id = p_id and office_id = v_office and created_by = v_me returning client_id into v_client;
  perform set_config('app.upload_write', '', true);
  if v_client is null then raise exception 'NOT_FOUND: upload request' using errcode = 'P0002'; end if;
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, v_me, 'upload_request.retried', 'upload_request', p_id::text,
            jsonb_build_object('client_id', v_client, 'follow_up_id', p_follow_up));
end $$;

create or replace function private.revoke_request(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_office uuid := private.current_office_id(); v_me uuid := private.current_staff_id(); v_client uuid;
begin
  perform set_config('app.upload_write', 'on', true);
  update public.upload_request set revoked_at = now(), revoked_by = v_me
   where id = p_id and office_id = v_office and revoked_at is null returning client_id into v_client;
  perform set_config('app.upload_write', '', true);
  if v_client is null then raise exception 'ALREADY_REVOKED: this link is no longer active' using errcode = 'P0001'; end if;
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, v_me, 'upload_request.revoked', 'upload_request', p_id::text, jsonb_build_object('client_id', v_client));
end $$;

-- p_to: 'cancelled' (with reason) or 'open' (reopen a received ad-hoc item).
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
    update public.upload_request_item i set status = 'open', received_on = null
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

-- ── 4 ─────────────────────────────────────────────────────────────────────
-- AC-1, AC-2: email the client a reminder carrying an upload link. Phase 1 of 06's two-phase send: the follow-up
-- is pending (06's cap and office ceiling apply) and the request exists before Brevo is called; the server action
-- then calls the mailer and 06's finish_email_reminder. p: {client_id, items, token_hash, daily_max?, replaces?}.
create or replace function public.begin_link_email(p jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c public.client; v_items jsonb; v_today date; v_fu uuid; v_req jsonb;
begin
  c := private.follow_up_client(nullif(p->>'client_id', '')::uuid);
  v_items := private.upload_items(c.id, p->'items');
  if c.email is null then
    raise exception 'NO_EMAIL: this client has no email address' using errcode = '22023';
  end if;
  v_today := private.office_today(c.office_id);
  perform private.close_stale_emails(c.id);
  if exists (select 1 from public.follow_up f
              where f.client_id = c.id and f.sent_on = v_today and f.channel = 'email'
                and f.status in ('pending', 'sent', 'suppressed')) then
    raise exception 'ALREADY_EMAILED_TODAY: one email per client per day' using errcode = '23505';
  end if;
  if private.office_emails_today(v_today) >= greatest(coalesce(nullif(p->>'daily_max', '')::int, 200), 0) then
    raise exception 'DAILY_LIMIT: the office''s daily email limit is reached' using errcode = '54000';
  end if;
  begin
    v_fu := private.insert_follow_up(c.id, 'email', 'pending', v_today, c.email, null, private.upload_scheduled_ids(v_items));
  exception when unique_violation then
    raise exception 'ALREADY_EMAILED_TODAY: one email per client per day' using errcode = '23505';
  end;
  v_req := private.insert_upload_request(c.id, v_fu, p->>'token_hash', v_items, nullif(p->>'replaces', '')::uuid);
  return v_req || jsonb_build_object('follow_up_id', v_fu, 'recipient', c.email);
end $$;

-- AC-1, AC-2: the same request sent through WhatsApp click-to-chat (06: opened, not capped).
create or replace function public.record_link_whatsapp(p jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare c public.client; v_items jsonb; v_fu uuid; v_req jsonb;
begin
  c := private.follow_up_client(nullif(p->>'client_id', '')::uuid);
  v_items := private.upload_items(c.id, p->'items');
  if c.mobile is null then
    raise exception 'NO_MOBILE: this client has no mobile number' using errcode = '22023';
  end if;
  v_fu := private.insert_follow_up(c.id, 'whatsapp', 'opened', private.office_today(c.office_id), c.mobile, null,
                                   private.upload_scheduled_ids(v_items));
  v_req := private.insert_upload_request(c.id, v_fu, p->>'token_hash', v_items, nullif(p->>'replaces', '')::uuid);
  return v_req || jsonb_build_object('follow_up_id', v_fu);
end $$;

-- AC-2: Retry after a failed email. Only the requester; only while the link is unrevoked and unexpired and its
-- email failed (so the old token was never delivered). A new token and a new pending follow-up for the items
-- still open; 06's cap and ceiling apply again.
create or replace function public.retry_link_email(p_request uuid, p_token_hash text, p_daily_max integer default 200)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare r public.upload_request; c public.client; v_today date; v_fu uuid; v_sched uuid[]; f public.follow_up;
begin
  r := private.upload_request_visible(p_request);
  if r.created_by <> private.current_staff_id() then
    raise exception 'NOT_SENDER: only the person who sent the link can retry it' using errcode = '42501';
  end if;
  if r.revoked_at is not null or private.office_today(r.office_id) >= (r.expires_at at time zone 'Asia/Kolkata')::date then
    raise exception 'NOT_ACTIVE: this link is no longer active' using errcode = 'P0001';
  end if;
  c := private.follow_up_client(r.client_id);
  perform private.close_stale_emails(c.id);
  select * into f from public.follow_up where id = r.follow_up_id;
  if not found or f.channel <> 'email' or f.status <> 'failed' then
    raise exception 'NOT_FAILED: only a link whose email failed can be retried' using errcode = 'P0001';
  end if;
  if c.email is null then raise exception 'NO_EMAIL: this client has no email address' using errcode = '22023'; end if;
  v_today := private.office_today(c.office_id);
  if exists (select 1 from public.follow_up x
              where x.client_id = c.id and x.sent_on = v_today and x.channel = 'email'
                and x.status in ('pending', 'sent', 'suppressed')) then
    raise exception 'ALREADY_EMAILED_TODAY: one email per client per day' using errcode = '23505';
  end if;
  if private.office_emails_today(v_today) >= greatest(coalesce(p_daily_max, 200), 0) then
    raise exception 'DAILY_LIMIT: the office''s daily email limit is reached' using errcode = '54000';
  end if;
  -- The scheduled items that are still open (06's rule); ad-hoc items need no follow-up row.
  select coalesce(array_agg(i.expected_doc_id), '{}') into v_sched
    from public.upload_request_item i join public.expected_doc e on e.id = i.expected_doc_id
   where i.request_id = r.id and i.kind = 'scheduled' and e.status = 'pending';
  begin
    v_fu := private.insert_follow_up(c.id, 'email', 'pending', v_today, c.email, null, v_sched);
  exception when unique_violation then
    raise exception 'ALREADY_EMAILED_TODAY: one email per client per day' using errcode = '23505';
  end;
  perform private.rotate_upload_token(r.id, p_token_hash, v_fu);
  return jsonb_build_object('request_id', r.id, 'follow_up_id', v_fu, 'recipient', c.email, 'expires_at', r.expires_at);
end $$;

-- AC-18: Revoke — the requester or Admin/Manager; immediate; can't be undone.
create or replace function public.revoke_upload_request(p_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare r public.upload_request;
begin
  r := private.upload_request_visible(p_id);
  if r.created_by <> private.current_staff_id() and not private.has_role(array['admin', 'manager']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: only the person who sent the link, or an Admin or Manager, can revoke it' using errcode = '42501';
  end if;
  perform private.revoke_request(r.id);
end $$;

-- AC-16: Cancel an open ad-hoc item (reason ≤ 300) / Reopen a received one. Anyone who can see the client.
create or replace function public.cancel_request_item(p_id uuid, p_reason text)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not exists (select 1 from public.upload_request_item where id = p_id) then
    raise exception 'NOT_FOUND: requested document' using errcode = 'P0002';
  end if;
  if v_reason is null then raise exception 'REASON_REQUIRED: say why it''s no longer needed' using errcode = '22023'; end if;
  if length(v_reason) > 300 then raise exception 'REASON_TOO_LONG: keep the reason to 300 characters' using errcode = '22023'; end if;
  perform private.set_request_item(p_id, 'cancelled', v_reason);
end $$;

create or replace function public.reopen_request_item(p_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (select 1 from public.upload_request_item where id = p_id) then
    raise exception 'NOT_FOUND: requested document' using errcode = 'P0002';
  end if;
  perform private.set_request_item(p_id, 'open', null);
end $$;

-- ── 5 ─────────────────────────────────────────────────────────────────────
revoke all on function
  private.note_pii(text), private.upload_items(uuid, jsonb), private.upload_scheduled_ids(jsonb),
  private.upload_request_visible(uuid), private.upload_expires_at(uuid),
  private.insert_upload_request(uuid, uuid, text, jsonb, uuid), private.rotate_upload_token(uuid, text, uuid),
  private.revoke_request(uuid), private.set_request_item(uuid, public.upload_item_status, text)
  from public, anon, authenticated;
grant execute on function
  private.note_pii(text), private.upload_items(uuid, jsonb), private.upload_scheduled_ids(jsonb),
  private.upload_request_visible(uuid), private.upload_expires_at(uuid),
  private.insert_upload_request(uuid, uuid, text, jsonb, uuid), private.rotate_upload_token(uuid, text, uuid),
  private.revoke_request(uuid), private.set_request_item(uuid, public.upload_item_status, text)
  to authenticated;

revoke all on function
  public.begin_link_email(jsonb), public.record_link_whatsapp(jsonb), public.retry_link_email(uuid, text, integer),
  public.revoke_upload_request(uuid), public.cancel_request_item(uuid, text), public.reopen_request_item(uuid)
  from public, anon;
grant execute on function
  public.begin_link_email(jsonb), public.record_link_whatsapp(jsonb), public.retry_link_email(uuid, text, integer),
  public.revoke_upload_request(uuid), public.cancel_request_item(uuid, text), public.reopen_request_item(uuid)
  to authenticated;
