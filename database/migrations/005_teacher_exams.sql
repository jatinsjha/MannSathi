-- Proposed after 001, 002 and 003. Applies no changes to personal calendar events.
-- Scheduled class exams follow current approved class/division membership.
begin;

create table public.calendar_exams (
  like public.calendar_events including defaults including constraints,
  audience text not null check (audience in ('class','division','student')),
  batch_id text not null check (char_length(batch_id) between 1 and 80),
  target_division text check (target_division in ('A','B','C')),
  assigned_to uuid references auth.users(id) on delete cascade,
  primary key (id),
  foreign key (user_id) references auth.users(id) on delete cascade,
  constraint exam_category check (category='examination'),
  constraint exam_audience check (
    (audience='class' and target_division is null and assigned_to is null)
    or (audience='division' and target_division is not null and assigned_to is null)
    or (audience='student' and target_division is null and assigned_to is not null)
  )
);
create index calendar_exams_teacher on public.calendar_exams(user_id,starts_at,start_date);
create index calendar_exams_class on public.calendar_exams(batch_id,target_division,starts_at,start_date);
create trigger calendar_exams_guard before insert or update on public.calendar_exams
  for each row execute function public.mannsathi_calendar_guard();

create function public.mannsathi_exam_can_read(p_id uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public
as $$
  select auth.uid() is not null and exists (
    select 1 from public.calendar_exams e where e.id=p_id and (
      (e.user_id=auth.uid() and public.mannsathi_task_teacher(auth.uid(),e.batch_id))
      or (public.mannsathi_task_student_member(auth.uid(),e.batch_id) and (
        e.audience='class'
        or (e.audience='student' and e.assigned_to=auth.uid())
        or (e.audience='division' and exists(select 1 from public.batch_permissions b
          where b.user_id=auth.uid() and b.batch_code=e.batch_id and b.status='approved' and b.division=e.target_division))
      ))
    )
  )
$$;

create function public.mannsathi_exam_projection(p_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,public
as $$
  select to_jsonb(e)||jsonb_build_object('source','teacher_exam','can_edit',
    e.user_id=auth.uid() and public.mannsathi_task_teacher(auth.uid(),e.batch_id))
  from public.calendar_exams e where e.id=p_id and public.mannsathi_exam_can_read(e.id)
$$;

create function public.mannsathi_exam_list(p_start date,p_end date,p_time_zone text,p_offset integer default 0,p_limit integer default 500)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public
as $$
declare v_lower timestamptz; v_upper timestamptz; v_rows jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in to view exams' using errcode='PT401'; end if;
  if p_start is null or p_end is null or not isfinite(p_start) or not isfinite(p_end)
    or p_start<date '1000-01-01' or p_end>date '9999-12-31' or p_end-p_start not between 1 and 62
    or p_offset is null or p_offset not between 0 and 10000 or p_limit is null or p_limit not between 1 and 500
    or p_time_zone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_time_zone) then
    raise exception 'Invalid exam date range' using errcode='PT400'; end if;
  v_lower:=p_start::timestamp at time zone p_time_zone;
  v_upper:=p_end::timestamp at time zone p_time_zone;
  select coalesce(jsonb_agg(public.mannsathi_exam_projection(e.id)
    order by coalesce(e.starts_at,e.start_date::timestamp at time zone p_time_zone),e.id),'[]'::jsonb)
    into v_rows from (
      select x.* from public.calendar_exams x where public.mannsathi_exam_can_read(x.id)
        and ((x.all_day and x.start_date<p_end and x.end_date>p_start)
          or (not x.all_day and x.starts_at<v_upper and x.ends_at>v_lower))
      order by coalesce(x.starts_at,x.start_date::timestamp at time zone p_time_zone),x.id
      offset p_offset limit p_limit
    ) e;
  return v_rows;
end;
$$;

-- Internal shared writer is never exposed to clients. Each public wrapper retains auth.uid().
create function public.mannsathi_exam_save(p_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$
declare
  v_uid uuid:=auth.uid(); v_old public.calendar_exams%rowtype; v_id uuid;
  v_title text; v_description text; v_location text; v_zone text; v_all boolean;
  v_start timestamptz; v_end timestamptz; v_start_date date; v_end_date date; v_reminder integer;
  v_audience text; v_batch text; v_division text; v_student uuid;
begin
  if v_uid is null then raise exception 'Sign in to assign exams' using errcode='PT401'; end if;
  if p_id is not null then
    select * into v_old from public.calendar_exams where id=p_id and user_id=v_uid for update;
    if v_old.id is null or not public.mannsathi_task_teacher(v_uid,v_old.batch_id) then
      raise exception 'Exam unavailable' using errcode='PT404'; end if;
  end if;
  if p_data is null or jsonb_typeof(p_data)<>'object' or exists(select 1 from jsonb_object_keys(p_data) k where k not in
    ('title','description','category','location','all_day','starts_at','ends_at','start_date','end_date','time_zone','reminder_minutes',
     'audience','batch_id','target_division','assigned_to'))
    or jsonb_typeof(p_data->'title') is distinct from 'string'
    or jsonb_typeof(p_data->'category') is distinct from 'string' or p_data->>'category'<>'examination'
    or jsonb_typeof(p_data->'time_zone') is distinct from 'string'
    or jsonb_typeof(p_data->'all_day') is distinct from 'boolean'
    or jsonb_typeof(p_data->'audience') is distinct from 'string'
    or jsonb_typeof(p_data->'batch_id') is distinct from 'string'
    or (p_data ? 'description' and jsonb_typeof(p_data->'description')<>'string')
    or (p_data ? 'location' and jsonb_typeof(p_data->'location')<>'string') then
    raise exception 'Invalid exam fields' using errcode='PT400'; end if;
  v_title:=btrim(p_data->>'title'); v_description:=btrim(coalesce(p_data->>'description',''));
  v_location:=btrim(coalesce(p_data->>'location','')); v_zone:=p_data->>'time_zone'; v_all:=(p_data->>'all_day')::boolean;
  if char_length(v_title) not between 1 and 200 or char_length(v_description)>5000 or char_length(v_location)>300
    or char_length(v_zone) not between 1 and 100 or not exists(select 1 from pg_catalog.pg_timezone_names where name=v_zone) then
    raise exception 'Invalid exam text or timezone' using errcode='PT400'; end if;
  if p_data->'reminder_minutes' is not null and p_data->'reminder_minutes'<>'null'::jsonb then
    if jsonb_typeof(p_data->'reminder_minutes')<>'number' or (p_data->>'reminder_minutes') !~ '^[0-9]+$' then
      raise exception 'Invalid exam reminder' using errcode='PT400'; end if;
    v_reminder:=(p_data->>'reminder_minutes')::integer;
    if v_reminder not in (0,5,10,15,30,60,1440) then raise exception 'Invalid exam reminder' using errcode='PT400'; end if;
  end if;
  if v_all then
    if p_data->>'starts_at' is not null or p_data->>'ends_at' is not null
      or jsonb_typeof(p_data->'start_date') is distinct from 'string' or jsonb_typeof(p_data->'end_date') is distinct from 'string'
      or (p_data->>'start_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or (p_data->>'end_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'Invalid all day exam dates' using errcode='PT400'; end if;
    v_start_date:=(p_data->>'start_date')::date; v_end_date:=(p_data->>'end_date')::date;
  else
    if p_data->>'start_date' is not null or p_data->>'end_date' is not null
      or jsonb_typeof(p_data->'starts_at') is distinct from 'string' or jsonb_typeof(p_data->'ends_at') is distinct from 'string'
      or (p_data->>'starts_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$'
      or (p_data->>'ends_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$' then
      raise exception 'Invalid exam instants' using errcode='PT400'; end if;
    v_start:=(p_data->>'starts_at')::timestamptz; v_end:=(p_data->>'ends_at')::timestamptz;
  end if;
  v_audience:=p_data->>'audience'; v_batch:=btrim(p_data->>'batch_id'); v_division:=p_data->>'target_division';
  if v_audience not in ('class','division','student') or char_length(v_batch) not between 1 and 80 then
    raise exception 'Invalid exam audience' using errcode='PT400'; end if;
  if not public.mannsathi_task_teacher(v_uid,v_batch) then
    raise exception 'Teacher permission required' using errcode='PT403'; end if;
  if v_audience='division' then
    if jsonb_typeof(p_data->'target_division') is distinct from 'string' or v_division not in ('A','B','C')
      or p_data->>'assigned_to' is not null then raise exception 'Invalid exam division' using errcode='PT400'; end if;
  elsif v_division is not null then raise exception 'Unexpected exam division' using errcode='PT400'; end if;
  if v_audience='student' then
    if jsonb_typeof(p_data->'assigned_to') is distinct from 'string' then raise exception 'Invalid exam student' using errcode='PT400'; end if;
    v_student:=(p_data->>'assigned_to')::uuid;
  elsif p_data->>'assigned_to' is not null then raise exception 'Unexpected exam student' using errcode='PT400'; end if;
  if not exists(select 1 from public.batch_permissions b where b.batch_code=v_batch
    and public.mannsathi_task_student_member(b.user_id,b.batch_code)
    and (v_audience<>'division' or b.division=v_division) and (v_audience<>'student' or b.user_id=v_student)) then
    raise exception 'No approved exam recipients' using errcode='PT422'; end if;
  if p_id is null then
    insert into public.calendar_exams(user_id,title,description,category,location,all_day,starts_at,ends_at,start_date,end_date,
      time_zone,reminder_minutes,audience,batch_id,target_division,assigned_to)
    values(v_uid,v_title,v_description,'examination',v_location,v_all,v_start,v_end,v_start_date,v_end_date,
      v_zone,v_reminder,v_audience,v_batch,v_division,v_student) returning id into v_id;
  else
    update public.calendar_exams set title=v_title,description=v_description,location=v_location,all_day=v_all,
      starts_at=v_start,ends_at=v_end,start_date=v_start_date,end_date=v_end_date,time_zone=v_zone,reminder_minutes=v_reminder,
      audience=v_audience,batch_id=v_batch,target_division=v_division,assigned_to=v_student where id=p_id returning id into v_id;
  end if;
  return public.mannsathi_exam_projection(v_id);
end;
$$;

create function public.mannsathi_exam_create(p_data jsonb)
returns jsonb language sql security definer set search_path=pg_catalog,public
as $$ select public.mannsathi_exam_save(null,p_data) $$;
create function public.mannsathi_exam_edit(p_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$ begin
  if p_id is null then raise exception 'Choose an exam' using errcode='PT400'; end if;
  return public.mannsathi_exam_save(p_id,p_data);
end $$;
create function public.mannsathi_exam_delete(p_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$
begin
  if auth.uid() is null then raise exception 'Sign in to manage exams' using errcode='PT401'; end if;
  delete from public.calendar_exams e where e.id=p_id and e.user_id=auth.uid()
    and public.mannsathi_task_teacher(auth.uid(),e.batch_id);
  if not found then raise exception 'Exam unavailable' using errcode='PT404'; end if;
  return jsonb_build_object('deleted',true);
end;
$$;

alter table public.calendar_exams enable row level security;
alter table public.calendar_exams force row level security;
create policy exams_boundary on public.calendar_exams as restrictive for select to authenticated
  using(public.mannsathi_exam_can_read(id));
create policy exams_select on public.calendar_exams for select to authenticated
  using(public.mannsathi_exam_can_read(id));
revoke all on public.calendar_exams from public,anon,authenticated;
grant select on public.calendar_exams to authenticated;
revoke all on function public.mannsathi_exam_can_read(uuid),public.mannsathi_exam_projection(uuid),
  public.mannsathi_exam_list(date,date,text,integer,integer),public.mannsathi_exam_save(uuid,jsonb),
  public.mannsathi_exam_create(jsonb),public.mannsathi_exam_edit(uuid,jsonb),public.mannsathi_exam_delete(uuid)
  from public,anon,authenticated;
grant execute on function public.mannsathi_exam_can_read(uuid),public.mannsathi_exam_list(date,date,text,integer,integer),
  public.mannsathi_exam_create(jsonb),public.mannsathi_exam_edit(uuid,jsonb),public.mannsathi_exam_delete(uuid) to authenticated;
comment on table public.calendar_exams is 'Teacher scheduled exams; current approved class/division/student recipients have read-only access.';
notify pgrst,'reload schema';
commit;
