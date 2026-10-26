-- 11-file-type-rules · migration A: preferred formats per type, client exceptions, the format check on documents,
-- and the pre-loaded preferences (spec AC-1, AC-2, AC-4, AC-6, AC-14, AC-15; plan step 2, P1).
-- Advisory only: nothing here refuses a file for its format.

-- ── 1. The format rule (mirrored in src/lib/validation/formats.ts; tested equal) ───────────────────────────
-- Format choices = 03's allow-list minus ZIP (spec S5). jpeg is stored as jpg.
create or replace function private.format_choices()
returns text[] language sql immutable set search_path = '' as $$
  select array['pdf', 'jpg', 'png', 'heic', 'xlsx', 'xls', 'csv', 'docx']::text[]
$$;

-- A valid preference: a non-empty list of distinct format choices (lower case, jpg not jpeg).
create or replace function private.formats_valid(p text[])
returns boolean language sql immutable set search_path = '' as $$
  select p is null or (
    cardinality(p) > 0
    and p <@ private.format_choices()
    and cardinality(p) = (select count(distinct x) from unnest(p) as x)
  )
$$;

-- The format of a stored file = its path's extension, lower case, jpeg → jpg.
create or replace function public.format_of_path(p_path text)
returns text language sql immutable set search_path = '' as $$
  select case e when 'jpeg' then 'jpg' else e end
    from (select lower(substring(p_path from '\.([A-Za-z0-9]+)$')) as e) x
$$;

-- "Excel or CSV", "PDF, Excel or CSV", "Image", "Word" … in a fixed order: PDF · Excel · CSV · Image · Word.
create or replace function public.format_label(p_formats text[])
returns text language sql immutable set search_path = '' as $$
  with parts as (
    select array_remove(array[
      case when 'pdf' = any(p_formats) then 'PDF' end,
      case when p_formats && array['xlsx', 'xls'] then 'Excel' end,
      case when 'csv' = any(p_formats) then 'CSV' end,
      case when p_formats && array['jpg', 'png', 'heic'] then 'Image' end,
      case when 'docx' = any(p_formats) then 'Word' end
    ], null) as p
  )
  select case
           when cardinality(p) = 0 then null
           when cardinality(p) = 1 then p[1]
           else array_to_string(p[1:cardinality(p) - 1], ', ') || ' or ' || p[cardinality(p)]
         end
    from parts
$$;
revoke all on function public.format_of_path(text), public.format_label(text[]) from public, anon, authenticated;
grant execute on function public.format_of_path(text), public.format_label(text[]) to service_role;

-- ── 2. Columns, checks and grants ────────────────────────────────────────────────────────────────────────
alter table public.doc_type add column preferred_formats text[];
alter table public.doc_type add constraint doc_type_preferred_formats_check
  check (private.formats_valid(preferred_formats) and (preferred_formats is null or status = 'approved'));

alter table public.client_doc_type add column any_format boolean not null default false;

alter table public.document add column format_preferred text[];
alter table public.document add column format_ok boolean;
alter table public.document add constraint document_format_check_pair
  check ((format_preferred is null) = (format_ok is null));

-- Catalogue writes stay Admin/Manager (doc_type RLS); the exception follows client_doc_type's RLS, which already
-- refuses Limited (plan P1). The document columns get no grant: only the filing trigger writes them.
grant insert (preferred_formats), update (preferred_formats) on public.doc_type to authenticated;
grant update (any_format) on public.client_doc_type to authenticated;

-- ── 3. The check itself, read by 03's filing trigger ─────────────────────────────────────────────────────
-- Applies when the type has a preference and the client's plan row for that type has no exception.
create or replace function private.format_check(p_office uuid, p_client uuid, p_type uuid, p_version uuid,
                                                out preferred text[], out ok boolean)
