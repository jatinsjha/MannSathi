-- Read-only. One result so the Supabase editor does not hide earlier result sets.
-- Run BEFORE approving a migration. Returns definitions, never student records.
select jsonb_build_object(
  'tables', coalesce((
    select jsonb_agg(to_jsonb(t)) from (
      select table_schema, table_name from information_schema.tables
      where table_schema = 'public' order by table_name
    ) t
  ), '[]'::jsonb),
  'columns', coalesce((
    select jsonb_agg(to_jsonb(t)) from (
      select table_name, column_name, data_type, is_nullable, column_default
      from information_schema.columns where table_schema = 'public'
        and table_name in ('profiles', 'batch_permissions', 'calendar_events')
      order by table_name, ordinal_position
    ) t
  ), '[]'::jsonb),
  'rls', coalesce((
    select jsonb_agg(to_jsonb(t)) from (
      select c.relname as table_name, c.relrowsecurity as rls_enabled,
             c.relforcerowsecurity as rls_forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in ('profiles', 'batch_permissions', 'calendar_events')
      order by c.relname
    ) t
  ), '[]'::jsonb),
  'policies', coalesce((
    select jsonb_agg(to_jsonb(t)) from (
      select tablename, policyname, permissive, roles, cmd, qual, with_check
      from pg_policies where schemaname = 'public' order by tablename, policyname
    ) t
  ), '[]'::jsonb),
  'grants', coalesce((
    select jsonb_agg(to_jsonb(t)) from (
      select table_name, grantee, privilege_type from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name in ('profiles', 'batch_permissions', 'calendar_events')
      order by table_name, grantee, privilege_type
    ) t
  ), '[]'::jsonb),
  'constraints', coalesce((
    select jsonb_agg(to_jsonb(t)) from (
      select conrelid::regclass::text as table_name, conname,
             pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid in (
        select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname in ('profiles', 'batch_permissions', 'calendar_events')
      ) order by table_name, conname
    ) t
  ), '[]'::jsonb),
  'triggers', coalesce((
    select jsonb_agg(to_jsonb(t)) from (
      select event_object_table, trigger_name, action_statement
      from information_schema.triggers where event_object_schema = 'public'
        and event_object_table in ('profiles', 'batch_permissions', 'calendar_events')
      order by event_object_table, trigger_name
    ) t
  ), '[]'::jsonb)
) as schema_review;
