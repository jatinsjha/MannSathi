-- ADMINISTRATOR ONLY. Reuses the existing batch_permissions table; no self-approval.
-- Replace the email with the student you explicitly intend to enroll in 25CS.
do $$
declare
  student_email text := 'REPLACE_WITH_STUDENT_EMAIL';
  student_id uuid;
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
    raise exception 'Run this as a trusted database administrator';
  end if;
  if student_email = 'REPLACE_WITH_STUDENT_EMAIL' then raise exception 'Set the student email before running this script'; end if;
  select id into student_id from auth.users where lower(email)=lower(student_email);
  if student_id is null then raise exception 'The student must sign up first'; end if;
  if exists(select 1 from public.teacher_permissions where user_id=student_id) then
    raise exception 'This account is a teacher, not a student';
  end if;
  insert into public.batch_permissions(user_id,batch_code,status,approved_by,approved_at)
  values(student_id,'25cs','approved',auth.uid(),now())
  on conflict(user_id) do update set batch_code=excluded.batch_code,status='approved',
    approved_by=excluded.approved_by,approved_at=excluded.approved_at;
end;
$$;
