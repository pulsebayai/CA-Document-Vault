-- Feature 18, leak L-1 (spec X8; found by tests/rls/cross-firm/sweep.test.ts "point Firm A's rows at Firm B's objects").
-- period_insert checked only the new row's office_id, so an Admin of Firm A could insert a period of Firm A whose
-- financial_year_id is Firm B's financial year (the foreign key doesn't know about firms). Nothing of Firm B was
-- readable or changed, but the period would join Firm A's data to Firm B's year. The policy now also requires the
-- financial year to be one the caller can see in their own office. Definer paths (seed, FY roll-over) are unchanged:
-- they always pass the office's own year.

-- alter (not drop + create): same policy name, roles and command; only the check changes.
alter policy period_insert on public.period
  with check (
    office_id = (select private.current_office_id())
    and (select private.has_role(array['admin'::public.staff_role]))
    and exists (select 1 from public.financial_year f
                 where f.id = financial_year_id and f.office_id = (select private.current_office_id()))
  );
