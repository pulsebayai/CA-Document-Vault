-- Feature 03 step 2 — advisor fix: the linter recognises only (select current_setting(...)) as evaluated once.
alter policy doc_type_insert on public.doc_type
  with check (office_id = (select private.current_office_id())
              and ((select private.has_role(array['admin', 'manager']::public.staff_role[]))
                   or (status = 'proposed'
                       and (select private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]))
                       and coalesce((select current_setting('app.propose_type', true)), '') = 'on')));
