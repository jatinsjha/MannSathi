-- PROPOSED migration, based on the reviewed profiles and batch_permissions schema.
-- Review before applying. Existing Auth, calendar, profile and batch policies remain intact.
-- Teacher permissions and approved class membership are provisioned by administrators.
begin;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
    raise exception 'Run this migration as the trusted Supabase SQL editor administrator with BYPASSRLS privileges';
  end if;
end;
$$;

create table public.teacher_permissions (
    user_id uuid not null references auth.users(id) on delete cascade,
    batch_code text not null check (char_length(batch_code) between 1 and 80),
    approved_by uuid references auth.users(id),
    created_at timestamptz not null default now(),
    primary key (user_id, batch_code)
);

create table public.tasks (
    id uuid primary key default gen_random_uuid(),
    request_id uuid not null,
    created_by uuid not null references auth.users(id) on delete cascade,
    assigned_to uuid references auth.users(id) on delete cascade,
    batch_id text,
    audience text not null check (audience in ('personal', 'student', 'class')),
    title text not null check (char_length(btrim(title)) between 1 and 200),
    description text not null default '' check (char_length(description) <= 5000),
    subject text not null default '' check (char_length(subject) <= 120),
    task_type text not null check (task_type in ('personal_task','homework','assignment','practical','examination_preparation','project','other')),
    due_at timestamptz check (due_at is null or (isfinite(due_at) and due_at >= timestamptz '1000-01-01 00:00:00+00' and due_at < timestamptz '10000-01-01 00:00:00+00')),
    estimated_minutes integer check (estimated_minutes between 1 and 10080),
    priority text not null check (priority in ('low','medium','high','urgent')),
    status text not null default 'pending' check (status in ('pending','in_progress','completed')),
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (created_by, request_id),
    constraint task_audience_shape check (
      (audience = 'personal' and assigned_to is not null and assigned_to = created_by and batch_id is null)
      or (audience = 'student' and assigned_to is not null and batch_id is not null)
      or (audience = 'class' and assigned_to is null and batch_id is not null)
    ),
    constraint task_parent_status check (audience = 'personal' or (status = 'pending' and completed_at is null)),
    constraint task_completion_shape check ((status = 'completed') = (completed_at is not null))
);

create table public.task_recipients (
    task_id uuid not null references public.tasks(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    status text not null default 'pending' check (status in ('pending','in_progress','completed')),
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    primary key (task_id, user_id),
    check ((status = 'completed') = (completed_at is not null))
);

create table public.task_notifications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    task_id uuid references public.tasks(id) on delete set null,
    batch_id text not null,
    title text not null,
    message text not null,
    read_at timestamptz,
    created_at timestamptz not null default now(),
    unique (user_id, task_id)
);

create index tasks_owner_deadline on public.tasks (created_by, due_at, id);
create index tasks_class_deadline on public.tasks (batch_id, due_at, id) where audience <> 'personal';
create index task_recipients_user on public.task_recipients (user_id, task_id);
create index task_notifications_user_created on public.task_notifications (user_id, created_at desc, id);
create index task_notifications_unread on public.task_notifications (user_id) where read_at is null;

alter table public.teacher_permissions enable row level security;
alter table public.teacher_permissions force row level security;
alter table public.tasks enable row level security;
alter table public.tasks force row level security;
alter table public.task_recipients enable row level security;
alter table public.task_recipients force row level security;
alter table public.task_notifications enable row level security;
alter table public.task_notifications force row level security;
revoke all on public.teacher_permissions, public.tasks, public.task_recipients, public.task_notifications from public, anon, authenticated;
grant select on public.tasks, public.task_recipients, public.task_notifications to authenticated;

-- All definer functions have a fixed search_path, static SQL, and verified auth.uid().
-- No role is read from editable Auth metadata or profiles.
create function public.mannsathi_task_teacher(p_user uuid, p_batch text)
returns boolean language sql stable security definer set search_path = pg_catalog, public
as $$ select exists (select 1 from public.teacher_permissions where user_id = p_user and batch_code = p_batch) $$;

create function public.mannsathi_task_student_member(p_user uuid, p_batch text)
returns boolean language sql stable security definer set search_path = pg_catalog, public
as $$
  select exists (select 1 from public.batch_permissions where user_id = p_user and batch_code = p_batch and status = 'approved')
     and not exists (select 1 from public.teacher_permissions where user_id = p_user)
$$;

