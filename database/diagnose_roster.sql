-- Read-only: table definitions and aggregate counts; no names, emails or user IDs.
select jsonb_build_object(
  'membership_counts', coalesce((select jsonb_agg(to_jsonb(t)) from (
    select batch_code,status,count(*) as students
    from public.batch_permissions group by batch_code,status order by batch_code,status
  ) t),'[]'::jsonb),
  'teacher_class_counts', coalesce((select jsonb_agg(to_jsonb(t)) from (
    select batch_code,count(*) as teachers from public.teacher_permissions
    group by batch_code order by batch_code
  ) t),'[]'::jsonb),
  'registered_accounts', (select count(*) from auth.users),
  'columns', coalesce((select jsonb_agg(to_jsonb(t)) from (
    select table_name,column_name,data_type,is_nullable,column_default
    from information_schema.columns where table_schema='public'
      and table_name in ('profiles','batch_permissions','teacher_permissions','tasks','task_notifications')
    order by table_name,ordinal_position
  ) t),'[]'::jsonb),
  'task_constraints', coalesce((select jsonb_agg(to_jsonb(t)) from (
    select conname,pg_get_constraintdef(oid) as definition from pg_constraint
    where conrelid='public.tasks'::regclass order by conname
  ) t),'[]'::jsonb)
) as roster_diagnostic;
