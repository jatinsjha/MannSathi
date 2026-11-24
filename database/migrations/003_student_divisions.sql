-- PROPOSED migration after 002. Student details are editable; class/division access
-- becomes authoritative only after a permitted teacher reviews the request.
-- Existing approved whole-class members keep access even without a division.
begin;
do $$
begin
  if not exists(select 1 from pg_catalog.pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
    raise exception 'Run this migration as the trusted Supabase SQL editor administrator';
  end if;
end;
$$;

alter table public.profiles add column roll_number text check (roll_number is null or char_length(roll_number) between 1 and 30);
alter table public.profiles add column class_code text check (class_code is null or class_code='25cs');
alter table public.profiles add column division text check (division is null or division in ('A','B','C'));
alter table public.batch_permissions add column division text check (division is null or division in ('A','B','C'));
alter table public.tasks add column target_division text check (target_division is null or target_division in ('A','B','C'));
alter table public.task_notifications add column target_division text check (target_division is null or target_division in ('A','B','C'));

alter table public.tasks drop constraint tasks_audience_check;
alter table public.tasks add constraint tasks_audience_check check (audience in ('personal','student','class','division'));
alter table public.tasks drop constraint task_audience_shape;
alter table public.tasks add constraint task_audience_shape check (
  (audience='personal' and assigned_to is not null and assigned_to=created_by and batch_id is null and target_division is null)
  or (audience='student' and assigned_to is not null and batch_id is not null and target_division is null)
  or (audience='class' and assigned_to is null and batch_id is not null and target_division is null)
  or (audience='division' and assigned_to is null and batch_id is not null and target_division is not null)
);
create index batch_permissions_class_division on public.batch_permissions(batch_code,division,status);
create index tasks_class_division on public.tasks(batch_id,target_division) where audience='division';

-- Settings writes use one validated RPC so a changed requested division cannot
-- silently retain an old approval. This grants no role or membership authority.
revoke insert, update on public.profiles from authenticated;

create function public.mannsathi_task_settings()
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_uid uuid:=auth.uid(); v_profile jsonb; v_membership jsonb; v_teacher boolean;
begin
  if v_uid is null then raise exception 'Sign in to read settings' using errcode='PT401'; end if;
  select exists(select 1 from public.teacher_permissions where user_id=v_uid) into v_teacher;
  select jsonb_build_object('full_name',coalesce(nullif(p.full_name,''),nullif(u.raw_user_meta_data->>'full_name',''),''),
    'roll_number',coalesce(p.roll_number,''),'class_code',coalesce(p.class_code,b.batch_code),
    'division',coalesce(p.division,b.division)) into v_profile
    from auth.users u left join public.profiles p on p.id=u.id
    left join public.batch_permissions b on b.user_id=u.id where u.id=v_uid;
  if v_profile is null then raise exception 'Account unavailable' using errcode='PT401'; end if;
  select jsonb_build_object('batch_id',batch_code,'division',division,'status',status)
    into v_membership from public.batch_permissions where user_id=v_uid;
  return jsonb_build_object('role',case when v_teacher then 'teacher' else 'student' end,
    'profile',v_profile,'membership',v_membership,
    'classes',jsonb_build_array(jsonb_build_object('id','25cs','label','25CS','divisions',jsonb_build_array('A','B','C'))));
end;
$$;

create function public.mannsathi_task_save_settings(p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$
declare
  v_uid uuid:=auth.uid(); v_name text; v_roll text; v_class text; v_division text;
  v_member public.batch_permissions%rowtype;
begin
  if v_uid is null then raise exception 'Sign in to save settings' using errcode='PT401'; end if;
  if exists(select 1 from public.teacher_permissions where user_id=v_uid) then
    raise exception 'Student settings are available only to students' using errcode='PT403';
  end if;
  if p_data is null or jsonb_typeof(p_data)<>'object' or exists(
    select 1 from jsonb_object_keys(p_data) k where k not in ('full_name','roll_number','class_code','division')
  ) then raise exception 'Unsupported settings fields' using errcode='PT400'; end if;
  if jsonb_typeof(p_data->'full_name') is distinct from 'string'
    or jsonb_typeof(p_data->'roll_number') is distinct from 'string'
    or jsonb_typeof(p_data->'class_code') is distinct from 'string'
    or jsonb_typeof(p_data->'division') is distinct from 'string' then
    raise exception 'Complete all student settings fields' using errcode='PT400';
  end if;
  v_name:=btrim(p_data->>'full_name'); v_roll:=btrim(p_data->>'roll_number');
  v_class:=lower(btrim(p_data->>'class_code')); v_division:=upper(btrim(p_data->>'division'));
  if char_length(v_name) not between 2 and 100 or char_length(v_roll) not between 1 and 30
    or v_roll !~ '^[A-Za-z0-9][A-Za-z0-9 /_-]{0,29}$' or v_class<>'25cs' or v_division not in ('A','B','C') then
    raise exception 'Choose valid student details, class and division' using errcode='PT400';
  end if;
  -- Lock membership before changing either settings or approval state.
  select * into v_member from public.batch_permissions where user_id=v_uid for update;
  insert into public.profiles(id,full_name,roll_number,class_code,division,updated_at)
    values(v_uid,v_name,v_roll,v_class,v_division,now())
    on conflict(id) do update set full_name=excluded.full_name,roll_number=excluded.roll_number,
      class_code=excluded.class_code,division=excluded.division,updated_at=now();
  if v_member.user_id is null then
    insert into public.batch_permissions(user_id,batch_code,division,status)
      values(v_uid,v_class,v_division,'pending');
  elsif v_member.batch_code is distinct from v_class or v_member.division is distinct from v_division or v_member.status='rejected' then
    update public.batch_permissions set batch_code=v_class,division=v_division,status='pending',
      approved_by=null,approved_at=null where user_id=v_uid;
  end if;
  return public.mannsathi_task_settings();
end;
$$;

create function public.mannsathi_task_pending_enrollments()
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_uid uuid:=auth.uid(); v_requests jsonb;
begin
  if v_uid is null then raise exception 'Sign in to review enrollments' using errcode='PT401'; end if;
  if not exists(select 1 from public.teacher_permissions where user_id=v_uid) then
    raise exception 'Teacher access is required' using errcode='PT403';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('user_id',b.user_id,'batch_id',b.batch_code,
    'division',b.division,'full_name',coalesce(nullif(p.full_name,''),nullif(u.raw_user_meta_data->>'full_name',''),'Student'),
    'roll_number',coalesce(p.roll_number,''),'email',u.email,'status',b.status) order by b.created_at,b.user_id),'[]'::jsonb)
    into v_requests from public.batch_permissions b join auth.users u on u.id=b.user_id
    left join public.profiles p on p.id=b.user_id
    where b.status='pending' and public.mannsathi_task_teacher(v_uid,b.batch_code)
      and not exists(select 1 from public.teacher_permissions t where t.user_id=b.user_id);
  return v_requests;
