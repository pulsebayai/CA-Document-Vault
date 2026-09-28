-- Feature 03 step 2 — advisor fixes (performance): one INSERT policy on doc_type instead of two permissive
-- ones, and current_setting() wrapped in a sub-select (evaluated once per statement). Same behaviour:
-- Admin/Manager insert catalogue types; Staff+ insert proposed types only inside create_proposed_type.
drop policy doc_type_insert on public.doc_type;
drop policy doc_type_insert_proposed on public.doc_type;
create policy doc_type_insert on public.doc_type for insert to authenticated
  with check (office_id = (select private.current_office_id())
              and ((select private.has_role(array['admin', 'manager']::public.staff_role[]))
                   or (status = 'proposed'
                       and (select private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]))
                       and (select coalesce(current_setting('app.propose_type', true), '')) = 'on')));
