-- 12-intake-review-fixes · migration D (pre-PR review N-6, decided by Sidambara 2026-10-31).
-- Since 12, Staff can undo a review (AC-24) but not a dispatch. A review is no longer undone while the document is
-- in a live dispatch packet (any role): undo the dispatch first. Copied from migration B; only the marked lines change.

create or replace function public.undo_review(p_id uuid, p_reason text)
returns void language plpgsql security invoker set search_path = '' as $$
declare d public.document; v_staff uuid := private.current_staff_id(); v_reason text := btrim(coalesce(p_reason, ''));
begin
  -- 12 (spec AC-24): Staff can undo a review too; Limited can't. Undoing a dispatch stays Admin/Manager.
  if not private.has_role(array['admin', 'manager', 'staff']::public.staff_role[]) then
    raise exception 'ROLE_REQUIRED: only Admin, Manager or Staff can undo a review' using errcode = '42501';
  end if;
  if length(v_reason) not between 1 and 500 then
    raise exception 'REASON_REQUIRED: give a reason of 1–500 characters' using errcode = '23514';
  end if;
  select * into d from public.document where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: document' using errcode = 'P0002'; end if;
  if d.archived_at is not null then raise exception 'ARCHIVED: unarchive the document before changing it' using errcode = 'P0001'; end if;
  if d.status = 'received' then raise exception 'NOT_REVIEWED: this document is still to review' using errcode = 'P0001'; end if;
  -- 12 D (pre-PR review N-6, decided 2026-10-31): not while it is in a live dispatch packet — undo the dispatch first.
  if exists (select 1 from public.dispatch_item i where i.document_id = p_id and i.removed_at is null) then
    raise exception 'DISPATCHED: undo the dispatch before undoing the review' using errcode = 'P0001';
  end if;
  perform private.begin_doc_write();
  perform set_config('app.doc_review', p_id::text, true);
  update public.document set status = 'received', reviewed_by = null, reviewed_at = null, correction_reason = null,
    correction_kind = null where id = p_id; -- 12
  insert into public.document_review (office_id, document_id, outcome, reason, actor_id)
    values (d.office_id, p_id, 'undone', v_reason, v_staff);
  perform set_config('app.doc_review', '', true);
  insert into public.activity (office_id, actor_id, action, entity_type, entity_id, data)
    values (d.office_id, v_staff, 'document.review_undone', 'document', p_id::text,
            jsonb_build_object('client_id', d.client_id, 'from', d.status));
end $$;