end;
$$;

create function public.mannsathi_task_approve_enrollment(p_user uuid,p_batch text,p_approve boolean,p_expected_division text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v_uid uuid:=auth.uid(); v_member public.batch_permissions%rowtype; v_status text;
begin
  if v_uid is null then raise exception 'Sign in to review enrollments' using errcode='PT401'; end if;
  if p_user is null or p_batch is null or p_approve is null then
    raise exception 'Choose a valid enrollment decision' using errcode='PT400'; end if;
  if p_expected_division is not null and p_expected_division not in ('A','B','C') then
    raise exception 'Choose a valid reviewed division' using errcode='PT400'; end if;
  if not public.mannsathi_task_teacher(v_uid,p_batch) then
    raise exception 'Teacher access to this class is required' using errcode='PT403'; end if;
  if exists(select 1 from public.teacher_permissions where user_id=p_user) then
    raise exception 'Teacher accounts cannot be enrolled as students' using errcode='PT403'; end if;
  select * into v_member from public.batch_permissions where user_id=p_user and batch_code=p_batch for update;
  if not found then raise exception 'Enrollment request unavailable' using errcode='PT404'; end if;
  if v_member.division is distinct from p_expected_division then
    raise exception 'Enrollment request changed. Refresh before reviewing.' using errcode='PT409';
  end if;
  v_status:=case when p_approve then 'approved' else 'rejected' end;
  if v_member.status=v_status then return jsonb_build_object('updated',true,'status',v_status); end if;
  if v_member.status<>'pending' then raise exception 'Enrollment decision has changed; refresh before reviewing' using errcode='PT409'; end if;
  update public.batch_permissions set status=v_status,approved_by=v_uid,
    approved_at=case when p_approve then now() else null end where user_id=p_user and batch_code=p_batch;
  return jsonb_build_object('updated',true,'status',v_status);
end;
$$;

create or replace function public.mannsathi_task_can_read(p_id uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public
as $$
  select auth.uid() is not null and exists(
    select 1 from public.tasks t where t.id=p_id and (
      (t.audience='personal' and t.created_by=auth.uid())
      or (t.audience<>'personal' and t.created_by=auth.uid() and public.mannsathi_task_teacher(auth.uid(),t.batch_id))
      or (t.audience<>'personal' and public.mannsathi_task_student_member(auth.uid(),t.batch_id)
        and (t.audience<>'division' or exists(select 1 from public.batch_permissions b
          where b.user_id=auth.uid() and b.batch_code=t.batch_id and b.status='approved' and b.division=t.target_division))
        and exists(select 1 from public.task_recipients r where r.task_id=t.id and r.user_id=auth.uid()))
    )
  )
$$;

create or replace function public.mannsathi_task_can_read_notification(p_id uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public
as $$
  select auth.uid() is not null and exists(
    select 1 from public.task_notifications n where n.id=p_id and n.user_id=auth.uid()
      and public.mannsathi_task_student_member(auth.uid(),n.batch_id)
      and (n.target_division is null or exists(select 1 from public.batch_permissions b
        where b.user_id=auth.uid() and b.batch_code=n.batch_id and b.status='approved' and b.division=n.target_division))
      and (n.task_id is null or public.mannsathi_task_can_read(n.task_id))
  )
$$;

create or replace function public.mannsathi_task_context()
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_uid uuid:=auth.uid(); v_teacher boolean; v_batches jsonb; v_students jsonb;
begin
  if v_uid is null then raise exception 'Sign in to use tasks' using errcode='PT401'; end if;
  select exists(select 1 from public.teacher_permissions where user_id=v_uid) into v_teacher;
  if v_teacher then
    select coalesce(jsonb_agg(jsonb_build_object('id',t.batch_code,'label',upper(t.batch_code),
      'student_count',(select count(*) from public.batch_permissions b where b.batch_code=t.batch_code and public.mannsathi_task_student_member(b.user_id,b.batch_code)),
      'pending_count',(select count(*) from public.batch_permissions b where b.batch_code=t.batch_code and b.status='pending'
        and not exists(select 1 from public.teacher_permissions x where x.user_id=b.user_id)),
      'divisions',(select jsonb_agg(jsonb_build_object('id',d.code,'label','Division '||d.code,
        'student_count',(select count(*) from public.batch_permissions b where b.batch_code=t.batch_code and b.division=d.code
          and public.mannsathi_task_student_member(b.user_id,b.batch_code))) order by d.code) from (values('A'),('B'),('C')) d(code))
    ) order by t.batch_code),'[]'::jsonb) into v_batches from public.teacher_permissions t where t.user_id=v_uid;
    select coalesce(jsonb_agg(jsonb_build_object('id',b.user_id,'batch_id',b.batch_code,'division',b.division,
      'roll_number',coalesce(p.roll_number,''),
      'full_name',coalesce(nullif(p.full_name,''),nullif(u.raw_user_meta_data->>'full_name',''),'Student'))
      order by b.division,p.roll_number,b.user_id),'[]'::jsonb) into v_students
      from public.batch_permissions b join auth.users u on u.id=b.user_id left join public.profiles p on p.id=b.user_id
      where public.mannsathi_task_teacher(v_uid,b.batch_code) and public.mannsathi_task_student_member(b.user_id,b.batch_code);
  else
    select coalesce(jsonb_agg(jsonb_build_object('id',batch_code,'label',upper(batch_code)) order by batch_code),'[]'::jsonb)
      into v_batches from public.batch_permissions where user_id=v_uid and status='approved';
    v_students:='[]'::jsonb;
  end if;
  return jsonb_build_object('role',case when v_teacher then 'teacher' else 'student' end,
    'user_id',v_uid,'batches',v_batches,'students',v_students);
end;
$$;

create or replace function public.mannsathi_task_create(p_request_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$
declare
  v_uid uuid:=auth.uid(); v_id uuid; v_audience text; v_batch text; v_target uuid; v_division text;
  v_status text; v_fields jsonb; v_name text; v_count integer;
begin
  if v_uid is null then raise exception 'Sign in to use tasks' using errcode='PT401'; end if;
  if p_request_id is null or p_data is null or jsonb_typeof(p_data)<>'object' or exists(
    select 1 from jsonb_object_keys(p_data) k where k not in
      ('title','description','subject','task_type','due_at','estimated_minutes','priority','audience','batch_id','assigned_to','status','target_division')
  ) then raise exception 'Unsupported task fields' using errcode='PT400'; end if;
  v_fields:=public.mannsathi_task_fields(p_data-array['audience','batch_id','assigned_to','status','target_division']);
  v_audience:=coalesce(p_data->>'audience','personal'); v_status:=coalesce(p_data->>'status','pending');
  if v_audience not in ('personal','student','class','division') or v_status not in ('pending','in_progress','completed') then
    raise exception 'Invalid task audience or status' using errcode='PT400'; end if;
  if v_audience='division' then
    v_division:=p_data->>'target_division';
    if v_division is null or v_division not in ('A','B','C') then
      raise exception 'Choose a valid division' using errcode='PT400'; end if;
  elsif p_data->'target_division' is not null and p_data->'target_division'<>'null'::jsonb then
    raise exception 'A division can be targeted only with division audience' using errcode='PT400';
  end if;
  if v_audience='personal' then
    if p_data->'batch_id' is not null and p_data->'batch_id'<>'null'::jsonb then
      raise exception 'Personal tasks cannot target a class' using errcode='PT400'; end if;
    if p_data->'assigned_to' is not null and p_data->'assigned_to'<>'null'::jsonb then
      raise exception 'Personal task ownership is assigned by the server' using errcode='PT400'; end if;
    v_target:=v_uid;
  else
    v_batch:=p_data->>'batch_id';
    if v_batch is null or char_length(v_batch) not between 1 and 80 or not public.mannsathi_task_teacher(v_uid,v_batch) then
      raise exception 'Teacher access to this class is required' using errcode='PT403'; end if;
    if v_status<>'pending' then raise exception 'New assignments start as pending' using errcode='PT400'; end if;
    if v_audience='student' then
      begin v_target:=(p_data->>'assigned_to')::uuid;
      exception when others then raise exception 'Choose a valid student' using errcode='PT400'; end;
      if v_target is null or not public.mannsathi_task_student_member(v_target,v_batch) then
        raise exception 'Choose an approved student in your class' using errcode='PT403'; end if;
    elsif p_data->'assigned_to' is not null and p_data->'assigned_to'<>'null'::jsonb then
      raise exception 'Group assignments cannot also target one student' using errcode='PT400';
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text||p_request_id::text,0));
  select id into v_id from public.tasks where created_by=v_uid and request_id=p_request_id;
  if v_id is not null then
    if not public.mannsathi_task_can_read(v_id) then raise exception 'Task access was revoked' using errcode='PT403'; end if;
    return public.mannsathi_task_projection(v_id);
  end if;
  insert into public.tasks(request_id,created_by,assigned_to,batch_id,audience,target_division,title,description,subject,task_type,due_at,estimated_minutes,priority,status,completed_at)
    values(p_request_id,v_uid,v_target,v_batch,v_audience,v_division,v_fields->>'title',v_fields->>'description',v_fields->>'subject',v_fields->>'task_type',
      (v_fields->>'due_at')::timestamptz,(v_fields->>'estimated_minutes')::integer,v_fields->>'priority',v_status,
      case when v_status='completed' then now() else null end) returning id into v_id;
  if v_audience<>'personal' then
    insert into public.task_recipients(task_id,user_id)
      select v_id,b.user_id from public.batch_permissions b where b.batch_code=v_batch
        and public.mannsathi_task_student_member(b.user_id,v_batch)
        and (v_audience<>'student' or b.user_id=v_target)
        and (v_audience<>'division' or b.division=v_division);
    get diagnostics v_count=row_count;
    if v_count=0 then
      if v_audience='division' then
        raise exception 'No approved students are enrolled in this division.' using errcode='PT422';
      else
        raise exception 'No approved students are enrolled in this class.' using errcode='PT422';
      end if;
    end if;
    select left(coalesce(nullif(p.full_name,''),nullif(u.raw_user_meta_data->>'full_name',''),'Your teacher'),120)
      into v_name from auth.users u left join public.profiles p on p.id=u.id where u.id=v_uid;
    insert into public.task_notifications(user_id,task_id,batch_id,target_division,title,message)
      select user_id,v_id,v_batch,v_division,'New work assigned',v_name||' assigned you: '||(v_fields->>'title')
      from public.task_recipients where task_id=v_id;
  end if;
  return public.mannsathi_task_projection(v_id);
end;
$$;

revoke all on function public.mannsathi_task_settings(),public.mannsathi_task_save_settings(jsonb),
  public.mannsathi_task_pending_enrollments(),public.mannsathi_task_approve_enrollment(uuid,text,boolean,text)
  from public,anon,authenticated;
grant execute on function public.mannsathi_task_settings(),public.mannsathi_task_save_settings(jsonb),
  public.mannsathi_task_pending_enrollments(),public.mannsathi_task_approve_enrollment(uuid,text,boolean,text)
  to authenticated;

comment on column public.profiles.class_code is 'Student-requested class; authoritative access comes from approved batch_permissions.';
comment on column public.profiles.division is 'Student-requested division; changing it through settings requests teacher review.';
comment on column public.batch_permissions.division is 'Approved division when status is approved; pending requested division otherwise. NULL legacy members receive whole-class tasks only.';
comment on column public.task_notifications.target_division is 'Retains division scope after task deletion, so reclassified students cannot read former-division notices.';
notify pgrst,'reload schema';
commit;
