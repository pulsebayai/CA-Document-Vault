-- Feature 10 — Client upload links, migration A: schema (spec: sdlc/features/10-client-upload-links/spec.md,
-- "Data model changes"; plan step 1). Schema + architecture lock: 10 (Raja 2026-10-25).
-- Tests written first: tests/rls/upload-links.test.ts (schema part).
--
-- Sections
--   1. Enum values and types
--   2. upload_request, upload_request_item, document.upload_request_item_id, link_attempt
--   3. Guards: changes only inside 10's functions (app.upload_write); delete only in the test purge
--   4. RLS: select iff the user can see the client; token_hash never readable by app roles; link_attempt service-only
--   5. reset_test_office covers the new tables
--
-- Writes come in migration B (staff functions) and C (public, service-role-only functions).

-- ── 1 ─────────────────────────────────────────────────────────────────────
alter type public.doc_channel add value if not exists 'upload_link';
alter type public.notification_kind add value if not exists 'link_upload';
create type public.upload_item_kind as enum ('scheduled', 'ad_hoc');
create type public.upload_item_status as enum ('open', 'received', 'cancelled');
create type public.link_attempt_kind as enum ('lookup_failed', 'ticket');

-- ── 2 ─────────────────────────────────────────────────────────────────────
create table public.upload_request (
  id           uuid primary key default gen_random_uuid(),
  office_id    uuid not null references public.office (id),
  client_id    uuid not null references public.client (id) on delete cascade,  -- test purge only
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),     -- SHA-256 of the 32-byte token
  created_by   uuid not null references public.staff_user (id),               -- the requester (D1)
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  revoked_by   uuid references public.staff_user (id),
  replaced_by  uuid references public.upload_request (id),
  follow_up_id uuid references public.follow_up (id) on delete set null,       -- the reminder that carried the link
  max_files    integer not null default 30 check (max_files between 1 and 100),            -- D5
  max_bytes    bigint  not null default 314572800 check (max_bytes between 1 and 1073741824), -- 300 MB (D5)
  files_count  integer not null default 0 check (files_count >= 0),
  bytes_total  bigint  not null default 0 check (bytes_total >= 0),
  constraint upload_request_expiry check (expires_at > created_at),
  constraint upload_request_revoked check ((revoked_at is null) = (revoked_by is null))
);
create index upload_request_client_idx on public.upload_request (client_id, created_at desc);
create index upload_request_created_by_idx on public.upload_request (created_by);
create index upload_request_office_idx on public.upload_request (office_id);
create index upload_request_follow_up_idx on public.upload_request (follow_up_id) where follow_up_id is not null;

create table public.upload_request_item (
  id              uuid primary key default gen_random_uuid(),
  office_id       uuid not null references public.office (id),
  request_id      uuid not null references public.upload_request (id) on delete cascade,
  kind            public.upload_item_kind not null,
  expected_doc_id uuid references public.expected_doc (id) on delete cascade,       -- scheduled; test purge only
  doc_type_id     uuid references public.doc_type (id),                              -- ad-hoc
  period_id       uuid references public.period (id),
  registration_id uuid references public.client_registration (id) on delete cascade,
  needed_by       date,
  note            text check (note is null or length(btrim(note)) between 1 and 200),
  status          public.upload_item_status not null default 'open',
  received_on     date,
  cancel_reason   text check (cancel_reason is null or length(btrim(cancel_reason)) between 1 and 300),
  cancelled_by    uuid references public.staff_user (id),
  cancelled_at    timestamptz,
  created_at      timestamptz not null default now(),
  constraint upload_request_item_kind check (
       (kind = 'scheduled' and expected_doc_id is not null and doc_type_id is null and period_id is null
        and registration_id is null and needed_by is null and note is null)
    or (kind = 'ad_hoc' and expected_doc_id is null and doc_type_id is not null)),
  constraint upload_request_item_cancel check (
    (status = 'cancelled') = (cancelled_at is not null and cancelled_by is not null and cancel_reason is not null)),
  constraint upload_request_item_received check ((status = 'received') = (received_on is not null) or kind = 'scheduled'),
  unique (request_id, expected_doc_id)
);
create index upload_request_item_request_idx on public.upload_request_item (request_id);
create index upload_request_item_expected_idx on public.upload_request_item (expected_doc_id) where expected_doc_id is not null;
create index upload_request_item_office_open_idx on public.upload_request_item (office_id, status) where kind = 'ad_hoc';
create index upload_request_item_doc_type_idx on public.upload_request_item (doc_type_id) where doc_type_id is not null;
create index upload_request_item_period_idx on public.upload_request_item (period_id) where period_id is not null;
create index upload_request_item_registration_idx on public.upload_request_item (registration_id) where registration_id is not null;
create index upload_request_item_cancelled_by_idx on public.upload_request_item (cancelled_by) where cancelled_by is not null;

