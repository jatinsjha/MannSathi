-- Read-only deployment inventory. No student or credential values are selected.
select current_user, current_database(), now() as inspected_at;

select objects.name, to_regclass('public.' || objects.name) is not null as present
from (values ('profiles'),('batch_permissions'),('teacher_permissions'),('calendar_events'),
  ('tasks'),('study_subjects'),('calendar_exams'),('ai_admins'),('ai_global_policy'),('ai_student_policies'),
  ('ai_usage'),('ai_daily_counters'),('ai_model_pricing'),('ai_audit'),('ai_student_directory'),
  ('ai_quota_snapshots'),('ai_billing_snapshots')) as objects(name);

select table_schema,table_name,column_name,data_type from information_schema.columns
where (table_schema='auth' and table_name='users' and column_name in ('id','email','raw_user_meta_data','is_anonymous'))
   or (table_schema='public' and table_name in ('profiles','batch_permissions','teacher_permissions'))
order by table_schema,table_name,ordinal_position;

select c.relname as relation,c.relrowsecurity as rls,c.relforcerowsecurity as force_rls,
  has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') as anonymous_access,
  has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') as signed_in_access
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname like 'ai\_%' escape '\' and c.relkind in ('r','v')
order by c.relname;

select p.oid::regprocedure as rpc,has_function_privilege('anon',p.oid,'EXECUTE') as anonymous_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as signed_in_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname like 'mannsathi\_ai\_%' escape '\'
order by p.proname;
