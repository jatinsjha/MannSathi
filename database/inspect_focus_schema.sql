-- Read-only definitions/policies; no student records are selected.
select jsonb_build_object(
  'tables',coalesce((select jsonb_agg(jsonb_build_object('table_name',c.relname,'rls_enabled',c.relrowsecurity,'rls_forced',c.relforcerowsecurity))
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in ('study_subjects','focus_preferences','focus_sessions','focus_segments')),'[]'::jsonb),
  'columns',coalesce((select jsonb_agg(to_jsonb(c)) from information_schema.columns c
    where table_schema='public' and table_name in ('study_subjects','focus_preferences','focus_sessions','focus_segments')),'[]'::jsonb),
  'constraints',coalesce((select jsonb_agg(jsonb_build_object('table_name',r.relname,'name',c.conname,'definition',pg_get_constraintdef(c.oid)))
    from pg_catalog.pg_constraint c join pg_catalog.pg_class r on r.oid=c.conrelid join pg_catalog.pg_namespace n on n.oid=r.relnamespace
    where n.nspname='public' and r.relname in ('study_subjects','focus_preferences','focus_sessions','focus_segments')),'[]'::jsonb),
  'policies',coalesce((select jsonb_agg(to_jsonb(p)) from pg_catalog.pg_policies p where schemaname='public'
    and tablename in ('study_subjects','focus_preferences','focus_sessions','focus_segments')),'[]'::jsonb),
  'functions',coalesce((select jsonb_agg(jsonb_build_object('name',p.proname,'signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid)))
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and left(p.proname,16)='mannsathi_focus_'),'[]'::jsonb)
) as focus_schema_review;