create function public.mannsathi_task_can_read(p_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public
as $$
  select auth.uid() is not null and exists (
    select 1 from public.tasks t where t.id = p_id and (
      (t.audience = 'personal' and t.created_by = auth.uid())
      or (t.audience <> 'personal' and t.created_by = auth.uid() and public.mannsathi_task_teacher(auth.uid(), t.batch_id))
      or (t.audience <> 'personal' and public.mannsathi_task_student_member(auth.uid(), t.batch_id)
          and exists (select 1 from public.task_recipients r where r.task_id = t.id and r.user_id = auth.uid()))
    )
  )
$$;

create function public.mannsathi_task_can_read_notification(p_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public
as $$
  select auth.uid() is not null and exists (
    select 1 from public.task_notifications n where n.id = p_id and n.user_id = auth.uid()
      and public.mannsathi_task_student_member(auth.uid(), n.batch_id)
      and (n.task_id is null or public.mannsathi_task_can_read(n.task_id))
  )
$$;

create policy tasks_read_authorized on public.tasks for select to authenticated
using (public.mannsathi_task_can_read(id));
create policy task_recipients_read_authorized on public.task_recipients for select to authenticated
using (public.mannsathi_task_can_read(task_id) and (user_id = auth.uid() or exists (
    select 1 from public.tasks t where t.id = task_id and t.created_by = auth.uid()
)));
create policy task_notifications_read_own on public.task_notifications for select to authenticated
using (public.mannsathi_task_can_read_notification(id));

-- Public API functions are added below; table mutations have no browser grants.
create function public.mannsathi_task_fields(p_data jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_due timestamptz;
  v_minutes integer;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' or exists (
    select 1 from jsonb_object_keys(p_data) k where k not in
    ('title','description','subject','task_type','due_at','estimated_minutes','priority')
  ) then raise exception 'Unsupported task fields' using errcode = 'PT400'; end if;
  if jsonb_typeof(p_data->'title') is distinct from 'string'
     or char_length(btrim(p_data->>'title')) not between 1 and 200 then
    raise exception 'Enter a task title of 1 to 200 characters' using errcode = 'PT400';
  end if;
  if (p_data ? 'description' and jsonb_typeof(p_data->'description') <> 'string')
     or char_length(coalesce(p_data->>'description','')) > 5000
     or (p_data ? 'subject' and jsonb_typeof(p_data->'subject') <> 'string')
     or char_length(coalesce(p_data->>'subject','')) > 120 then
    raise exception 'Invalid task description or subject' using errcode = 'PT400';
  end if;
  if coalesce(p_data->>'task_type','') not in ('personal_task','homework','assignment','practical','examination_preparation','project','other')
     or coalesce(p_data->>'priority','') not in ('low','medium','high','urgent') then
    raise exception 'Choose a valid task type and priority' using errcode = 'PT400';
  end if;
  if p_data->'due_at' is not null and p_data->'due_at' <> 'null'::jsonb then
    if jsonb_typeof(p_data->'due_at') <> 'string' or (p_data->>'due_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$' then
      raise exception 'Use a deadline with a timezone offset' using errcode = 'PT400';
    end if;
    begin v_due := (p_data->>'due_at')::timestamptz;
    exception when others then raise exception 'Invalid task deadline' using errcode = 'PT400'; end;
    if not isfinite(v_due) or v_due < timestamptz '1000-01-01 00:00:00+00' or v_due >= timestamptz '10000-01-01 00:00:00+00' then
      raise exception 'Invalid task deadline' using errcode = 'PT400';
    end if;
  end if;
  if p_data->'estimated_minutes' is not null and p_data->'estimated_minutes' <> 'null'::jsonb then
    if jsonb_typeof(p_data->'estimated_minutes') <> 'number' or (p_data->>'estimated_minutes') !~ '^[0-9]+$' then
      raise exception 'Estimated minutes must be a whole number' using errcode = 'PT400';
    end if;
    begin v_minutes := (p_data->>'estimated_minutes')::integer;
    exception when others then raise exception 'Invalid estimated minutes' using errcode = 'PT400'; end;
    if v_minutes not between 1 and 10080 then raise exception 'Estimated minutes must be 1 to 10080' using errcode = 'PT400'; end if;
  end if;
  return jsonb_build_object('title',btrim(p_data->>'title'),'description',btrim(coalesce(p_data->>'description','')),
    'subject',btrim(coalesce(p_data->>'subject','')),'task_type',p_data->>'task_type',
    'due_at',v_due,'estimated_minutes',v_minutes,'priority',p_data->>'priority');
end;
$$;

create function public.mannsathi_task_context()
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare v_uid uuid := auth.uid(); v_teacher boolean; v_batches jsonb; v_students jsonb;
begin
  if v_uid is null then raise exception 'Sign in to use tasks' using errcode = 'PT401'; end if;
  select exists(select 1 from public.teacher_permissions where user_id = v_uid) into v_teacher;
  if v_teacher then
    select coalesce(jsonb_agg(jsonb_build_object('id',batch_code,'label',upper(batch_code)) order by batch_code),'[]'::jsonb)
      into v_batches from public.teacher_permissions where user_id = v_uid;
    select coalesce(jsonb_agg(jsonb_build_object('id',b.user_id,'batch_id',b.batch_code,
        'full_name',coalesce(nullif(p.full_name,''),nullif(u.raw_user_meta_data->>'full_name',''),'Student')) order by b.user_id),'[]'::jsonb)
      into v_students from public.batch_permissions b join auth.users u on u.id = b.user_id
      left join public.profiles p on p.id = b.user_id
      where b.status = 'approved' and public.mannsathi_task_teacher(v_uid,b.batch_code)
        and public.mannsathi_task_student_member(b.user_id,b.batch_code);
  else
    select coalesce(jsonb_agg(jsonb_build_object('id',batch_code,'label',upper(batch_code)) order by batch_code),'[]'::jsonb)
      into v_batches from public.batch_permissions where user_id = v_uid and status = 'approved';
    v_students := '[]'::jsonb;
  end if;
  return jsonb_build_object('role',case when v_teacher then 'teacher' else 'student' end,
    'user_id',v_uid,'batches',v_batches,'students',v_students);
end;
$$;

create function public.mannsathi_task_projection(p_id uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog, public
as $$
  select to_jsonb(t) || jsonb_build_object(
    'user_id',auth.uid(),
    'status',case when t.audience = 'personal' or t.created_by = auth.uid() then t.status else r.status end,
    'completed_at',case when t.audience = 'personal' or t.created_by = auth.uid() then t.completed_at else r.completed_at end,
    'assigned_by',coalesce(nullif(p.full_name,''),nullif(u.raw_user_meta_data->>'full_name',''),'Teacher'),
    'recipient_count',case when t.audience <> 'personal' and t.created_by = auth.uid() then (select count(*) from public.task_recipients where task_id=t.id) else null end,
    'completed_count',case when t.audience <> 'personal' and t.created_by = auth.uid() then (select count(*) from public.task_recipients where task_id=t.id and status='completed') else null end
  ) from public.tasks t join auth.users u on u.id=t.created_by left join public.profiles p on p.id=t.created_by
  left join public.task_recipients r on r.task_id=t.id and r.user_id=auth.uid()
  where t.id=p_id and public.mannsathi_task_can_read(t.id)
$$;

create function public.mannsathi_task_list(p_offset integer default 0, p_limit integer default 500)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare v_result jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in to use tasks' using errcode = 'PT401'; end if;
  if p_offset is null or p_limit is null or p_offset < 0 or p_offset > 10000 or p_limit not between 1 and 500 then
    raise exception 'Invalid task page' using errcode = 'PT400'; end if;
  select coalesce(jsonb_agg(public.mannsathi_task_projection(q.id) order by q.created_at desc,q.id),'[]'::jsonb)
    into v_result from (select id,created_at from public.tasks where public.mannsathi_task_can_read(id)
      order by created_at desc,id limit p_limit offset p_offset) q;
  return v_result;
end;
$$;

create function public.mannsathi_task_create(p_request_id uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid(); v_id uuid; v_audience text; v_batch text; v_target uuid;
  v_status text; v_fields jsonb; v_name text; v_count integer;
begin
  if v_uid is null then raise exception 'Sign in to use tasks' using errcode = 'PT401'; end if;
  if p_request_id is null or p_data is null or jsonb_typeof(p_data) <> 'object' or exists (
    select 1 from jsonb_object_keys(p_data) k where k not in
    ('title','description','subject','task_type','due_at','estimated_minutes','priority','audience','batch_id','assigned_to','status')
  ) then raise exception 'Unsupported task fields' using errcode = 'PT400'; end if;
  v_fields := public.mannsathi_task_fields(p_data - array['audience','batch_id','assigned_to','status']);
  v_audience := coalesce(p_data->>'audience','personal');
  v_status := coalesce(p_data->>'status','pending');
  if v_audience not in ('personal','student','class') or v_status not in ('pending','in_progress','completed') then
    raise exception 'Invalid task audience or status' using errcode = 'PT400'; end if;
  if v_audience = 'personal' then
    if p_data->'batch_id' is not null and p_data->'batch_id' <> 'null'::jsonb then
      raise exception 'Personal tasks cannot target a class' using errcode = 'PT400'; end if;
    if p_data->'assigned_to' is not null and p_data->'assigned_to' <> 'null'::jsonb then
      raise exception 'Personal task ownership is assigned by the server' using errcode = 'PT400'; end if;
    v_target := v_uid;
  else
    v_batch := p_data->>'batch_id';
    if v_batch is null or char_length(v_batch) not between 1 and 80 or not public.mannsathi_task_teacher(v_uid,v_batch) then
      raise exception 'Teacher access to this class is required' using errcode = 'PT403'; end if;
    if v_status <> 'pending' then raise exception 'New assignments start as pending' using errcode = 'PT400'; end if;
    if v_audience = 'student' then
      begin v_target := (p_data->>'assigned_to')::uuid;
      exception when others then raise exception 'Choose a valid student' using errcode = 'PT400'; end;
      if v_target is null or not public.mannsathi_task_student_member(v_target,v_batch) then
        raise exception 'Choose an approved student in your class' using errcode = 'PT403'; end if;
    elsif p_data->'assigned_to' is not null and p_data->'assigned_to' <> 'null'::jsonb then
      raise exception 'A class assignment cannot also target one student' using errcode = 'PT400';
    end if;
  end if;
  -- One transaction per user/request id: retries cannot fan out duplicates.
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || p_request_id::text,0));
  select id into v_id from public.tasks where created_by=v_uid and request_id=p_request_id;
  if v_id is not null then
    if not public.mannsathi_task_can_read(v_id) then raise exception 'Task access was revoked' using errcode = 'PT403'; end if;
    return public.mannsathi_task_projection(v_id);
  end if;
  insert into public.tasks(request_id,created_by,assigned_to,batch_id,audience,title,description,subject,task_type,due_at,estimated_minutes,priority,status,completed_at)
  values(p_request_id,v_uid,v_target,v_batch,v_audience,v_fields->>'title',v_fields->>'description',v_fields->>'subject',v_fields->>'task_type',
    (v_fields->>'due_at')::timestamptz,(v_fields->>'estimated_minutes')::integer,v_fields->>'priority',v_status,
    case when v_status='completed' then now() else null end) returning id into v_id;
  if v_audience <> 'personal' then
    insert into public.task_recipients(task_id,user_id)
      select v_id,b.user_id from public.batch_permissions b where b.batch_code=v_batch and b.status='approved'
        and public.mannsathi_task_student_member(b.user_id,v_batch)
        and (v_audience='class' or b.user_id=v_target);
    get diagnostics v_count = row_count;
    if v_count=0 then raise exception 'This class has no approved students to assign' using errcode='PT400'; end if;
    select left(coalesce(nullif(p.full_name,''),nullif(u.raw_user_meta_data->>'full_name',''),'Your teacher'),120)
      into v_name from auth.users u left join public.profiles p on p.id=u.id where u.id=v_uid;
    insert into public.task_notifications(user_id,task_id,batch_id,title,message)
      select user_id,v_id,v_batch,'New work assigned',v_name || ' assigned you: ' || (v_fields->>'title')
      from public.task_recipients where task_id=v_id;
  end if;
  return public.mannsathi_task_projection(v_id);
end;
$$;

create function public.mannsathi_task_edit(p_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_task public.tasks%rowtype; v_fields jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in to use tasks' using errcode='PT401'; end if;
  select * into v_task from public.tasks where id=p_id for update;
  if not found or v_task.created_by<>auth.uid() or not public.mannsathi_task_can_read(p_id) then
    raise exception 'Task not found' using errcode='PT404'; end if;
  v_fields := public.mannsathi_task_fields(p_data);
  update public.tasks set title=v_fields->>'title',description=v_fields->>'description',subject=v_fields->>'subject',
    task_type=v_fields->>'task_type',due_at=(v_fields->>'due_at')::timestamptz,
    estimated_minutes=(v_fields->>'estimated_minutes')::integer,priority=v_fields->>'priority',updated_at=now()
    where id=p_id;
  return public.mannsathi_task_projection(p_id);
end;
$$;

create function public.mannsathi_task_delete(p_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_task public.tasks%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in to use tasks' using errcode='PT401'; end if;
  select * into v_task from public.tasks where id=p_id for update;
  if not found or v_task.created_by<>auth.uid() or not public.mannsathi_task_can_read(p_id) then
    raise exception 'Task not found' using errcode='PT404'; end if;
  delete from public.tasks where id=p_id;
  return jsonb_build_object('deleted',true);
end;
$$;

create function public.mannsathi_task_status(p_id uuid,p_status text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_task public.tasks%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in to use tasks' using errcode='PT401'; end if;
  if p_status is null or p_status not in ('pending','in_progress','completed') then
    raise exception 'Choose a valid task status' using errcode='PT400'; end if;
  select * into v_task from public.tasks where id=p_id for update;
  if not found or not public.mannsathi_task_can_read(p_id) then raise exception 'Task not found' using errcode='PT404'; end if;
  if v_task.audience='personal' and v_task.created_by=auth.uid() then
    update public.tasks set status=p_status,completed_at=case when p_status='completed' then coalesce(completed_at,now()) else null end,
      updated_at=now() where id=p_id;
  elsif v_task.audience<>'personal' and public.mannsathi_task_student_member(auth.uid(),v_task.batch_id) then
    update public.task_recipients set status=p_status,completed_at=case when p_status='completed' then coalesce(completed_at,now()) else null end
      where task_id=p_id and user_id=auth.uid();
    if not found then raise exception 'Task not found' using errcode='PT404'; end if;
  else raise exception 'Only the student can change assignment progress' using errcode='PT403'; end if;
  return public.mannsathi_task_projection(p_id);
end;
$$;

create function public.mannsathi_task_notifications()
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare v_notifications jsonb; v_unread bigint;
begin
  if auth.uid() is null then raise exception 'Sign in to view notifications' using errcode='PT401'; end if;
  select coalesce(jsonb_agg(to_jsonb(n) order by n.created_at desc,n.id),'[]'::jsonb)
    into v_notifications from (select id,task_id,title,message,read_at,created_at from public.task_notifications
      where public.mannsathi_task_can_read_notification(id) order by created_at desc,id limit 100) n;
  select count(*) into v_unread from public.task_notifications
    where read_at is null and public.mannsathi_task_can_read_notification(id);
  return jsonb_build_object('notifications',v_notifications,'unread_count',v_unread);
end;
$$;

create function public.mannsathi_task_read_notification(p_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null then raise exception 'Sign in to view notifications' using errcode='PT401'; end if;
  if not public.mannsathi_task_can_read_notification(p_id) then
    raise exception 'Notification not found' using errcode='PT404'; end if;
  update public.task_notifications set read_at=coalesce(read_at,now()) where id=p_id and user_id=auth.uid();
  return jsonb_build_object('read',true);
end;
$$;

-- Restrictive boundaries stop future permissive SELECT policies broadening access.
create policy tasks_owner_boundary on public.tasks as restrictive for select to authenticated
using (public.mannsathi_task_can_read(id));
create policy task_recipients_boundary on public.task_recipients as restrictive for select to authenticated
using (public.mannsathi_task_can_read(task_id) and (user_id=auth.uid() or exists (
  select 1 from public.tasks t where t.id=task_id and t.created_by=auth.uid()
)));
create policy task_notifications_boundary on public.task_notifications as restrictive for select to authenticated
using (public.mannsathi_task_can_read_notification(id));

revoke all on function
  public.mannsathi_task_teacher(uuid,text), public.mannsathi_task_student_member(uuid,text),
  public.mannsathi_task_can_read(uuid), public.mannsathi_task_can_read_notification(uuid),
  public.mannsathi_task_fields(jsonb), public.mannsathi_task_projection(uuid),
  public.mannsathi_task_context(), public.mannsathi_task_list(integer,integer),
  public.mannsathi_task_create(uuid,jsonb), public.mannsathi_task_edit(uuid,jsonb),
  public.mannsathi_task_delete(uuid), public.mannsathi_task_status(uuid,text),
  public.mannsathi_task_notifications(), public.mannsathi_task_read_notification(uuid)
from public, anon, authenticated;

grant execute on function
  public.mannsathi_task_can_read(uuid), public.mannsathi_task_can_read_notification(uuid),
  public.mannsathi_task_context(), public.mannsathi_task_list(integer,integer),
  public.mannsathi_task_create(uuid,jsonb), public.mannsathi_task_edit(uuid,jsonb),
  public.mannsathi_task_delete(uuid), public.mannsathi_task_status(uuid,text),
  public.mannsathi_task_notifications(), public.mannsathi_task_read_notification(uuid)
to authenticated;

comment on table public.teacher_permissions is 'Administrator-managed teacher authorization by class; browser accounts cannot self-promote.';
comment on table public.task_recipients is 'Snapshot of intended students at assignment time; each student controls only their own progress.';
comment on column public.tasks.request_id is 'Client-generated idempotency identifier; unique per verified creator prevents repeated assignment fan-out.';
comment on column public.task_notifications.batch_id is 'Retained after task deletion so removed students cannot read former-class notifications.';

notify pgrst, 'reload schema';
commit;
