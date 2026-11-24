-- ADMINISTRATOR ONLY. Run after migration 002. Replace the email first.
-- Create/invite this account through Supabase Auth before granting teacher access.
-- This changes no password and sends no email by itself.
do $$
declare
  teacher_email text := 'REPLACE_WITH_TEACHER_EMAIL';
  approved_class text := '25cs';
  teacher_id uuid;
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
    raise exception 'Run this as a trusted database administrator';
  end if;
  if teacher_email = 'REPLACE_WITH_TEACHER_EMAIL' then raise exception 'Set the teacher email before running this script'; end if;
  select id into teacher_id from auth.users where lower(email)=lower(teacher_email);
  if teacher_id is null then raise exception 'Create or invite this teacher in Supabase Auth first'; end if;
  insert into public.teacher_permissions(user_id,batch_code,approved_by)
  values(teacher_id,approved_class,auth.uid()) on conflict(user_id,batch_code) do nothing;
end;
$$;
