-- PROPOSED smallest privilege fix based on the supplied live schema review.
-- profiles has owner-only SELECT/UPDATE RLS but broad anon/authenticated grants.
-- TRUNCATE is not covered by PostgreSQL RLS. This does not change profile columns,
-- existing owner policies, Supabase Auth, or batch_permissions.
-- Review and approve before applying; this script is not run automatically.
begin;
revoke all on public.profiles from anon;
revoke truncate, references, trigger on public.profiles from authenticated;
commit;