language plpgsql stable set search_path = '' as $$
declare v_path text;
begin
  preferred := null; ok := null;
  if p_client is null or p_type is null or p_version is null then return; end if;
  select t.preferred_formats into preferred from public.doc_type t where t.id = p_type and t.office_id = p_office;
  if preferred is null then return; end if;
  if exists (select 1 from public.client_doc_type r
              where r.office_id = p_office and r.client_id = p_client and r.doc_type_id = p_type and r.any_format) then
    preferred := null; return;
  end if;
  select v.storage_path into v_path from public.document_version v where v.id = p_version and v.office_id = p_office;
  ok := coalesce(public.format_of_path(v_path) = any(preferred), false);
end $$;
revoke all on function private.format_check(uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- 03's trigger, unchanged from 05's version (20261006063304) except the 11 block before updated_at.
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
    end if;
    new.classified_at := coalesce(old.classified_at,
      case when new.client_id is not null and new.doc_type_id is not null then now() end);
    v_dims := (new.client_id, new.doc_type_id, new.period_id, new.registration_id)
              is distinct from (old.client_id, old.doc_type_id, old.period_id, old.registration_id);
    -- 07 (AC-4): a new version, or a change of what the document is (client, type, period, registration), sends a
    -- reviewed or Needs-correction document back to To review, with a 'reset' row in its history.
    if old.status <> 'received' and new.status = old.status and not v_merge -- 05
       and (v_dims or new.current_version_id is distinct from old.current_version_id) then
      new.status := 'received';
      new.reviewed_by := null; new.reviewed_at := null; new.correction_reason := null;
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

-- ── 4. Pre-loaded preferences (spec AC-4, S1) ────────────────────────────────────────────────────────────
-- Sets the six seed types by name (case-insensitive) when approved, client-source and without a list.
-- Renamed or removed types are skipped; a list already set is never overwritten. Returns how many it set.
create or replace function private.seed_preferred_formats(p_office_id uuid, p_log boolean)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_n integer := 0; r record;
begin
  for r in
    with seed(name, formats) as (values
      ('Bank statement', array['xlsx', 'xls', 'csv']),
      ('Salary register / attendance', array['xlsx', 'xls', 'csv']),
      ('Salary paid to employees (for TDS)', array['xlsx', 'xls', 'csv']),
      ('Payments to vendors / contractors / rent / professionals', array['xlsx', 'xls', 'csv']),
      ('Capital gains statement from broker / fund house', array['pdf', 'xlsx', 'xls', 'csv']),
      ('Loans & deposits outstanding at 31 Mar (lender list, amounts)', array['pdf', 'xlsx', 'xls', 'csv']))
    update public.doc_type t set preferred_formats = s.formats::text[]
      from seed s
     where t.office_id = p_office_id and lower(t.name) = lower(s.name)
       and t.status = 'approved' and t.source = 'client' and t.preferred_formats is null
    returning t.id, t.preferred_formats
  loop
    v_n := v_n + 1;
    if p_log then
      insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
        values (p_office_id, null, 'doc_type.formats_changed', 'doc_type', r.id,
                jsonb_build_object('old', null, 'new', to_jsonb(r.preferred_formats), 'via', 'seed'));
    end if;
  end loop;
  return v_n;
end $$;
revoke all on function private.seed_preferred_formats(uuid, boolean) from public, anon, authenticated;

-- 02's seed (20260927070427), unchanged except the last line: new and test offices get the preferences too.
create or replace function private.seed_catalogue(p_office_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.doc_group (office_id, code, name, sort)
  select p_office_id, g.code, g.name, g.sort from (values
    ('gst', 'GST', 10),
    ('tds_tcs', 'TDS/TCS', 20),
    ('income_tax', 'Income Tax', 30),
    ('banking', 'Banking', 40),
    ('roc_mca', 'ROC/MCA', 50),
    ('payroll', 'Payroll', 60),
    ('audit', 'Audit', 70),
    ('accounting', 'Accounting', 80),
    ('registrations', 'Registrations', 90),
    ('other', 'Other', 100)
  ) as g(code, name, sort)
  on conflict (office_id, code) do nothing;

  insert into public.doc_type (office_id, doc_group_id, code, name, aliases, period_kind, default_frequency, source, used_for,
                               ask_after_months, ask_day, overdue_after_months, overdue_day, registration_kind, reminders)
  select p_office_id, dg.id, t.code, t.name, t.aliases, t.period_kind::public.period_kind, t.freq::public.frequency,
         t.source::public.doc_source, t.used_for, t.am, t.ad, t.om, t.od, t.rk::public.registration_kind, t.rem
  from (values
    ('gst', 'gst_sales_invoices_sales_register', 'Sales invoices / sales register', array['Outward supplies']::text[], 'month', 'monthly', 'client', 'GSTR-1: 11th (QRMP 13th after qtr)', 1, 1, 1, 5, 'gstin', true),
    ('gst', 'gst_purchase_invoices_purchase_register', 'Purchase invoices / purchase register', array['Inward supplies']::text[], 'month', 'monthly', 'client', 'GSTR-3B: 20th (QRMP 22nd/24th); ITC check', 1, 1, 1, 10, 'gstin', true),
    ('gst', 'gst_credit_debit_notes_issued_and_received', 'Credit / debit notes issued and received', '{}'::text[], 'month', 'monthly', 'client', 'GSTR-1 / GSTR-3B', 1, 1, 1, 5, 'gstin', true),
    ('gst', 'gst_e_way_bills', 'E-way bills', '{}'::text[], 'month', 'as_needed', 'client', 'GSTR-1 reconciliation', null, null, null, null, 'gstin', false),
    ('gst', 'gst_gst_notice_order_received', 'GST notice / order received', '{}'::text[], 'none', 'as_needed', 'client', 'reply to department', null, null, null, null, 'gstin', false),
    ('tds_tcs', 'tds_tcs_salary_paid_to_employees_for_tds', 'Salary paid to employees (for TDS)', array['Payroll for TDS']::text[], 'month', 'monthly', 'client', 'TDS deposit 7th; quarterly return Form 138 (old 24Q)', 1, 1, 1, 3, 'tan', true),
    ('tds_tcs', 'tds_tcs_payments_to_vendors_contractors_rent_professionals', 'Payments to vendors / contractors / rent / professionals', array['TDS deduction details']::text[], 'month', 'monthly', 'client', 'TDS deposit 7th; quarterly return Form 140 (old 26Q)', 1, 1, 1, 3, 'tan', true),
    ('tds_tcs', 'tds_tcs_tds_tcs_payment_challans_if_the_client_pays', 'TDS / TCS payment challans (if the client pays)', array['Challan 281']::text[], 'month', 'monthly', 'client', 'quarterly TDS/TCS return', 1, 8, 1, 12, 'tan', true),
    ('tds_tcs', 'tds_tcs_deductee_pan_lower_deduction_certificates', 'Deductee PAN / lower-deduction certificates', '{}'::text[], 'none', 'as_needed', 'client', 'correct TDS rate', null, null, null, null, 'tan', false),
    ('tds_tcs', 'tds_tcs_tds_notice_default_received', 'TDS notice / default received', '{}'::text[], 'none', 'as_needed', 'client', 'reply / correction', null, null, null, null, 'tan', false),
    ('income_tax', 'income_tax_form_16_from_employer', 'Form 16 from employer', array['Form 130']::text[], 'year', 'yearly', 'client', 'ITR-1/2: 31 Jul', 2, 16, 3, 10, null, true),
    ('income_tax', 'income_tax_form_16a_from_deductors', 'Form 16A from deductors', array['Form 131']::text[], 'quarter', 'quarterly', 'client', 'ITR (TDS credit)', 2, 1, 2, 20, null, false),
    ('income_tax', 'income_tax_ais_tis_form_26as_client_sends_or_firm_downloads', 'AIS / TIS / Form 26AS (client sends, or firm downloads with client''s login)', array['26AS', 'Annual Information Statement']::text[], 'year', 'yearly', 'client', 'ITR (income + TDS check)', 2, 1, 3, 10, null, false),
    ('income_tax', 'income_tax_investment_deduction_proofs', 'Investment & deduction proofs', array['80C', '80D proofs']::text[], 'year', 'yearly', 'client', 'ITR-1/2: 31 Jul', 1, 1, 3, 10, null, true),
    ('income_tax', 'income_tax_capital_gains_statement_from_broker_fund_house', 'Capital gains statement from broker / fund house', array['Broker P&L']::text[], 'year', 'yearly', 'client', 'ITR', 2, 1, 3, 10, null, true),
    ('income_tax', 'income_tax_rent_received_home_loan_interest_details', 'Rent received / home-loan interest details', array['House property']::text[], 'year', 'yearly', 'client', 'ITR', 2, 1, 3, 10, null, true),
    ('income_tax', 'income_tax_advance_tax_challans_if_the_client_paid', 'Advance tax challans (if the client paid)', '{}'::text[], 'month', 'as_needed', 'client', 'ITR (tax credit)', null, null, null, null, null, false),
    ('income_tax', 'income_tax_income_tax_notice_order_received', 'Income-tax notice / order received', '{}'::text[], 'none', 'as_needed', 'client', 'reply to department', null, null, null, null, null, false),
    ('banking', 'banking_bank_statement', 'Bank statement', '{}'::text[], 'month', 'monthly', 'client', 'books; GST reconciliation', 1, 1, 1, 7, null, true),
    ('banking', 'banking_loan_statement_interest_certificate', 'Loan statement / interest certificate', '{}'::text[], 'year', 'yearly', 'client', 'ITR / audit', 1, 1, 2, 15, null, true),
    ('banking', 'banking_bank_balance_confirmation', 'Bank balance confirmation', '{}'::text[], 'year', 'yearly', 'client', 'audit', 1, 1, 1, 30, null, true),
    ('banking', 'banking_fd_interest_certificates', 'FD / interest certificates', '{}'::text[], 'year', 'yearly', 'client', 'ITR', 1, 1, 2, 15, null, true),
    ('roc_mca', 'roc_mca_board_general_meeting_minutes_and_notices', 'Board & general meeting minutes and notices', '{}'::text[], 'year', 'yearly', 'client', 'annual accounts & return filing (AGM by 30 Sep)', 5, 1, 5, 31, null, true),
    ('roc_mca', 'roc_mca_shareholding_changes_share_transfer_details', 'Shareholding changes & share transfer details', '{}'::text[], 'year', 'yearly', 'client', 'annual return MGT-7 / 7A (60 days after AGM)', 5, 1, 6, 15, null, true),
    ('roc_mca', 'roc_mca_loans_deposits_outstanding_at_31_mar_lender_list_amo', 'Loans & deposits outstanding at 31 Mar (lender list, amounts)', '{}'::text[], 'year', 'yearly', 'client', 'DPT-3: 30 Jun', 1, 1, 2, 15, null, true),
    ('roc_mca', 'roc_mca_director_kyc_details_pan_aadhaar_mobile_email', 'Director KYC details (PAN, Aadhaar, mobile, email)', '{}'::text[], 'year', 'yearly', 'client', 'DIR-3 KYC: 30 Sep', 5, 1, 5, 20, null, true),
    ('roc_mca', 'roc_mca_statutory_registers', 'Statutory registers', '{}'::text[], 'none', 'as_needed', 'client', 'ROC compliance', null, null, null, null, null, false),
    ('roc_mca', 'roc_mca_roc_notice_order_received', 'ROC notice / order received', '{}'::text[], 'none', 'as_needed', 'client', 'reply to ROC', null, null, null, null, null, false),
    ('payroll', 'payroll_salary_register_attendance', 'Salary register / attendance', '{}'::text[], 'month', 'monthly', 'client', 'PF, ESI, TDS', 1, 1, 1, 3, null, true),
    ('payroll', 'payroll_pf_payment_challan_if_the_client_pays', 'PF payment challan (if the client pays)', '{}'::text[], 'month', 'monthly', 'client', 'PF: 15th', 1, 16, 1, 20, null, false),
    ('payroll', 'payroll_esi_payment_challan_if_the_client_pays', 'ESI payment challan (if the client pays)', '{}'::text[], 'month', 'monthly', 'client', 'ESI: 15th', 1, 16, 1, 20, null, false),
    ('payroll', 'payroll_professional_tax_challan', 'Professional tax challan', array['PT']::text[], 'month', 'as_needed', 'client', 'state PT return', null, null, null, null, null, false),
    ('audit', 'audit_trial_balance_books_of_accounts', 'Trial balance & books of accounts', array['Tally backup at year end']::text[], 'year', 'yearly', 'client', 'tax audit (30 Sep) / ITR', 1, 1, 4, 31, null, true),
    ('audit', 'audit_fixed_asset_purchase_sale_details', 'Fixed asset purchase & sale details', array['Asset register']::text[], 'year', 'yearly', 'client', 'audit; depreciation', 1, 1, 4, 31, null, true),
    ('audit', 'audit_closing_stock_statement', 'Closing stock statement', array['Inventory']::text[], 'year', 'yearly', 'client', 'audit', 1, 1, 1, 15, null, true),
    ('audit', 'audit_debtor_creditor_balance_confirmations', 'Debtor / creditor balance confirmations', '{}'::text[], 'year', 'yearly', 'client', 'audit', 1, 1, 3, 30, null, true),
    ('accounting', 'accounting_expense_bills_vouchers', 'Expense bills & vouchers', '{}'::text[], 'month', 'monthly', 'client', 'books', 1, 1, 1, 10, null, true),
    ('accounting', 'accounting_cash_petty_cash_book', 'Cash / petty cash book', '{}'::text[], 'month', 'monthly', 'client', 'books', 1, 1, 1, 10, null, true),
    ('accounting', 'accounting_accounting_data_backup', 'Accounting data backup', array['Tally backup']::text[], 'month', 'monthly', 'client', 'books', 1, 1, 1, 15, null, false),
    ('registrations', 'registrations_pan_card', 'PAN card', '{}'::text[], 'none', 'as_needed', 'client', 'KYC', null, null, null, null, null, false),
    ('registrations', 'registrations_gst_registration_certificate', 'GST registration certificate', array['GST certificate', 'REG-06']::text[], 'none', 'as_needed', 'client', 'KYC', null, null, null, null, null, false),
    ('registrations', 'registrations_tan_allotment_letter', 'TAN allotment letter', '{}'::text[], 'none', 'as_needed', 'client', 'KYC', null, null, null, null, null, false),
    ('registrations', 'registrations_incorporation_deed_coi_moa_aoa_partnership_or', 'Incorporation / deed (COI, MOA/AOA, partnership or trust deed)', '{}'::text[], 'none', 'as_needed', 'client', 'KYC', null, null, null, null, null, false),
    ('registrations', 'registrations_udyam_msme_certificate', 'Udyam / MSME certificate', '{}'::text[], 'none', 'as_needed', 'client', 'KYC', null, null, null, null, null, false),
    ('registrations', 'registrations_other_licences_shops_est_iec_pt_registration', 'Other licences (Shops & Est., IEC, PT registration)', '{}'::text[], 'none', 'as_needed', 'client', 'KYC', null, null, null, null, null, false),
    ('registrations', 'registrations_kyc_of_proprietor_partners_directors', 'KYC of proprietor / partners / directors', '{}'::text[], 'none', 'as_needed', 'client', 'KYC', null, null, null, null, null, false),
    ('other', 'other_correspondence_miscellaneous_from_client', 'Correspondence / miscellaneous from client', '{}'::text[], 'none', 'as_needed', 'client', null, null, null, null, null, null, false),
    ('gst', 'gst_gst_returns_filed_acknowledgements', 'GST returns filed & acknowledgements', array['GSTR-1', 'GSTR-3B', 'GSTR-9', 'GSTR-9C']::text[], 'month', 'as_needed', 'firm', null, null, null, null, null, null, false),
    ('gst', 'gst_gst_working_reconciliation', 'GST working / reconciliation', '{}'::text[], 'month', 'as_needed', 'firm', null, null, null, null, null, null, false),
    ('tds_tcs', 'tds_tcs_tds_tcs_returns_filed_acknowledgements', 'TDS / TCS returns filed & acknowledgements', array['Form 138', '140', '143', '144', '24Q', '26Q', '27Q', '27EQ']::text[], 'quarter', 'as_needed', 'firm', null, null, null, null, null, null, false),
    ('tds_tcs', 'tds_tcs_tds_certificates_issued_to_deductees', 'TDS certificates issued to deductees', array['Form 16', '16A', 'Form 130', '131']::text[], 'quarter', 'as_needed', 'firm', null, null, null, null, null, null, false),
    ('income_tax', 'income_tax_itr_filed_acknowledgement', 'ITR filed & acknowledgement', array['ITR-V']::text[], 'year', 'as_needed', 'firm', null, null, null, null, null, null, false),
    ('income_tax', 'income_tax_computation_of_income', 'Computation of income', '{}'::text[], 'year', 'as_needed', 'firm', null, null, null, null, null, null, false),
    ('audit', 'audit_signed_financial_statements', 'Signed financial statements', array['Balance sheet', 'P&L']::text[], 'year', 'as_needed', 'firm', null, null, null, null, null, null, false),
    ('audit', 'audit_tax_audit_report', 'Tax audit report', array['3CA', '3CB', '3CD']::text[], 'year', 'as_needed', 'firm', null, null, null, null, null, null, false),
    ('roc_mca', 'roc_mca_roc_filings_challans', 'ROC filings & challans', array['AOC-4', 'MGT-7', 'DPT-3', 'DIR-3 KYC']::text[], 'year', 'as_needed', 'firm', null, null, null, null, null, null, false)
  ) as t(group_code, code, name, aliases, period_kind, freq, source, used_for, am, ad, om, od, rk, rem)
  join public.doc_group dg on dg.office_id = p_office_id and dg.code = t.group_code
  on conflict (office_id, code) do nothing;

  if not exists (select 1 from public.financial_year where office_id = p_office_id and code = '2025-26') then
    perform private.create_financial_year(p_office_id, 2025);
  end if;
  if not exists (select 1 from public.financial_year where office_id = p_office_id and code = '2026-27') then
    perform private.create_financial_year(p_office_id, 2026);
  end if;
  perform private.seed_preferred_formats(p_office_id, false); -- 11 (spec AC-4)
end $$;
revoke all on function private.seed_catalogue(uuid) from public, anon, authenticated;

-- Test-only: re-run the preference seed in a test office (the skip rules are tested without re-running this file).
create or replace function public.test_seed_preferred_formats(p_office_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.office where id = p_office_id and is_test) then
    raise exception 'NOT_TEST_OFFICE: only offices flagged is_test' using errcode = '42501';
  end if;
  return private.seed_preferred_formats(p_office_id, false);
end $$;
revoke all on function public.test_seed_preferred_formats(uuid) from public, anon, authenticated;
grant execute on function public.test_seed_preferred_formats(uuid) to service_role;

-- Existing offices: the real office is logged (one activity row per type set, actor = system); test offices are
-- re-seeded by every reset anyway.
select private.seed_preferred_formats(id, not is_test) from public.office;
