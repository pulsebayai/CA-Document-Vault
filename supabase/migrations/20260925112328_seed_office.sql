-- Seed the single office for v1 (idempotent). First Admin is linked in 20260925120200 after the auth invite.
insert into public.office (name, branch)
select 'Kushal Associates', 'Pondicherry'
where not exists (select 1 from public.office);
