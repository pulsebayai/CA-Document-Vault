-- 13-hard-copy-custody · migration A (spec AC-1 … AC-8, AC-17; plan step 2).
-- Custody is a stored dimension beside review and dispatch: document.custody (in office · ready) + who/when, an
-- append-only history (document_custody), the S5 edit rules in 03's trigger, and the data step for existing documents
-- (public.custody_backfill, service role only, idempotent). private.document_before_write is copied from 12's migration C
-- (20261030150000) and only the block marked "13" changes.

-- ── 1. Columns and checks ──────────────────────────────────────────────────────────────────────────────────────────
create type public.custody_step as enum ('in_office', 'ready');
alter table public.document
  add column custody      public.custody_step,
  add column in_office_at timestamptz,
  add column in_office_by uuid references public.staff_user (id),
  add column ready_at     timestamptz,
  add column ready_by     uuid references public.staff_user (id);
alter table public.document
  add constraint document_custody_hard_copy check (custody is null or received_as = 'hard_copy'),
  add constraint document_custody_ready_returnable check (custody is distinct from 'ready' or returnable),
  add constraint document_custody_in_office_at check ((custody is null) = (in_office_at is null)),
  add constraint document_custody_ready_at check ((custody is not distinct from 'ready') = (ready_at is not null)),
  add constraint document_custody_by check ((in_office_at is not null or in_office_by is null) and (ready_at is not null or ready_by is null));
create index document_in_office_by_idx on public.document (in_office_by);
create index document_ready_by_idx on public.document (ready_by);
-- Today's "To place" and "In office > 30 days" and the Custody filter read these together with office and status.
create index document_custody_idx on public.document (office_id, custody) where archived_at is null;
comment on column public.document.custody is '13: in_office | ready (null = not placed). Changed only by set_custody / undo_custody / create_dispatch (app.doc_custody).';
grant update (custody, in_office_at, in_office_by, ready_at, ready_by) on public.document to authenticated;

-- ── 2. History (append-only, like 07's document_review) ────────────────────────────────────────────────────────────
create type public.custody_event as enum ('in_office', 'ready', 'undo_in_office', 'undo_ready');
create table public.document_custody (
  id          uuid primary key default gen_random_uuid(),
  office_id   uuid not null references public.office (id),
  -- on delete cascade only so reset_test_office's purge keeps working (06's rule); real offices never delete documents.
  document_id uuid not null references public.document (id) on delete cascade,
  step        public.custody_event not null,
  implied     boolean not null default false, -- S2: recorded by create_dispatch for a step nobody clicked
  actor_id    uuid references public.staff_user (id),
  at          timestamptz not null default now()
);
create index document_custody_document_idx on public.document_custody (document_id, at);
create index document_custody_office_idx on public.document_custody (office_id);
create index document_custody_actor_idx on public.document_custody (actor_id);
create trigger document_custody_no_update before update on public.document_custody
  for each row execute function private.review_dispatch_before_update();
create trigger document_custody_no_delete before delete on public.document_custody
  for each row execute function private.forbid_delete_unless_purge();
alter table public.document_custody enable row level security;
-- Follows its document's visibility (the subquery runs under document RLS).
create policy document_custody_select on public.document_custody for select to authenticated
  using (office_id = (select private.current_office_id())
         and exists (select 1 from public.document d where d.id = document_id));
-- Written only inside set_custody / undo_custody / create_dispatch (app.doc_custody = the document), as the caller.
create policy document_custody_insert on public.document_custody for insert to authenticated
  with check (office_id = (select private.current_office_id())
              and coalesce((select current_setting('app.doc_custody', true)), '') = document_id::text
              and actor_id = (select private.current_staff_id())
              and exists (select 1 from public.document d where d.id = document_custody.document_id
                          and d.office_id = document_custody.office_id));
revoke all on public.document_custody from anon, authenticated;
grant select on public.document_custody to authenticated;
grant insert (office_id, document_id, step, implied, actor_id) on public.document_custody to authenticated;

-- ── 3. 03's trigger: the custody gate and the S5 rules ─────────────────────────────────────────────────────────────
create or replace function private.document_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_at     timestamptz;
  v_fy     text;
  v_n      integer;
  t        public.doc_type;
  v_pkind  public.period_kind;
  v_today  date := (now() at time zone 'Asia/Kolkata')::date;
  v_dims   boolean;
  v_user   boolean := (select auth.uid()) is not null;
  v_merge  boolean := false; -- 05