-- The item a link upload (or a Requested-row filing) belongs to. Set only by 10's functions.
alter table public.document add column upload_request_item_id uuid references public.upload_request_item (id);
create index document_upload_request_item_idx on public.document (upload_request_item_id) where upload_request_item_id is not null;

-- Throttle log (AC-9). office_id is null for a failed lookup of an unknown token: there is no office to name.
-- A deliberate exception to "office_id on every business table" (like test_lane): service-role only, kept 7 days.
create table public.link_attempt (
  id         bigint generated always as identity primary key,
  office_id  uuid references public.office (id),
  request_id uuid references public.upload_request (id) on delete cascade,
  ip_hash    text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  kind       public.link_attempt_kind not null,
  at         timestamptz not null default now()
);
create index link_attempt_ip_idx on public.link_attempt (ip_hash, at desc);
create index link_attempt_request_idx on public.link_attempt (request_id, at desc) where request_id is not null;
create index link_attempt_office_idx on public.link_attempt (office_id) where office_id is not null;

-- ── 3 ─────────────────────────────────────────────────────────────────────
-- Requests and items change only inside 10's functions (they set app.upload_write = 'on'), for every role
-- including the service role. Deletes happen only in the test purge (02's helper).
create or replace function private.upload_change_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('app.upload_write', true), '') <> 'on'
     and coalesce(current_setting('app.purge_office', true), '') = '' then
    raise exception 'IMMUTABLE: % rows change only through upload-link functions', tg_table_name using errcode = 'P0001';
  end if;
  if (new.id, new.office_id) is distinct from (old.id, old.office_id) then
    raise exception 'IMMUTABLE: id and office cannot change' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger upload_request_guard before update on public.upload_request
  for each row execute function private.upload_change_guard();
create trigger upload_request_item_guard before update on public.upload_request_item
  for each row execute function private.upload_change_guard();
create trigger upload_request_no_delete before delete on public.upload_request
  for each row execute function private.forbid_delete_unless_purge();
create trigger upload_request_item_no_delete before delete on public.upload_request_item
  for each row execute function private.forbid_delete_unless_purge();

-- ── 4 ─────────────────────────────────────────────────────────────────────
alter table public.upload_request enable row level security;
alter table public.upload_request_item enable row level security;
alter table public.link_attempt enable row level security;  -- no policies: service role only

create policy upload_request_select on public.upload_request for select to authenticated
  using (office_id = (select private.current_office_id()) and private.can_see_client(client_id));
create policy upload_request_item_select on public.upload_request_item for select to authenticated
  using (office_id = (select private.current_office_id())
         and exists (select 1 from public.upload_request r where r.id = request_id));

revoke all on public.upload_request, public.upload_request_item, public.link_attempt from anon, authenticated;
-- Column grant: everything except token_hash. The hash never leaves the database to an app role.
grant select (id, office_id, client_id, created_by, created_at, expires_at, revoked_at, revoked_by, replaced_by,
              follow_up_id, max_files, max_bytes, files_count, bytes_total)
  on public.upload_request to authenticated;
grant select on public.upload_request_item to authenticated;

-- ── 5 ─────────────────────────────────────────────────────────────────────
-- 05's body plus 10's tables (first lines). Documents point at items, so that link is cleared first.
create or replace function public.reset_test_office(p_office_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.office where id = p_office_id and is_test) then
    raise exception 'NOT_TEST_OFFICE: only offices flagged is_test can be reset' using errcode = '42501';
  end if;
  perform set_config('app.purge_office', p_office_id::text, true);
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
