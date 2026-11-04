-- Feature 19 — super admin console, migration B (behaviour). Spec Y1–Y7; plan step 2.
--   1. Suspension in the three staff helpers: a suspended firm's staff have no office, no staff id and no role, so
--      every RLS policy refuses them at once (61 policies unchanged); 10's link_request (acts as the requester) then
--      answers NOT_ACTIVE; 04's nightly job skips suspended offices.
--   2. public.my_access_state(): what the signed-in user is (staff · suspended · platform · none), for sign-in routing.
--   3. The platform checks: private.require_platform_admin(), private.platform_office(), private.platform_access_ok(),
--      private.platform_log(). A `.test` super admin acts on test offices only, a real one on real offices only (D1).
--   4. public.platform_* — SECURITY DEFINER, each checks the caller first and logs before it returns (spec Y3).
--      They return IDs, counts and display fields; never storage paths, DSC ciphertext or link tokens (Y5).
-- Rollback: restore the three helpers and run_daily_expected from 20260925112320 / 20260930120658; drop the functions below.

-- ── 1 ─────────────────────────────────────────────────────────────────────
create or replace function private.current_staff_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select s.id from public.staff_user s join public.office o on o.id = s.office_id
  where s.id = (select auth.uid()) and s.status = 'active' and o.suspended_at is null
$$;

create or replace function private.current_office_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select s.office_id from public.staff_user s join public.office o on o.id = s.office_id
  where s.id = (select auth.uid()) and s.status = 'active' and o.suspended_at is null
$$;

create or replace function private.has_role(roles public.staff_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff_user s join public.office o on o.id = s.office_id
    where s.id = (select auth.uid()) and s.status = 'active' and s.role = any (roles) and o.suspended_at is null
  )
$$;

create or replace function private.run_daily_expected()
returns void language plpgsql security definer set search_path = '' as $$
declare o record; v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  for o in select id from public.office where not is_test and suspended_at is null order by id loop -- 19: skip suspended
    begin
      perform private.run_office_expected(o.id, v_today);
    exception when others then
      raise warning 'expected-docs-daily: office % failed: %', o.id, sqlerrm;
    end;
  end loop;
end $$;

-- ── 2 ─────────────────────────────────────────────────────────────────────
create or replace function public.my_access_state()
returns text language sql stable security definer set search_path = '' as $$
  select case
    when exists (select 1 from public.staff_user s join public.office o on o.id = s.office_id
                  where s.id = (select auth.uid()) and s.status in ('active', 'invited') and o.suspended_at is not null) then 'suspended'
    when exists (select 1 from public.staff_user s where s.id = (select auth.uid()) and s.status in ('active', 'invited')) then 'staff'
    when exists (select 1 from public.platform_admin p where p.id = (select auth.uid()) and p.status = 'active') then 'platform'
    else 'none' end
$$;
revoke all on function public.my_access_state() from public, anon;
grant execute on function public.my_access_state() to authenticated;

