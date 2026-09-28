-- 02-clients-and-catalogue · migration 2: seed catalogue (seed-catalogue.md rev 2, approved 2026-09-26),
-- FY 2025-26 + 2026-27 with periods, and the service-role reset for test offices (plan D2).
-- Generated from seed-catalogue.md: 47 client documents + 9 firm records in 10 groups; none enabled for new clients.

-- Idempotent: inserts only what is missing (by code), so it never overwrites the CA's edits.
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

-- Seed every real office (today: the one v1 office). Test offices are seeded by reset_test_office.
select private.seed_catalogue(id) from public.office where not is_test;

-- Plan D2: return a test office to the seeded state. Service role only; refuses real offices.
-- Needed because rows are never deleted, and CI would otherwise add ~1,000 clients to dev every night.
create or replace function public.reset_test_office(p_office_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.office where id = p_office_id and is_test) then
    raise exception 'NOT_TEST_OFFICE: only offices flagged is_test can be reset' using errcode = '42501';
  end if;
  perform set_config('app.purge_office', p_office_id::text, true);
  delete from public.client_doc_type     where office_id = p_office_id;
  delete from public.client_group        where office_id = p_office_id;
  delete from public.client_registration where office_id = p_office_id;
  delete from public.client_contact      where office_id = p_office_id;
  delete from public.client              where office_id = p_office_id;
  delete from public.period              where office_id = p_office_id;
  delete from public.financial_year      where office_id = p_office_id;
  delete from public.doc_type            where office_id = p_office_id;
  delete from public.doc_group           where office_id = p_office_id;
  perform set_config('app.purge_office', '', true);
  update public.office set client_code_counter = 0 where id = p_office_id;
  perform private.seed_catalogue(p_office_id);
end $$;
revoke all on function public.reset_test_office(uuid) from public, anon, authenticated;
grant execute on function public.reset_test_office(uuid) to service_role;
