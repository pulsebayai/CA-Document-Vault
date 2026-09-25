create index activity_actor_idx on public.activity (actor_id);
create index staff_user_invited_by_idx on public.staff_user (invited_by);
comment on table public.login_attempt is 'Sign-in lockout counters keyed by SHA-256(email). Intentionally no RLS policies: server (service role) access only.';
