-- chore test-office-activity-purge (Sidambara, 2026-11-03).
-- Why: reset_test_office never deleted activity, so every test run added rows to dev for good (692k rows on
-- 2026-11-03, 492k of them from finished test offices, removed by hand that day with the guard switched off for one
-- transaction). This makes the purge include the reset office's activity.
--
-- 1. activity keeps its own append-only guard (private.forbid_change stays as it is for follow_up_item):
--    no UPDATE ever; DELETE only inside reset_test_office (transaction flag app.purge_office = the row's office).
--    Nothing but reset_test_office sets that flag (architecture: transaction flags), and the reset refuses any
--    office that isn't is_test, so real offices' activity stays append-only.
-- 2. reset_test_office: the same body as 20261025130428 plus one delete of the office's activity.
--
-- Rollback: point activity_append_only back at private.forbid_change(); restore reset_test_office from 20261025130428;
-- drop private.activity_append_only().

create or replace function private.activity_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE'
     and old.office_id::text = coalesce(nullif(current_setting('app.purge_office', true), ''), '-') then
    return old; -- reset_test_office of this row's (test) office
  end if;
  raise exception 'APPEND_ONLY: % rows cannot be changed or deleted', tg_table_name using errcode = 'P0001';
end $$;
revoke all on function private.activity_append_only() from public;

drop trigger if exists activity_append_only on public.activity;
create trigger activity_append_only before delete or update on public.activity
  for each row execute function private.activity_append_only();

create or replace function public.reset_test_office(p_office_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.office where id = p_office_id and is_test) then
    raise exception 'NOT_TEST_OFFICE: only offices flagged is_test can be reset' using errcode = '42501';
  end if;
  perform set_config('app.purge_office', p_office_id::text, true);
  delete from public.activity            where office_id = p_office_id; -- chore 2026-11-03: test activity no longer accumulates
  delete from public.link_attempt        where office_id = p_office_id; -- 10
  update public.document set upload_request_item_id = null
   where office_id = p_office_id and upload_request_item_id is not null; -- 10
  delete from public.upload_request_item where office_id = p_office_id; -- 10
  delete from public.upload_request      where office_id = p_office_id; -- 10
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
revoke all on function public.reset_test_office(uuid) from public, anon, authenticated;
grant execute on function public.reset_test_office(uuid) to service_role;