-- ── 3 ─────────────────────────────────────────────────────────────────────
-- The caller, if an active super admin; `test` = a .test email (acts on test offices only, D1).
create or replace function private.require_platform_admin(out id uuid, out test boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  -- review M-2: the sign-in email must still be the one on record, so a changed login email can't keep platform access
  select p.id, p.email like '%.test' into id, test
    from public.platform_admin p join auth.users u on u.id = p.id
   where p.id = (select auth.uid()) and p.status = 'active' and lower(u.email) = p.email;
  if id is null then
    raise exception 'NOT_PLATFORM_ADMIN' using errcode = '42501';
  end if;
end $$;

-- An office this super admin may act on (test admins ↔ test offices). Unknown or the other kind = NOT_FOUND.
create or replace function private.platform_office(p_office uuid, p_test boolean)
returns public.office language plpgsql stable security definer set search_path = '' as $$
declare o public.office;
begin
  select * into o from public.office where id = p_office and is_test = p_test;
  if o.id is null then raise exception 'NOT_FOUND: firm' using errcode = 'P0002'; end if;
  return o;
end $$;

-- The open, unexpired access window of this super admin for this office, or NO_ACCESS.
create or replace function private.platform_access_ok(p_admin uuid, p_office uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select a.id from public.platform_access a
   where a.admin_id = p_admin and a.office_id = p_office and a.closed_at is null and a.expires_at > now()
   order by a.expires_at desc limit 1
$$;

create or replace function private.platform_require_access(p_admin uuid, p_office uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v uuid := private.platform_access_ok(p_admin, p_office);
begin
  if v is null then raise exception 'NO_ACCESS: open read access to this firm first' using errcode = '42501'; end if;
  return v;
end $$;

create or replace function private.platform_log(p_admin uuid, p_action text, p_office uuid, p_access uuid, p_detail jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.platform_audit (admin_id, action, office_id, access_id, detail)
  values (p_admin, p_action, p_office, p_access, coalesce(p_detail, '{}'::jsonb))
$$;

-- A read in an access window: one platform audit row and one firm activity row, before the data is returned.
-- The activity row names what was read by ID (AC-13): `client_id` for a client's pages, `document_id` (+ its client)
-- for a document, so 08's feed shows "viewed client C0004" and the client's and document's own activity show it too
-- (08's client resolution, 15's document lookups). IDs and the view name only.
create or replace function private.platform_viewed(p_admin uuid, p_office uuid, p_access uuid, p_view text, p_entity uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_client uuid; v_doc uuid;
begin
  if p_view = 'document' then
    v_doc := p_entity;
    select d.client_id into v_client from public.document d where d.id = p_entity and d.office_id = p_office;
  elsif p_view in ('client', 'documents', 'expected') then
    v_client := p_entity;
  end if;
  perform private.platform_log(p_admin, 'viewed', p_office, p_access,
    jsonb_strip_nulls(jsonb_build_object('view', p_view, 'entity_id', p_entity)));
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (p_office, null, 'platform.viewed', 'platform_access', p_access::text,
            jsonb_strip_nulls(jsonb_build_object('access_id', p_access, 'view', p_view, 'client_id', v_client, 'document_id', v_doc)));
end $$;

revoke all on function private.require_platform_admin(), private.platform_office(uuid, boolean),
  private.platform_access_ok(uuid, uuid), private.platform_require_access(uuid, uuid),
  private.platform_log(uuid, text, uuid, uuid, jsonb), private.platform_viewed(uuid, uuid, uuid, text, uuid)
  from public, anon, authenticated;

-- ── 4 ─────────────────────────────────────────────────────────────────────
create or replace function public.platform_whoami()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me record; p public.platform_admin;
begin
  me := private.require_platform_admin();
  select * into p from public.platform_admin where id = me.id;
  return jsonb_build_object('id', p.id, 'full_name', p.full_name, 'email', p.email, 'test', me.test);
end $$;

-- Firms with usage counts (Y7). Counts only: no client names or PII.
create or replace function public.platform_firms()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me record;
begin
  me := private.require_platform_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id, 'name', o.name, 'branch', o.branch, 'created_at', o.created_at,
      'status', case when o.suspended_at is null then 'active' else 'suspended' end,
      'suspended_at', o.suspended_at,
      'staff_active', (select count(*) from public.staff_user s where s.office_id = o.id and s.status = 'active'),
      'staff_invited', (select count(*) from public.staff_user s where s.office_id = o.id and s.status = 'invited'),
      'clients', (select count(*) from public.client c where c.office_id = o.id and c.archived_at is null),
      'documents', (select count(*) from public.document d where d.office_id = o.id and d.archived_at is null),
      'storage_mb', round(coalesce((select sum((so.metadata->>'size')::bigint) from storage.objects so
                     where so.bucket_id = 'documents' and so.name like 'office/' || o.id::text || '/%'), 0) / 1048576.0, 1),
      'last_activity_at', (select max(a.created_at) from public.activity a where a.office_id = o.id and a.action <> 'auth.signed_in'),
      -- the caller's own open window on this firm (for the countdown), or null
      'my_access', (select jsonb_build_object('id', x.id, 'expires_at', x.expires_at) from public.platform_access x
                     where x.admin_id = me.id and x.office_id = o.id and x.closed_at is null and x.expires_at > now()
                     order by x.expires_at desc limit 1)
    ) order by lower(o.name), o.id)
    from public.office o where o.is_test = me.test), '[]'::jsonb);
end $$;

-- Create a firm (Y7): 17's bootstrap path (catalogue, years, preferred formats; office.bootstrapped), in the
-- deployment's mode; a .test super admin creates a test office (never sets the deployment mode, D1).
-- The bootstrap runs with the JWT claims cleared for that call only: 02's tenant-first triggers (doc_type, period …)
-- apply to any caller with a JWT and a super admin has no office, so the seed takes the operator path that 17's
-- script uses (service role, no JWT). The claims are restored before anything else runs; the caller was checked first.
create or replace function public.platform_create_firm(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me record; v_mode text; v jsonb;
  v_claims text := current_setting('request.jwt.claims', true); v_sub text := current_setting('request.jwt.claim.sub', true);
begin
  me := private.require_platform_admin();
  select d.mode into v_mode from private.deployment d;
  -- review I-2: a one-firm (Dedicated / Customer-owned) deployment never gets a second firm from the console
  if v_mode = 'single' then raise exception 'SINGLE_MODE: this deployment holds one firm' using errcode = '42501'; end if;
  -- review L-6: a real super admin never fixes the deployment mode by accident (dev, or staging/prod before the
  -- operator's bootstrap); test super admins take 17's test path, which never sets it
  if not me.test and v_mode is null then raise exception 'DEPLOYMENT_MODE_UNSET: set up the deployment with the operator script first' using errcode = '42501'; end if;
  -- review N-7: names starting "e2e office" become test offices (02), invisible to a real super admin at once
  if not me.test and btrim(coalesce(p->>'name', '')) ilike 'e2e office%' then raise exception 'NAME_RESERVED: "e2e office" names are for tests' using errcode = '22023'; end if;
  perform set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true);
  v := public.bootstrap_office(jsonb_build_object('name', p->>'name', 'branch', p->>'branch',
         'mode', coalesce(v_mode, 'multi'), 'test', me.test));
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true), set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
  perform private.platform_log(me.id, 'firm.created', (v->>'office_id')::uuid, null, jsonb_build_object('result', v->>'result'));
  return v;
end $$;

-- Record the first Admin after the server's invite created their auth user (D2). The auth user must carry that
-- email; the firm must have no staff yet; one email = one firm and never a super admin (A's trigger).
create or replace function public.platform_record_first_admin(p_office uuid, p_user uuid, p_name text, p_email text)
returns void language plpgsql security definer set search_path = '' as $$
declare me record; o public.office; v_email text := lower(btrim(coalesce(p_email, '')));
begin
  me := private.require_platform_admin();
  o := private.platform_office(p_office, me.test);
  perform 1 from public.office where id = o.id for update;
  if exists (select 1 from public.staff_user s where s.office_id = o.id) then
    raise exception 'ALREADY_SET_UP: this firm already has staff' using errcode = '23505';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user and lower(u.email) = v_email) then
    raise exception 'USER_MISMATCH: invite the email first' using errcode = '22023';
  end if;
  insert into public.staff_user (id, office_id, full_name, email, role, status)
    values (p_user, o.id, btrim(p_name), v_email, 'admin', 'invited');
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (o.id, null, 'staff.invited', 'staff_user', p_user::text, jsonb_build_object('role', 'admin', 'via', 'platform'));
  perform private.platform_log(me.id, 'staff.invited', o.id, null, jsonb_build_object('staff_id', p_user));
end $$;

-- The first Admin still waiting for their invite (for "Resend invite"): only while nobody in the firm has signed in
-- (review L-2: never an Admin the firm invited itself). Name and ID only — an unlogged read returns no email (I-5).
create or replace function public.platform_invite_target(p_office uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me record; o public.office; s public.staff_user;
begin
  me := private.require_platform_admin();
  o := private.platform_office(p_office, me.test);
  if exists (select 1 from public.staff_user x where x.office_id = o.id and x.status <> 'invited') then return null; end if;
  select * into s from public.staff_user where office_id = o.id and role = 'admin' and status = 'invited'
   order by created_at limit 1;
  if s.id is null then return null; end if;
  return jsonb_build_object('staff_id', s.id, 'full_name', s.full_name);
end $$;

-- "Resend invite" (review I-4): logged before the server sends anything, and the only way the address reaches it.
create or replace function public.platform_begin_reinvite(p_office uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me record; o public.office; s public.staff_user;
begin
  me := private.require_platform_admin();
  o := private.platform_office(p_office, me.test);
  if not exists (select 1 from public.staff_user x where x.office_id = o.id and x.status <> 'invited') then
    select * into s from public.staff_user where office_id = o.id and role = 'admin' and status = 'invited'
     order by created_at limit 1;
  end if;
  if s.id is null then raise exception 'NOTHING_WAITING: nobody in this firm is waiting for an invite' using errcode = 'P0002'; end if;
  perform private.platform_log(me.id, 'staff.reinvited', o.id, null, jsonb_build_object('staff_id', s.id));
  return jsonb_build_object('staff_id', s.id, 'email', s.email, 'full_name', s.full_name);
end $$;

-- A super admin's sign-in, recorded by the database as the signed-in user (review I-4; was a service-role insert).
create or replace function public.platform_signed_in(p_method text)
returns void language plpgsql security definer set search_path = '' as $$
declare me record;
begin
  me := private.require_platform_admin();
  if p_method is null or p_method not in ('code', 'link', 'invite') then raise exception 'INVALID: method' using errcode = '22023'; end if;
  perform private.platform_log(me.id, 'auth.signed_in', null, null, jsonb_build_object('method', p_method));
end $$;

create or replace function public.platform_suspend_firm(p_office uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare me record; o public.office; v_reason text := btrim(coalesce(p_reason, ''));
begin
  me := private.require_platform_admin();
  o := private.platform_office(p_office, me.test);
  if length(v_reason) not between 10 and 500 then raise exception 'REASON_INVALID: 10–500 characters' using errcode = '22023'; end if;
  if o.suspended_at is not null then raise exception 'ALREADY_SUSPENDED' using errcode = 'P0001'; end if;
  -- review I-2 (spec Y6): a one-firm deployment is never suspended from the console (it would lock out its only firm)
  if exists (select 1 from private.deployment d where d.mode = 'single') then
    raise exception 'SINGLE_MODE: this deployment holds one firm' using errcode = '42501';
  end if;
  update public.office set suspended_at = now(), suspended_by = me.id, suspend_reason = v_reason where id = o.id;
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (o.id, null, 'office.suspended', 'office', o.id::text, '{}');
  -- the reason goes with the log row: the office row's copy is cleared on reactivation (AC-12)
  insert into public.platform_audit (admin_id, action, office_id, reason) values (me.id, 'firm.suspended', o.id, v_reason);
end $$;

create or replace function public.platform_reactivate_firm(p_office uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare me record; o public.office;
begin
  me := private.require_platform_admin();
  o := private.platform_office(p_office, me.test);
  if o.suspended_at is null then raise exception 'NOT_SUSPENDED' using errcode = 'P0001'; end if;
  update public.office set suspended_at = null, suspended_by = null, suspend_reason = null where id = o.id;
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (o.id, null, 'office.reactivated', 'office', o.id::text, '{}');
  perform private.platform_log(me.id, 'firm.reactivated', o.id, null, '{}');
end $$;

-- Support access (Y4): reason + 60 minutes; firm activity + one bell per active Admin; the reason stays on the row.
create or replace function public.platform_open_access(p_office uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare me record; o public.office; v_reason text := btrim(coalesce(p_reason, '')); v_id uuid; v_at timestamptz := now();
begin
  me := private.require_platform_admin();
  o := private.platform_office(p_office, me.test);
  if length(v_reason) not between 10 and 500 then raise exception 'REASON_INVALID: 10–500 characters' using errcode = '22023'; end if;
  insert into public.platform_access (admin_id, office_id, reason, opened_at, expires_at)
    values (me.id, o.id, v_reason, v_at, v_at + interval '60 minutes') returning id into v_id;
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (o.id, null, 'platform.access_opened', 'platform_access', v_id::text, jsonb_build_object('access_id', v_id));
  insert into public.notification (office_id, recipient_id, kind, entity_type, entity_id, data)
    select o.id, s.id, 'platform_access', 'platform_access', v_id, jsonb_build_object('access_id', v_id)
      from public.staff_user s where s.office_id = o.id and s.role = 'admin' and s.status = 'active';
  perform private.platform_log(me.id, 'access.opened', o.id, v_id, jsonb_build_object('access_id', v_id));
  return v_id;
end $$;

create or replace function public.platform_close_access(p_access uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare me record; a public.platform_access;
begin
  me := private.require_platform_admin();
  select * into a from public.platform_access where id = p_access and admin_id = me.id;
  if a.id is null then raise exception 'NOT_FOUND: access' using errcode = 'P0002'; end if;
  if a.closed_at is null then
    update public.platform_access set closed_at = now() where id = a.id;
    perform private.platform_log(me.id, 'access.closed', a.office_id, a.id, jsonb_build_object('access_id', a.id));
  end if;
end $$;

-- ── Read views (Y5). Each: caller → office → open window → log → data (this firm only). ──────────────────────
create or replace function public.platform_clients(p_office uuid, p_query text, p_page integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me record; o public.office; v_access uuid;
  -- 03b's rule: \ % _ are literal in a search (review N-2)
  v_q text := nullif(regexp_replace(btrim(coalesce(p_query, '')), '([\\%_])', '\\\1', 'g'), '');
  v_page integer := greatest(coalesce(p_page, 1), 1);
begin
  me := private.require_platform_admin();
  o := private.platform_office(p_office, me.test);
  v_access := private.platform_require_access(me.id, o.id);
  perform private.platform_viewed(me.id, o.id, v_access, 'clients', null);
  return jsonb_build_object(
    'total', (select count(*) from public.client c where c.office_id = o.id
               and (v_q is null or c.name ilike '%' || v_q || '%' or c.code ilike v_q || '%')),
    'rows', coalesce((select jsonb_agg(x.r order by x.n) from (
      select jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name, 'client_type', c.client_type,
               'pan', c.pan, 'email', c.email, 'mobile', c.mobile, 'archived', c.archived_at is not null,
               'incharge_name', s.full_name) r, row_number() over (order by lower(c.name), c.id) n
        from public.client c left join public.staff_user s on s.id = c.incharge_id
       where c.office_id = o.id and (v_q is null or c.name ilike '%' || v_q || '%' or c.code ilike v_q || '%')
       order by lower(c.name), c.id limit 20 offset (v_page - 1) * 20) x), '[]'::jsonb));
end $$;

create or replace function public.platform_client(p_office uuid, p_client uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me record; o public.office; v_access uuid; c public.client;
begin
  me := private.require_platform_admin();
  o := private.platform_office(p_office, me.test);
  v_access := private.platform_require_access(me.id, o.id);
  select * into c from public.client where id = p_client and office_id = o.id;
  if c.id is null then raise exception 'NOT_FOUND: client' using errcode = 'P0002'; end if;
  perform private.platform_viewed(me.id, o.id, v_access, 'client', c.id);
  return jsonb_build_object(
    'id', c.id, 'code', c.code, 'name', c.name, 'client_type', c.client_type, 'pan', c.pan, 'email', c.email,
    'mobile', c.mobile, 'previous_reference', c.previous_reference, 'archived', c.archived_at is not null,
    'incharge_name', (select s.full_name from public.staff_user s where s.id = c.incharge_id),
    'registrations', coalesce((select jsonb_agg(jsonb_build_object('kind', r.kind, 'number', r.number, 'active', r.active) order by r.kind, r.number)
                                from public.client_registration r where r.client_id = c.id and r.office_id = o.id), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('name', g.name, 'state', cg.state) order by g.sort)
                         from public.client_group cg join public.doc_group g on g.id = cg.doc_group_id
                        where cg.client_id = c.id and cg.office_id = o.id), '[]'::jsonb),
    'documents', (select count(*) from public.document d where d.client_id = c.id and d.office_id = o.id and d.archived_at is null),
    'expected_pending', (select count(*) from public.expected_doc e where e.client_id = c.id and e.office_id = o.id and e.status = 'pending'));
end $$;

create or replace function public.platform_documents(p_office uuid, p_client uuid, p_page integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me record; o public.office; v_access uuid; v_page integer := greatest(coalesce(p_page, 1), 1);
begin
  me := private.require_platform_admin();
  o := private.platform_office(p_office, me.test);
  v_access := private.platform_require_access(me.id, o.id);
  if p_client is not null and not exists (select 1 from public.client c where c.id = p_client and c.office_id = o.id) then
    raise exception 'NOT_FOUND: client' using errcode = 'P0002';
  end if;
  perform private.platform_viewed(me.id, o.id, v_access, 'documents', p_client);
  return jsonb_build_object(
    'total', (select count(*) from public.document d where d.office_id = o.id and (p_client is null or d.client_id = p_client)),
    'rows', coalesce((select jsonb_agg(x.r order by x.n) from (
      select jsonb_build_object('id', d.id, 'doc_code', d.doc_code, 'client_name', c.name, 'type_name', t.name,
               'period_code', pe.code, 'received_as', d.received_as, 'received_on', d.received_on, 'status', d.status,
               'custody', d.custody, 'archived', d.archived_at is not null,
               'file_name', v.file_name, 'size_bytes', v.size_bytes) r,
               row_number() over (order by d.received_on desc nulls last, d.id) n
        from public.document d
        left join public.client c on c.id = d.client_id
        left join public.doc_type t on t.id = d.doc_type_id
        left join public.period pe on pe.id = d.period_id
        left join public.document_version v on v.id = d.current_version_id
       where d.office_id = o.id and (p_client is null or d.client_id = p_client)
       order by d.received_on desc nulls last, d.id limit 20 offset (v_page - 1) * 20) x), '[]'::jsonb));
end $$;

create or replace function public.platform_document(p_office uuid, p_document uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me record; o public.office; v_access uuid; d public.document;
begin
  me := private.require_platform_admin();
  o := private.platform_office(p_office, me.test);
  v_access := private.platform_require_access(me.id, o.id);
  select * into d from public.document where id = p_document and office_id = o.id;
  if d.id is null then raise exception 'NOT_FOUND: document' using errcode = 'P0002'; end if;
  perform private.platform_viewed(me.id, o.id, v_access, 'document', d.id);
  return jsonb_build_object(
    'id', d.id, 'doc_code', d.doc_code, 'remark', d.remark, 'received_as', d.received_as, 'returnable', d.returnable,
    'channel', d.channel, 'received_on', d.received_on, 'status', d.status, 'custody', d.custody,
    'archived', d.archived_at is not null, 'handed_over_name', d.handed_over_name,
    'client_name', (select c.name from public.client c where c.id = d.client_id),
    'type_name', (select t.name from public.doc_type t where t.id = d.doc_type_id),
    'period_code', (select pe.code from public.period pe where pe.id = d.period_id),
    'versions', coalesce((select jsonb_agg(jsonb_build_object('version_no', v.version_no, 'file_name', v.file_name,
                   'mime_type', v.mime_type, 'size_bytes', v.size_bytes, 'uploaded_at', v.uploaded_at,
                   'uploaded_by', (select s.full_name from public.staff_user s where s.id = v.uploaded_by)) order by v.version_no)
                  from public.document_version v where v.document_id = d.id and v.office_id = o.id), '[]'::jsonb),
    'reviews', coalesce((select jsonb_agg(jsonb_build_object('outcome', r.outcome, 'reason', r.reason, 'at', r.created_at,
                   'by', (select s.full_name from public.staff_user s where s.id = r.actor_id)) order by r.created_at)
                  from public.document_review r where r.document_id = d.id and r.office_id = o.id), '[]'::jsonb));
end $$;

create or replace function public.platform_expected(p_office uuid, p_client uuid, p_page integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me record; o public.office; v_access uuid; v_page integer := greatest(coalesce(p_page, 1), 1);
begin
  me := private.require_platform_admin();
  o := private.platform_office(p_office, me.test);
  v_access := private.platform_require_access(me.id, o.id);
  if not exists (select 1 from public.client c where c.id = p_client and c.office_id = o.id) then
    raise exception 'NOT_FOUND: client' using errcode = 'P0002';
  end if;
  perform private.platform_viewed(me.id, o.id, v_access, 'expected', p_client);
  return jsonb_build_object(
    'total', (select count(*) from public.expected_doc e where e.client_id = p_client and e.office_id = o.id),
    'rows', coalesce((select jsonb_agg(x.r order by x.n) from (
      select jsonb_build_object('id', e.id, 'type_name', t.name, 'period_code', pe.code, 'status', e.status,
               'ask_on', e.ask_on, 'overdue_from', e.overdue_from, 'received_on', e.received_on) r,
               row_number() over (order by e.overdue_from desc, t.name, e.id) n
        from public.expected_doc e join public.doc_type t on t.id = e.doc_type_id join public.period pe on pe.id = e.period_id
       where e.client_id = p_client and e.office_id = o.id
       order by e.overdue_from desc, t.name limit 20 offset (v_page - 1) * 20) x), '[]'::jsonb));
end $$;

create or replace function public.platform_activity(p_office uuid, p_page integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me record; o public.office; v_access uuid; v_page integer := greatest(coalesce(p_page, 1), 1);
begin
  me := private.require_platform_admin();
  o := private.platform_office(p_office, me.test);
  v_access := private.platform_require_access(me.id, o.id);
  perform private.platform_viewed(me.id, o.id, v_access, 'activity', null);
  return jsonb_build_object('rows', coalesce((select jsonb_agg(x.r order by x.n desc) from (
    select a.id as n, jsonb_build_object('id', a.id, 'action', a.action, 'entity_type', a.entity_type, 'entity_id', a.entity_id,
             'data', a.data, 'created_at', a.created_at,
             'actor_name', (select s.full_name from public.staff_user s where s.id = a.actor_id)) r
      from public.activity a where a.office_id = o.id and a.action <> 'auth.signed_in'
     order by a.id desc limit 50 offset (v_page - 1) * 50) x), '[]'::jsonb));
end $$;

-- AC-12: the platform log, newest first. A .test super admin sees test firms' rows only, and rows without a firm only
-- of .test super admins (sign-ins, script changes); a real super admin the reverse (review L-5).
create or replace function public.platform_audit_list(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me record; v_office uuid := nullif(p->>'office_id', '')::uuid; v_action text := nullif(p->>'action', '');
  v_page integer := greatest(coalesce((p->>'page')::integer, 1), 1);
begin
  me := private.require_platform_admin();
  return jsonb_build_object('rows', coalesce((select jsonb_agg(y.r order by y.n desc) from (
    select l.id as n, jsonb_build_object('id', l.id, 'at', l.at, 'action', l.action, 'office_id', l.office_id, 'office_name', o.name,
             'admin_name', a.full_name, 'access_id', l.access_id, 'detail', l.detail,
             'reason', case when l.action = 'access.opened' then x.reason else l.reason end) r
      from public.platform_audit l
      join public.platform_admin a on a.id = l.admin_id
      left join public.office o on o.id = l.office_id
      left join public.platform_access x on x.id = l.access_id
     where (case when l.office_id is null then (a.email like '%.test') = me.test else o.is_test = me.test end)
       and (v_office is null or l.office_id = v_office) and (v_action is null or l.action = v_action)
     order by l.id desc limit 50 offset (v_page - 1) * 50) y), '[]'::jsonb));
end $$;

-- Grants: callable by signed-in users (each refuses all but an active super admin); never by anon.
do $$
declare f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'platform\_%' loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ── 5. Test probe (D3): the nightly job skips a suspended firm ─────────────────────────────────────────────────────
-- run_daily_expected covers real offices only, so the check suspends a real office inside a block that is always
-- rolled back, runs the job, then runs it again unsuspended as the control. Service role only; refused wherever a
-- deployment mode is set (staging, prod, every one-firm deployment), like 17's test_tenancy_probe.
create or replace function public.test_platform_probe()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_office uuid; v_admin uuid; v_test_admin uuid; v_test_office uuid; v_max bigint; v_susp integer; v_ctrl integer;
  v_single_suspend text; v_single_create text; v_claims text := current_setting('request.jwt.claims', true);
begin
  if exists (select 1 from private.deployment) then
    raise exception 'NOT_TEST_DEPLOYMENT: a deployment mode is set' using errcode = '42501';
  end if;
  select id into v_admin from public.platform_admin order by created_at limit 1;
  select id into v_test_admin from public.platform_admin where email like '%.test' and status = 'active' order by created_at limit 1;
  if v_admin is null or v_test_admin is null then raise exception 'NO_PLATFORM_ADMIN: create a test super admin first' using errcode = 'P0002'; end if;
  select id into v_test_office from public.office where is_test and suspended_at is null order by created_at limit 1;
  begin
    -- 1. the nightly job skips a suspended (real) office; the same office unsuspended is the control
    select id into v_office from public.office where not is_test order by created_at limit 1;
    if v_office is null then
      insert into public.office (name) values ('platform probe firm') returning id into v_office;
    end if;
    update public.office set suspended_at = now(), suspended_by = v_admin, suspend_reason = 'nightly skip probe' where id = v_office;
    select coalesce(max(id), 0) into v_max from public.activity;
    perform private.run_daily_expected();
    select count(*) into v_susp from public.activity where office_id = v_office and id > v_max;
    update public.office set suspended_at = null, suspended_by = null, suspend_reason = null where id = v_office;
    select coalesce(max(id), 0) into v_max from public.activity;
    perform private.run_daily_expected();
    select count(*) into v_ctrl from public.activity where office_id = v_office and id > v_max;
    -- 2. review I-2: in a one-firm (single) deployment, suspend and create are refused, as a test super admin
    insert into private.deployment (mode) values ('single');
    perform set_config('request.jwt.claims', json_build_object('sub', v_test_admin, 'role', 'authenticated')::text, true);
    begin
      perform public.platform_suspend_firm(v_test_office, 'single mode probe reason');
      v_single_suspend := 'ALLOWED';
    exception when others then v_single_suspend := split_part(sqlerrm, ':', 1);
    end;
    begin
      perform public.platform_create_firm('{"name": "e2e office single probe"}'::jsonb);
      v_single_create := 'ALLOWED';
    exception when others then v_single_create := split_part(sqlerrm, ':', 1);
    end;
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    raise exception 'PROBE_ROLLBACK';
  exception when raise_exception then
    if sqlerrm <> 'PROBE_ROLLBACK' then raise; end if;
  end;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return jsonb_build_object('suspended_rows', v_susp, 'control_rows', v_ctrl,
    'single_suspend', v_single_suspend, 'single_create', v_single_create);
end $$;
revoke all on function public.test_platform_probe() from public, anon, authenticated;
grant execute on function public.test_platform_probe() to service_role;
