-- 02 · fix: the client trigger (SECURITY DEFINER, runs before RLS) must refuse a row for another office
-- before it locks/increments that office's code counter. Found by tests/rls/clients-catalogue.test.ts
-- "cannot write into another office" (CI run 36302068412): the write was rejected, but only after a
-- cross-tenant row lock, and by the INCHARGE check instead of the tenant boundary.
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
  else
    if new.code is distinct from old.code or new.office_id is distinct from old.office_id
       or new.created_by is distinct from old.created_by then
      raise exception 'IMMUTABLE: client code, office and creator cannot change' using errcode = 'P0001';
    end if;
    if (new.incharge_id is distinct from old.incharge_id
        or new.archived_at is distinct from old.archived_at
        or new.archived_by is distinct from old.archived_by)
       and not private.is_privileged() then
      raise exception 'ROLE_REQUIRED: only Admin or Manager can change incharge or archive a client' using errcode = '42501';
    end if;
    if new.archived_at is null then new.archived_by := null;
    elsif old.archived_at is null then new.archived_by := coalesce(new.archived_by, private.current_staff_id());
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
