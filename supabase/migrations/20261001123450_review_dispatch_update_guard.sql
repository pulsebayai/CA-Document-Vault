-- Feature 07 — fix to migration B (plan step 2; tests: "review history … append-only" in review-dispatch.test.ts).
-- private.review_dispatch_before_update read new.dispatch_id in one condition with tg_table_name, and plpgsql
-- resolves every field of the expression, so an update of document_review failed with "record new has no field
-- dispatch_id" instead of IMMUTABLE. The rows were still protected; only the error was wrong. Same rule, nested.
create or replace function private.review_dispatch_before_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'dispatch_item' then
    if (new.id, new.office_id, new.dispatch_id, new.document_id) = (old.id, old.office_id, old.dispatch_id, old.document_id)
       and old.removed_at is null and new.removed_at is not null
       and (current_user not in ('authenticated', 'anon') or coalesce(current_setting('app.dispatch_write', true), '') = 'on') then
      return new;
    end if;
  end if;
  raise exception 'IMMUTABLE: % rows are append-only', tg_table_name using errcode = 'P0001';
end $$;
revoke all on function private.review_dispatch_before_update() from public, anon, authenticated;
