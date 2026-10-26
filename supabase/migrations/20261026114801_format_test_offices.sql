-- 11-file-type-rules · migration C (approved by Raja 2026-10-26): keep 10's existing tests unedited.
-- 1. 02's seed_catalogue back to its original body: automated-test offices no longer get the pre-loaded preferences
--    (they are fixtures; 11's tests switch preferences on explicitly with test_seed_preferred_formats). Real offices,
--    including staging/prod built by replaying the migrations, are seeded by migration A's one-time update.
-- 2. link_register writes `warned` only when it is true, so an ordinary upload's activity row is exactly as 10 wrote it.
-- 3. Test offices lose the preferences A gave them, so they match a freshly reset office.

-- 02's seed (20260927070427), restored unchanged.
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
end $$;
revoke all on function private.seed_catalogue(uuid) from public, anon, authenticated;

-- 10's link_register as in migration B, except the `warned` key (see 2).
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
            jsonb_build_object('client_id', r.client_id, 'request_id', r.id, 'item_id', i.id)
            -- 11 (spec AC-13): `warned` only when the page did warn (untrusted; metric only). Absent means not warned,
            -- so an ordinary upload's row is exactly as 10 wrote it.
            || case when jsonb_typeof(p_file->'warned') = 'boolean' and (p_file->>'warned') = 'true'
                    then jsonb_build_object('warned', true) else '{}'::jsonb end);
  -- D6: one bell notification to the requester per link per day (IDs only; text built at display time).
  if not exists (select 1 from public.notification n
                  where n.kind = 'link_upload' and n.entity_id = r.id
                    and (n.created_at at time zone 'Asia/Kolkata')::date = (now() at time zone 'Asia/Kolkata')::date) then
    perform private.notify(array[r.created_by], 'link_upload', 'upload_request', r.id, jsonb_build_object('request_id', r.id));
  end if;
  return jsonb_build_object('document_id', v_res->>'id', 'doc_code', v_res->>'doc_code', 'duplicate', false);
end $$;

update public.doc_type t set preferred_formats = null
  from public.office o
 where o.id = t.office_id and o.is_test and t.preferred_formats is not null;
