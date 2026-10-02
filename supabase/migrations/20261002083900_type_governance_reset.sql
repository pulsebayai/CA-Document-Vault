-- Feature 05 — migration B, part 4: reset_test_office (section 7 of the reviewed migration B; SQL gate approved by
-- Raja 2026-10-02 13:30). Its own migration because its DELETE lines need a separate confirmation in the apply tool.

-- ── 7. reset_test_office: 07's body + notifications and decided proposals (lines marked "05") ──────────
create or replace function public.reset_test_office(p_office_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.office where id = p_office_id and is_test) then
    raise exception 'NOT_TEST_OFFICE: only offices flagged is_test can be reset' using errcode = '42501';
  end if;
  perform set_config('app.purge_office', p_office_id::text, true);
  delete from public.notification        where office_id = p_office_id; -- 05
  delete from public.dispatch_item       where office_id = p_office_id; -- 07
  delete from public.dispatch            where office_id = p_office_id; -- 07
  delete from public.document_review     where office_id = p_office_id; -- 07
  update public.expected_doc set completed_by_document_id = null where office_id = p_office_id and completed_by_document_id is not null;
  update public.document set current_version_id = null, expected_doc_id = null
   where office_id = p_office_id and (current_version_id is not null or expected_doc_id is not null);
  delete from public.expected_doc        where office_id = p_office_id;
  delete from public.document_version    where office_id = p_office_id;
  delete from public.document            where office_id = p_office_id;
  delete from public.doc_counter         where office_id = p_office_id;
  delete from public.client_doc_type     where office_id = p_office_id;
  delete from public.client_group        where office_id = p_office_id;
  delete from public.doc_type            where office_id = p_office_id and status <> 'approved'; -- 05: + mapped, rejected
  delete from public.client_registration where office_id = p_office_id;
  delete from public.client_contact      where office_id = p_office_id;
  delete from public.client              where office_id = p_office_id;
  delete from public.period              where office_id = p_office_id;
  delete from public.financial_year      where office_id = p_office_id;
  delete from public.doc_type            where office_id = p_office_id;
  delete from public.doc_group           where office_id = p_office_id;
  perform set_config('app.purge_office', '', true);
  update public.office set client_code_counter = 0, test_today = null where id = p_office_id;
  perform private.seed_catalogue(p_office_id);
end $$;
