-- Feature 10 step 12 — Settings › Collection link figures (spec AC-23). Admin/Manager only (as 04's
-- collection_metric); SECURITY INVOKER, so RLS applies too. Window = documents / items by their IST date.
--   documents, via_link, link_pct           share of filed documents added in the window that came through a link
--   reviewed, review_median_hours           link uploads first reviewed (Reviewed or Needs correction): median hours
--                                           from upload to that first review
--   needs_fix, needs_fix_pct                link uploads ever marked Needs correction, or re-filed under another
--                                           client or type than their item's
--   adhoc_received, adhoc_median_days,      ad-hoc items received in the window: median days request → received;
--   adhoc_with_date, adhoc_on_time(_pct)    of those with a needed-by date, the share received by it
-- Ad-hoc items never touch metric 1 (collection_metric is unchanged, AC-22).

create or replace function public.link_metric(p_from date, p_to date)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_office uuid := private.current_office_id(); v jsonb;
begin
  if not private.has_role(array['admin', 'manager']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: only Admin or Manager can see the collection figures' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'BAD_WINDOW: from must be on or before to' using errcode = '22023';
  end if;
  with docs as (
    select d.id, d.channel, d.created_at, d.client_id, d.doc_type_id, d.upload_request_item_id
      from public.document d
     where d.office_id = v_office and d.classified_at is not null and d.archived_at is null
       and (d.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to
  ), links as (
    select k.*,
           (select min(r.created_at) from public.document_review r
             where r.document_id = k.id and r.outcome in ('reviewed', 'needs_correction')) as first_review,
           exists (select 1 from public.document_review r where r.document_id = k.id and r.outcome = 'needs_correction') as fixed,
           (q.client_id is distinct from k.client_id or coalesce(e.doc_type_id, i.doc_type_id) is distinct from k.doc_type_id) as refiled
      from docs k
      left join public.upload_request_item i on i.id = k.upload_request_item_id
      left join public.upload_request q on q.id = i.request_id
      left join public.expected_doc e on e.id = i.expected_doc_id
     where k.channel = 'upload_link'
  ), asks as (
    select i.received_on, (i.created_at at time zone 'Asia/Kolkata')::date as asked_on, i.needed_by
      from public.upload_request_item i
     where i.office_id = v_office and i.kind = 'ad_hoc' and i.status = 'received'
       and i.received_on between p_from and p_to
  )
  select jsonb_build_object(
    'documents', (select count(*) from docs),
    'via_link', (select count(*) from links),
    'link_pct', (select case when count(*) = 0 then null
                             else round(100.0 * count(*) filter (where channel = 'upload_link') / count(*), 1) end from docs),
    'reviewed', (select count(*) from links where first_review is not null),
    'review_median_hours', (select round((percentile_cont(0.5) within group (
                               order by extract(epoch from first_review - created_at) / 3600.0))::numeric, 1)
                              from links where first_review is not null),
    'needs_fix', (select count(*) from links where fixed or refiled),
    'needs_fix_pct', (select case when count(*) = 0 then null
                                  else round(100.0 * count(*) filter (where fixed or refiled) / count(*), 1) end from links),
    'adhoc_received', (select count(*) from asks),
    'adhoc_median_days', (select percentile_cont(0.5) within group (order by received_on - asked_on) from asks),
    'adhoc_with_date', (select count(*) from asks where needed_by is not null),
    'adhoc_on_time', (select count(*) from asks where needed_by is not null and received_on <= needed_by),
    'adhoc_on_time_pct', (select case when count(*) filter (where needed_by is not null) = 0 then null
                                      else round(100.0 * count(*) filter (where needed_by is not null and received_on <= needed_by)
                                                 / count(*) filter (where needed_by is not null), 1) end from asks))
    into v;
  return v;
end $$;
revoke all on function public.link_metric(date, date) from public, anon;
grant execute on function public.link_metric(date, date) to authenticated;
