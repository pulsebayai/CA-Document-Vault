-- Feature 05 — migration C (plan step 8, AC-17): a merge links its moved documents per distinct
-- (client, period, registration) instead of per document.
-- Why: RUN_SLOW Regression measured the 1,000-document merge at 1,609 ms and 2,219 ms from CI (target < 2 s). A
-- profile on dev (rolled back) put link_moved at ~490 ms per 1,000 documents: 04's match_expected ran once per row.
-- The documents of a merge share few (client, period, registration) combinations (the profile: 2), so the rule is
-- now evaluated once per combination, with the same function (04's rule stays in one place), and the documents are
-- updated in one statement. Everything else in link_moved is unchanged: tenant first, archived documents and documents
-- without a client/type/period link to nothing, each touched item is recomputed once.
create or replace function private.link_moved(p_docs uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_office uuid := private.current_office_id();
  v_prev   text := coalesce(current_setting('app.doc_write', true), '');
  v_items  uuid[];
  i uuid;
begin
  if v_office is null then raise exception 'OFFICE_DENIED: no office' using errcode = '42501'; end if;
  perform set_config('app.doc_write', 'on', true);
  with docs as (
    select d.id, d.expected_doc_id as old_item, d.client_id, d.doc_type_id, d.period_id, d.registration_id,
           (d.archived_at is null and d.client_id is not null and d.doc_type_id is not null and d.period_id is not null) as linkable
      from public.document d where d.id = any (p_docs) and d.office_id = v_office
  ), combos as (
    select c.client_id, c.doc_type_id, c.period_id, c.registration_id,
           private.match_expected(v_office, c.client_id, c.doc_type_id, c.period_id, c.registration_id) as item
      from (select distinct client_id, doc_type_id, period_id, registration_id from docs where linkable) c
  ), x as (
    select d.id, d.old_item, case when d.linkable then m.item end as item
      from docs d
      left join combos m on d.linkable and m.client_id = d.client_id and m.doc_type_id = d.doc_type_id
                        and m.period_id = d.period_id and m.registration_id is not distinct from d.registration_id
  ), upd as (
    update public.document d set expected_doc_id = x.item
      from x where d.id = x.id and d.expected_doc_id is distinct from x.item
    returning x.item, x.old_item)
  select array_agg(distinct u) into v_items
    from (select item as u from upd union select old_item from upd) z where u is not null;
  perform set_config('app.doc_write', v_prev, true);
  foreach i in array coalesce(v_items, '{}') loop
    perform private.recompute_expected(i, null);
  end loop;
end $$;
-- Grants unchanged (create or replace keeps them).