begin
  if tg_op = 'UPDATE' and coalesce(current_setting('app.purge_office', true), '') = old.office_id::text then
    return new; -- reset_test_office
  end if;
  -- 1. Tenant boundary first.
  if v_user and new.office_id is distinct from private.current_office_id() then
    raise exception 'OFFICE_DENIED: new row violates row-level security for this office' using errcode = '42501';
  end if;
  -- 2. Only the vault's functions write documents (the version trigger updates the current version).
  if v_user and coalesce(current_setting('app.doc_write', true), '') <> 'on'
     and not (tg_op = 'UPDATE' and coalesce(current_setting('app.doc_version', true), '') = new.id::text) then
    raise exception 'permission denied: documents change only through the vault''s functions' using errcode = '42501';
  end if;

  -- 12 (spec AC-8, AC-10, AC-14; plan R2): received as = the paper form; Returnable = it goes back to the client.
  -- 'original' is legacy input only: stored as a hard copy + returnable (a check constraint refuses it as a value).
  if new.received_as = 'original' then new.received_as := 'hard_copy'; new.returnable := true; end if;
  if new.returnable and new.received_as <> 'hard_copy' then
    raise exception 'RETURNABLE_HARD_COPY: only a hard copy can be returnable' using errcode = '23514';
  end if;
  -- Handed over by (12 C, decision D1: one text field): the shape only (the app requires it on new hard copies, R2).
  -- 1-120 characters, never on a soft copy, and once set it can be changed but not cleared while it stays a hard copy.
  new.handed_over_name := nullif(btrim(new.handed_over_name), '');
  if length(new.handed_over_name) > 120 then
    raise exception 'HANDED_OVER_NAME: say who handed it over (up to 120 characters)' using errcode = '23514';
  end if;
  if new.handed_over_name is not null and new.received_as <> 'hard_copy' then
    raise exception 'HANDED_OVER_SOFT_COPY: only a hard copy records who handed it over' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and old.handed_over_name is not null and new.handed_over_name is null and new.received_as = 'hard_copy' then
    raise exception 'HANDED_OVER_CLEAR: who handed it over can be changed but not cleared' using errcode = '23514';
  end if;

  -- 13 (spec AC-3, AC-7): the custody step (in office · ready) and its who/when change only inside set_custody /
  -- undo_custody / create_dispatch (app.doc_custody = this document's id) or 13's backfill (service role, 'backfill').
  -- Anything else keeps them; a new document starts with none.
  if tg_op = 'INSERT' then
    new.custody := null; new.in_office_at := null; new.in_office_by := null; new.ready_at := null; new.ready_by := null;
  elsif not (coalesce(current_setting('app.doc_custody', true), '') = new.id::text
             or (not v_user and coalesce(current_setting('app.doc_custody', true), '') = 'backfill')) then
    new.custody := old.custody; new.in_office_at := old.in_office_at; new.in_office_by := old.in_office_by;
    new.ready_at := old.ready_at; new.ready_by := old.ready_by;
  end if;
  -- 13 (S5): a document in custody stays a hard copy, and a Ready one stays returnable, until the step is undone.
  if new.custody is not null and new.received_as <> 'hard_copy' then
    raise exception 'CUSTODY_SOFT_COPY: undo Document in office first; a document in the office is a hard copy' using errcode = '23514';
  end if;
  if new.custody = 'ready' and not new.returnable then
    raise exception 'CUSTODY_READY: undo Ready to dispatch first; a document ready to go back must stay returnable' using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    -- D (review N-1): a proposed type's row lock is taken before the office's DOC-ID counter row, so filing under a
    -- type that is being merged waits alone instead of holding the counter (and every other filing) behind it.
    if new.doc_type_id is not null then
      perform 1 from public.doc_type where id = new.doc_type_id and office_id = new.office_id and status = 'proposed' for share;
    end if;
    v_at := coalesce(nullif(current_setting('app.doc_clock', true), '')::timestamptz, now());
    v_fy := private.fy_code_of(v_at);
    insert into public.doc_counter as c (office_id, fy_code, last) values (new.office_id, v_fy, 1)
      on conflict (office_id, fy_code) do update set last = c.last + 1
      returning c.last into v_n;
    new.fy_code := v_fy;
    new.doc_code := 'DOC-FY' || substr(v_fy, 3) || '-' || case when v_n > 99999 then v_n::text else lpad(v_n::text, 5, '0') end;
    new.created_by := private.current_staff_id();
    new.created_at := now();
    new.received_by := coalesce(new.received_by, private.current_staff_id());
    new.status := 'received';
    new.reviewed_by := null; new.reviewed_at := null; new.correction_reason := null; -- 07
    new.correction_kind := null; -- 12
    new.current_version_id := null;
    new.version_count := 0;
    new.classified_at := case when new.client_id is not null and new.doc_type_id is not null then now() end;
    new.archived_at := null; new.archived_by := null; new.archive_reason := null;
    v_dims := true;
  else
    if new.id <> old.id or new.office_id <> old.office_id or new.doc_code <> old.doc_code or new.fy_code <> old.fy_code
       or new.created_by is distinct from old.created_by or new.created_at <> old.created_at then
      raise exception 'IMMUTABLE: DOC-ID, FY, office and creator cannot change' using errcode = 'P0001';
    end if;
    if (new.current_version_id is distinct from old.current_version_id or new.version_count <> old.version_count)
       and coalesce(current_setting('app.doc_version', true), '') <> new.id::text then
      raise exception 'IMMUTABLE: the current version changes only by adding a version' using errcode = 'P0001';
    end if;
    if (new.archived_at is distinct from old.archived_at or new.archived_by is distinct from old.archived_by
        or new.archive_reason is distinct from old.archive_reason) and not private.is_privileged() then
      raise exception 'ROLE_REQUIRED: only Admin or Manager can archive or unarchive a document' using errcode = '42501';
    end if;
    -- 05: a catalogue merge (merge_proposed_type / approve_proposed_type set app.type_merge = the proposed type's id)
    -- changes doc_type_id alone. It moves archived documents too and keeps review state (spec AC-5, AC-6).
    v_merge := coalesce(coalesce(current_setting('app.type_merge', true), '') = old.doc_type_id::text, false)
               and new.doc_type_id is distinct from old.doc_type_id
               and (new.client_id, new.period_id, new.registration_id, new.received_as, new.channel, new.received_on,
                    new.received_by, new.remark, new.current_version_id, new.archived_at, new.archived_by, new.archive_reason)
                   is not distinct from
                   (old.client_id, old.period_id, old.registration_id, old.received_as, old.channel, old.received_on,
                    old.received_by, old.remark, old.current_version_id, old.archived_at, old.archived_by, old.archive_reason);
    if old.archived_at is not null and new.archived_at is not null and not v_merge -- 05
       and (new.client_id, new.doc_type_id, new.period_id, new.registration_id, new.received_as, new.channel,
            new.received_on, new.received_by, new.remark, new.current_version_id)
           is distinct from
           (old.client_id, old.doc_type_id, old.period_id, old.registration_id, old.received_as, old.channel,
            old.received_on, old.received_by, old.remark, old.current_version_id) then
      raise exception 'ARCHIVED: unarchive the document before changing it' using errcode = 'P0001';
    end if;
    -- 3. Once filed, always filed (client and type may change, not be removed).
    if old.classified_at is not null and (new.client_id is null or new.doc_type_id is null) then
      raise exception 'DECLASSIFY: a filed document keeps a client and a type' using errcode = '23514';
    end if;
    if new.archived_at is null then
      new.archived_by := null; new.archive_reason := null;
    elsif old.archived_at is null then
      new.archived_by := coalesce(private.current_staff_id(), new.archived_by);
    end if;
    -- 07 (status gate): status and the review columns change only inside review_document / undo_review,
    -- which set app.doc_review to this document's id. Anything else keeps them.
    if coalesce(current_setting('app.doc_review', true), '') <> new.id::text then
      new.status := old.status;
      new.reviewed_by := old.reviewed_by; new.reviewed_at := old.reviewed_at; new.correction_reason := old.correction_reason;
      new.correction_kind := old.correction_kind; -- 12
    end if;
    new.classified_at := coalesce(old.classified_at,
      case when new.client_id is not null and new.doc_type_id is not null then now() end);
    v_dims := (new.client_id, new.doc_type_id, new.period_id, new.registration_id)
              is distinct from (old.client_id, old.doc_type_id, old.period_id, old.registration_id);
    -- 07 (AC-4): a new version, or a change of what the document is (client, type, period, registration), sends a
    -- reviewed or Needs-correction document back to To review, with a 'reset' row in its history.
    if old.status <> 'received' and new.status = old.status and not v_merge -- 05
       and (v_dims or new.current_version_id is distinct from old.current_version_id
            -- 12 (spec AC-23, plan R1): a "wrong details" correction is also fixed by changing how or when it was
            -- received or who handed it over. Remark, channel and received-by never reset a Needs-correction document.
            or (old.status = 'needs_correction' and old.correction_kind = 'details'
                and (new.received_as, new.returnable, new.received_on, new.handed_over_name)
                    is distinct from (old.received_as, old.returnable, old.received_on, old.handed_over_name))) then
      new.status := 'received';
      new.reviewed_by := null; new.reviewed_at := null; new.correction_reason := null;
      new.correction_kind := null; -- 12
      insert into public.document_review (office_id, document_id, outcome, actor_id)
        values (new.office_id, new.id, 'reset', private.current_staff_id());
    end if;
    if new.received_on <> old.received_on and new.received_on > v_today then
      raise exception 'RECEIVED_ON_FUTURE: received on cannot be in the future' using errcode = '23514';
    end if;
    if new.received_by <> old.received_by then perform private.check_assignee(new.received_by, new.office_id); end if;
  end if;

  if tg_op = 'INSERT' then
    if new.received_on > v_today then
      raise exception 'RECEIVED_ON_FUTURE: received on cannot be in the future' using errcode = '23514';
    end if;
    perform private.check_assignee(new.received_by, new.office_id);
  end if;

  if v_dims then
    if new.client_id is not null and not exists (
        select 1 from public.client c where c.id = new.client_id and c.office_id = new.office_id) then
      raise exception 'CLIENT_OFFICE: client belongs to another office' using errcode = '23514';
    end if;
    -- 4. Filing to (or moving onto) an archived client is refused.
    if new.client_id is not null and (tg_op = 'INSERT' or new.client_id is distinct from old.client_id)
       and exists (select 1 from public.client c where c.id = new.client_id and c.archived_at is not null) then
      raise exception 'CLIENT_ARCHIVED: this client is archived' using errcode = '23514';
    end if;
    if new.doc_type_id is not null then
      select * into t from public.doc_type where id = new.doc_type_id and office_id = new.office_id;
      if not found then raise exception 'TYPE_OFFICE: document type belongs to another office' using errcode = '23514'; end if;
      -- 05 (AC-11): filing under a proposed type waits for a decision in progress and re-reads the row, so a document
      -- either lands before a merge (and moves with it) or sees the retired type and is refused.
      if t.status = 'proposed' then
        select * into t from public.doc_type where id = new.doc_type_id and office_id = new.office_id for share;
      end if;
      if not t.active or (t.status = 'proposed' and t.proposed_for_client_id is distinct from new.client_id) then
        raise exception 'TYPE_NOT_OFFERED: this type is not offered for this client' using errcode = '23514';
      end if;
    end if;
    if new.period_id is not null then
      select p.kind into v_pkind from public.period p where p.id = new.period_id and p.office_id = new.office_id;
      if not found then raise exception 'PERIOD_OFFICE: period belongs to another office' using errcode = '23514'; end if;
      if t.id is not null and not (
          t.period_kind in ('month', 'none')
          or (t.period_kind = 'quarter' and v_pkind in ('quarter', 'year'))
          or (t.period_kind = 'year' and v_pkind = 'year')) then
        raise exception 'PERIOD_KIND: a % document cannot be filed for a % period', t.period_kind, v_pkind using errcode = '23514';
      end if;
    end if;
    if new.registration_id is not null and (t.id is null or t.registration_kind is null or not exists (
        select 1 from public.client_registration r
         where r.id = new.registration_id and r.office_id = new.office_id and r.client_id = new.client_id
           and r.active and r.kind = t.registration_kind)) then
      raise exception 'REGISTRATION_MISMATCH: registration must be an active GSTIN/TAN of this client, as the type needs' using errcode = '23514';
    end if;
  end if;

  -- 11 (spec AC-14, S2): the format check, a snapshot taken at filing. Re-evaluated only when the current file or
  -- the document's client or type changes (a new document gets it when its first version lands, under
  -- app.doc_version); kept as it is on everything else, including 05's merge. Written only here, on every path
  -- (staff, Upload for a requested item, 10's link path), so no caller can set it.
  if tg_op = 'INSERT' then
    new.format_preferred := null; new.format_ok := null;
  elsif v_merge or ((new.client_id, new.doc_type_id) is not distinct from (old.client_id, old.doc_type_id)
                    and new.current_version_id is not distinct from old.current_version_id) then
    new.format_preferred := old.format_preferred; new.format_ok := old.format_ok;
  else
    select f.preferred, f.ok into new.format_preferred, new.format_ok
      from private.format_check(new.office_id, new.client_id, new.doc_type_id, new.current_version_id) f;
  end if;

  new.updated_at := now();
  return new;
end $$;

-- ── 4. Data step (spec AC-17, intent Q3): existing documents keep what they show today ───────────────────────────────
-- Live dispatch packet, or returnable with a review decision (07/12 showed "Ready to dispatch") → ready; any other hard
-- copy with a review decision → in office; To review, Untagged and soft copies → unchanged. Archived documents follow the
-- same rule. Dates = reviewed_at (best known); who = null ("set when custody started"). No history or activity rows.
-- Idempotent: touches only documents with no step. Service role only (also run by tests on their own test office).
create function public.custody_backfill(p_office uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ready     integer;
  v_in_office integer;
begin
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
revoke all on function public.custody_backfill(uuid) from public, anon, authenticated;
grant execute on function public.custody_backfill(uuid) to service_role;

do $$
declare
  o record;
  r jsonb;
begin
  for o in select id, name from public.office order by name loop
    r := public.custody_backfill(o.id);
    raise notice '13 custody backfill: office % → %', o.id, r;
  end loop;
end $$;
