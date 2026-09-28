-- Feature 02 step 6: "Used by N clients" on Settings › Document catalogue (spec UX flows).
-- security_invoker: the caller's RLS on client_doc_type/client applies, so a Limited user only
-- counts clients they can see. Counts active plan rows on non-archived clients.
create view public.doc_type_usage with (security_invoker = true) as
  select t.doc_type_id, count(distinct t.client_id)::integer as clients
    from public.client_doc_type t
    join public.client c on c.id = t.client_id
   where t.state = 'active' and c.archived_at is null
   group by t.doc_type_id;

revoke all on public.doc_type_usage from anon, authenticated;
grant select on public.doc_type_usage to authenticated;
