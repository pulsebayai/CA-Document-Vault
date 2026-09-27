-- 02 step 8: add / edit / archive clients (spec AC-8 … AC-11, AC-23).
-- 1. client.archive_reason (optional, AC-11) — Admin/Manager only like archived_at; cleared on unarchive.
--    Kept on the client, never in activity (activity holds field names and IDs only, AC-23).
-- 2. public.create_client(jsonb): client + registrations + groups in ONE transaction (no half-created
--    client if, say, a GSTIN is already used), code assigned inside it, one activity row.
-- 3. public.update_client(uuid, jsonb): details + registration set in one transaction, one activity row
--    listing the changed field names. Both SECURITY INVOKER: RLS, column grants and triggers still apply.

alter table public.client
  add column archive_reason text check (archive_reason is null or length(btrim(archive_reason)) between 1 and 200);
grant update (archive_reason) on public.client to authenticated;

create or replace function private.client_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  -- Tenant boundary first (signed-in users only; the service role has no JWT).
  if (select auth.uid()) is not null and new.office_id is distinct from private.current_office_id() then
    raise exception 'OFFICE_DENIED: new row violates row-level security for this office' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    -- Row lock on the office serialises inserts; a failed insert rolls the counter back (no gaps).
    update public.office set client_code_counter = client_code_counter + 1
      where id = new.office_id returning client_code_counter into v_n;
    if v_n is null then raise exception 'NOT_FOUND: office' using errcode = 'P0002'; end if;
    new.code := 'C' || lpad(v_n::text, 4, '0');
    new.created_by := coalesce(new.created_by, private.current_staff_id());
    new.created_at := now();
    new.updated_at := now();
    new.archive_reason := null;
  else
    if new.code is distinct from old.code or new.office_id is distinct from old.office_id
       or new.created_by is distinct from old.created_by then
      raise exception 'IMMUTABLE: client code, office and creator cannot change' using errcode = 'P0001';
    end if;
    if (new.incharge_id is distinct from old.incharge_id
        or new.archived_at is distinct from old.archived_at
        or new.archived_by is distinct from old.archived_by
        or new.archive_reason is distinct from old.archive_reason)
       and not private.is_privileged() then
      raise exception 'ROLE_REQUIRED: only Admin or Manager can change incharge or archive a client' using errcode = '42501';
    end if;
    if new.archived_at is null then
      new.archived_by := null;
      new.archive_reason := null;
    elsif old.archived_at is null then
      new.archived_by := coalesce(new.archived_by, private.current_staff_id());
    end if;
    if new.pan is distinct from old.pan and new.pan is not null and exists (
      select 1 from public.client_registration r
      where r.client_id = new.id and r.kind = 'gstin' and substr(r.number, 3, 10) <> new.pan) then
      raise exception 'GSTIN_PAN: the new PAN does not match this client''s GSTIN' using errcode = '23514';
    end if;
    new.updated_at := now();
  end if;
  if tg_op = 'INSERT' or new.incharge_id is distinct from old.incharge_id then
    if not exists (select 1 from public.staff_user s
                   where s.id = new.incharge_id and s.office_id = new.office_id and s.status = 'active') then
      raise exception 'INCHARGE: incharge must be active staff of this office' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create or replace function public.create_client(p jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_office uuid := private.current_office_id();
  v_id uuid; v_code text; reg jsonb; g text;
  v_groups jsonb := '[]'::jsonb; v_regs integer := 0; v_fields jsonb;
begin
  if not private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: Limited users cannot add clients' using errcode = '42501';
  end if;
  insert into public.client (office_id, name, client_type, pan, previous_reference, email, mobile, incharge_id)
    values (v_office, btrim(p->>'name'), (p->>'client_type')::public.client_type,
            nullif(btrim(p->>'pan'), ''), nullif(btrim(p->>'previous_reference'), ''),
            nullif(btrim(p->>'email'), ''), nullif(btrim(p->>'mobile'), ''), (p->>'incharge_id')::uuid)
    returning id, code into v_id, v_code;
  for reg in select * from jsonb_array_elements(coalesce(p->'registrations', '[]'::jsonb)) loop
    insert into public.client_registration (office_id, client_id, kind, number)
      values (v_office, v_id, (reg->>'kind')::public.registration_kind, btrim(reg->>'number'));
    v_regs := v_regs + 1;
  end loop;
  for g in select distinct * from jsonb_array_elements_text(coalesce(p->'group_ids', '[]'::jsonb)) loop
    perform private.enable_group_core(v_id, g::uuid);
    v_groups := v_groups || to_jsonb(g);
  end loop;
  -- Field names only (AC-23): which optional fields were filled, never their values.
  select coalesce(jsonb_agg(k order by k), '[]'::jsonb) into v_fields
    from unnest(array['pan', 'previous_reference', 'email', 'mobile']) k where nullif(btrim(p->>k), '') is not null;
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (v_office, private.current_staff_id(), 'client.created', 'client', v_id::text,
            jsonb_build_object('fields', v_fields, 'registrations', v_regs, 'group_ids', v_groups));
  return jsonb_build_object('id', v_id, 'code', v_code);
end $$;

create or replace function public.update_client(p_client_id uuid, p jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_office uuid := private.current_office_id();
  v_old public.client; v_new public.client;
  reg jsonb; v_num text; v_kind public.registration_kind; v_existing public.client_registration;
  v_changed text[] := '{}'; v_added integer := 0; v_removed integer := 0; v_numbers text[];
begin
  if not private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: Limited users cannot edit clients' using errcode = '42501';
  end if;
  select * into v_old from public.client where id = p_client_id and office_id = v_office for update;
  if not found then raise exception 'NOT_FOUND: client' using errcode = 'P0002'; end if;
  if v_old.archived_at is not null then
    raise exception 'ARCHIVED: unarchive the client before editing it' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(upper(regexp_replace(e->>'number', '\s', '', 'g'))), '{}') into v_numbers
    from jsonb_array_elements(coalesce(p->'registrations', '[]'::jsonb)) e;
  -- 1. Registrations no longer listed become inactive (rows are never deleted).
  update public.client_registration set active = false
   where client_id = p_client_id and active and not (number = any (v_numbers));
  get diagnostics v_removed = row_count;

  -- 2. Details. incharge_id only when sent; the trigger lets only Admin/Manager change it (AC-10).
  update public.client set
      name = btrim(p->>'name'),
      client_type = (p->>'client_type')::public.client_type,
      pan = nullif(btrim(p->>'pan'), ''),
      previous_reference = nullif(btrim(p->>'previous_reference'), ''),
      email = nullif(btrim(p->>'email'), ''),
      mobile = nullif(btrim(p->>'mobile'), ''),
      incharge_id = coalesce((p->>'incharge_id')::uuid, v_old.incharge_id)
    where id = p_client_id
    returning * into v_new;
  if v_new.name is distinct from v_old.name then v_changed := array_append(v_changed, 'name'); end if;
  if v_new.client_type is distinct from v_old.client_type then v_changed := array_append(v_changed, 'client_type'); end if;
  if v_new.pan is distinct from v_old.pan then v_changed := array_append(v_changed, 'pan'); end if;
  if v_new.previous_reference is distinct from v_old.previous_reference then v_changed := array_append(v_changed, 'previous_reference'); end if;
  if v_new.email is distinct from v_old.email then v_changed := array_append(v_changed, 'email'); end if;
  if v_new.mobile is distinct from v_old.mobile then v_changed := array_append(v_changed, 'mobile'); end if;
  if v_new.incharge_id is distinct from v_old.incharge_id then v_changed := array_append(v_changed, 'incharge_id'); end if;

  -- 3. Listed registrations: reactivate a known number, otherwise add it (GSTIN checked against the new PAN).
  for reg in select * from jsonb_array_elements(coalesce(p->'registrations', '[]'::jsonb)) loop
    v_num := upper(regexp_replace(reg->>'number', '\s', '', 'g'));
    v_kind := (reg->>'kind')::public.registration_kind;
    select * into v_existing from public.client_registration where client_id = p_client_id and number = v_num;
    if found then
      if v_existing.kind <> v_kind then
        raise exception 'IMMUTABLE: registration kind cannot change' using errcode = 'P0001';
      end if;
      if not v_existing.active then
        update public.client_registration set active = true where id = v_existing.id;
        v_added := v_added + 1;
      end if;
    else
      insert into public.client_registration (office_id, client_id, kind, number) values (v_office, p_client_id, v_kind, v_num);
      v_added := v_added + 1;
    end if;
  end loop;

  if cardinality(v_changed) > 0 or v_added > 0 or v_removed > 0 then
    insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
      values (v_office, private.current_staff_id(), 'client.updated', 'client', p_client_id::text,
              jsonb_build_object('fields', to_jsonb(v_changed), 'registrations_added', v_added, 'registrations_removed', v_removed));
  end if;
end $$;

revoke all on function public.create_client(jsonb), public.update_client(uuid, jsonb) from public, anon;
grant execute on function public.create_client(jsonb), public.update_client(uuid, jsonb) to authenticated;
