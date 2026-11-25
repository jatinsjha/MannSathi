-- PROPOSED migration after 003. Private student subjects, timestamp-based focus
-- sessions and preferences. Review before applying; no teacher/class rules change.
begin;
do $$ begin
  if not exists(select 1 from pg_catalog.pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
    raise exception 'Run this migration as a trusted Supabase SQL administrator';
  end if;
end; $$;

-- Internal validation is repeated here for direct RPC callers.
create function public.mannsathi_focus_subject_fields(p_data jsonb, p_edit boolean default false)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public
as $$ declare v_name text; v_color text; v_goal integer; begin
  if p_data is null or jsonb_typeof(p_data)<>'object' or
     exists(select 1 from jsonb_object_keys(p_data) k where k not in ('name','color','weekly_goal_minutes','archived')) or
     (not p_edit and p_data ? 'archived') or jsonb_typeof(p_data->'name') is distinct from 'string' or
     jsonb_typeof(p_data->'color') is distinct from 'string' or
     jsonb_typeof(p_data->'weekly_goal_minutes') is distinct from 'number' or
     coalesce(p_data->>'weekly_goal_minutes','') !~ '^[0-9]{1,5}$' or
     (p_edit and jsonb_typeof(p_data->'archived') is distinct from 'boolean') then
    raise exception 'Invalid subject fields' using errcode='PT400';
  end if;
  v_name:=btrim(p_data->>'name'); v_color:=lower(p_data->>'color'); v_goal:=(p_data->>'weekly_goal_minutes')::integer;
  if char_length(v_name) not between 1 and 100 or v_color !~ '^#[0-9a-f]{6}$' or v_goal not between 0 and 10080 then
    raise exception 'Invalid subject fields' using errcode='PT400';
  end if;
  return jsonb_build_object('name',v_name,'color',v_color,'weekly_goal_minutes',v_goal,'archived',coalesce((p_data->>'archived')::boolean,false));
end; $$;

create table public.study_subjects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check(char_length(btrim(name)) between 1 and 100),
  color text not null default '#bda0ed' check(color ~ '^#[0-9a-f]{6}$'),
  weekly_goal_minutes integer not null default 0 check(weekly_goal_minutes between 0 and 10080),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id,id)
);
create unique index study_subjects_active_name on public.study_subjects(user_id,lower(btrim(name))) where not archived;

create table public.focus_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  focus_minutes integer not null default 25 check(focus_minutes between 1 and 180),
  short_break_minutes integer not null default 5 check(short_break_minutes between 1 and 60),
  long_break_minutes integer not null default 15 check(long_break_minutes between 1 and 120),
  sessions_before_long integer not null default 4 check(sessions_before_long between 1 and 12),
  auto_start boolean not null default false,
  sound boolean not null default false,
  updated_at timestamptz not null default now()
);

create table public.focus_sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  subject_id uuid not null,
  task_id uuid references public.tasks(id) on delete set null,
  status text not null check(status in ('running','paused','completed','interrupted','cancelled')),
  planned_seconds integer not null check(planned_seconds between 60 and 10800),
  focused_seconds numeric(12,6) not null default 0 check(focused_seconds between 0 and planned_seconds),
  started_at timestamptz not null,
  last_started_at timestamptz,
  paused_at timestamptz,
  finished_at timestamptz,
  time_zone text not null check(char_length(time_zone) between 1 and 100),
  unique(user_id,id),
  foreign key(user_id,subject_id) references public.study_subjects(user_id,id),
  check(isfinite(started_at) and (last_started_at is null or isfinite(last_started_at)) and (finished_at is null or isfinite(finished_at))),
  check((status='running' and last_started_at is not null and finished_at is null)
    or (status='paused' and last_started_at is null and paused_at is not null and finished_at is null)
    or (status in ('completed','interrupted','cancelled') and last_started_at is null and finished_at is not null)),
  check(status<>'completed' or focused_seconds=planned_seconds),
  check(status<>'cancelled' or focused_seconds=0)
);
create unique index focus_one_active_per_user on public.focus_sessions(user_id) where status in ('running','paused');
create index focus_sessions_owner_finished on public.focus_sessions(user_id,finished_at desc,id);
create index focus_sessions_subject on public.focus_sessions(user_id,subject_id);

-- Each actual running period is retained so pauses never count as study and
-- daily/weekly totals split correctly at local midnights, including DST changes.
create table public.focus_segments (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  session_id uuid not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  foreign key(user_id,session_id) references public.focus_sessions(user_id,id) on delete cascade,
  check(isfinite(started_at) and (ended_at is null or (isfinite(ended_at) and ended_at>=started_at)))
);
create unique index focus_one_open_segment on public.focus_segments(session_id) where ended_at is null;
create index focus_segments_owner_range on public.focus_segments(user_id,started_at,ended_at);

alter table public.study_subjects enable row level security;
alter table public.study_subjects force row level security;
alter table public.focus_preferences enable row level security;
alter table public.focus_preferences force row level security;
alter table public.focus_sessions enable row level security;
alter table public.focus_sessions force row level security;
alter table public.focus_segments enable row level security;
alter table public.focus_segments force row level security;
revoke all on public.study_subjects,public.focus_preferences,public.focus_sessions,public.focus_segments from public,anon,authenticated;
grant select on public.study_subjects,public.focus_preferences,public.focus_sessions,public.focus_segments to authenticated;

create function public.mannsathi_focus_is_student()
returns boolean language sql stable security definer set search_path=pg_catalog,public
as $$ select auth.uid() is not null and not exists(select 1 from public.teacher_permissions where user_id=auth.uid()) $$;
create function public.mannsathi_focus_require_student()
returns uuid language plpgsql stable security definer set search_path=pg_catalog,public
as $$ begin
  if auth.uid() is null then raise exception 'Sign in to use focus' using errcode='PT401'; end if;
  if not public.mannsathi_focus_is_student() then raise exception 'Focus is available to student accounts' using errcode='PT403'; end if;
  return auth.uid();
end; $$;

create policy subjects_read_own on public.study_subjects for select to authenticated using(user_id=auth.uid() and public.mannsathi_focus_is_student());
create policy subjects_boundary on public.study_subjects as restrictive for select to authenticated using(user_id=auth.uid() and public.mannsathi_focus_is_student());
create policy focus_preferences_read_own on public.focus_preferences for select to authenticated using(user_id=auth.uid() and public.mannsathi_focus_is_student());
create policy focus_preferences_boundary on public.focus_preferences as restrictive for select to authenticated using(user_id=auth.uid() and public.mannsathi_focus_is_student());
create policy focus_sessions_read_own on public.focus_sessions for select to authenticated using(user_id=auth.uid() and public.mannsathi_focus_is_student());
create policy focus_sessions_boundary on public.focus_sessions as restrictive for select to authenticated using(user_id=auth.uid() and public.mannsathi_focus_is_student());
create policy focus_segments_read_own on public.focus_segments for select to authenticated using(user_id=auth.uid() and public.mannsathi_focus_is_student());
create policy focus_segments_boundary on public.focus_segments as restrictive for select to authenticated using(user_id=auth.uid() and public.mannsathi_focus_is_student());

create function public.mannsathi_focus_zone(p_zone text)
returns text language plpgsql stable security definer set search_path=pg_catalog,public
as $$ begin
  if p_zone is null or char_length(p_zone)>100 or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_zone) then
    raise exception 'Choose a valid IANA timezone' using errcode='PT400';
  end if;
  return p_zone;
end; $$;

create function public.mannsathi_focus_subjects()
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$ declare v_user uuid:=public.mannsathi_focus_require_student(); v_rows jsonb; begin
  select coalesce(jsonb_agg(to_jsonb(s) order by s.archived,lower(s.name),s.id),'[]'::jsonb) into v_rows
    from public.study_subjects s where s.user_id=v_user;
  return jsonb_build_object('role','student','subjects',v_rows);
end; $$;

create function public.mannsathi_focus_create_subject(p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$ declare v_user uuid:=public.mannsathi_focus_require_student(); v_data jsonb; v_row public.study_subjects; begin
  v_data:=public.mannsathi_focus_subject_fields(p_data);
  perform pg_advisory_xact_lock(hashtextextended(v_user::text,0));
  if (select count(*) from public.study_subjects where user_id=v_user and not archived)>=100 then
    raise exception 'You can keep up to 100 active subjects' using errcode='PT409';
  end if;
  insert into public.study_subjects(user_id,name,color,weekly_goal_minutes)
    values(v_user,v_data->>'name',v_data->>'color',(v_data->>'weekly_goal_minutes')::integer) returning * into v_row;
  return jsonb_build_object('subject',to_jsonb(v_row));
exception when unique_violation then raise exception 'An active subject already has that name' using errcode='PT409';
end; $$;

create function public.mannsathi_focus_prefs()
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$ declare v_user uuid:=public.mannsathi_focus_require_student(); v_prefs jsonb; begin
  select to_jsonb(p)-array['user_id','updated_at'] into v_prefs from public.focus_preferences p where user_id=v_user;
  return coalesce(v_prefs,jsonb_build_object('focus_minutes',25,'short_break_minutes',5,'long_break_minutes',15,
    'sessions_before_long',4,'auto_start',false,'sound',false));
end; $$;

create function public.mannsathi_focus_save_prefs(p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$ declare v_user uuid:=public.mannsathi_focus_require_student(); k text; begin
  if p_data is null or jsonb_typeof(p_data)<>'object' or
    (select count(*) from jsonb_object_keys(p_data))<>6 or
    exists(select 1 from jsonb_object_keys(p_data) x where x not in
      ('focus_minutes','short_break_minutes','long_break_minutes','sessions_before_long','auto_start','sound')) then
    raise exception 'Invalid timer preferences' using errcode='PT400';
  end if;
  foreach k in array array['focus_minutes','short_break_minutes','long_break_minutes','sessions_before_long'] loop
    if jsonb_typeof(p_data->k) is distinct from 'number' or coalesce(p_data->>k,'') !~ '^[0-9]{1,3}$' then
      raise exception 'Invalid timer preferences' using errcode='PT400';
    end if;
  end loop;
  if jsonb_typeof(p_data->'auto_start') is distinct from 'boolean' or jsonb_typeof(p_data->'sound') is distinct from 'boolean' or
    (p_data->>'focus_minutes')::integer not between 1 and 180 or
    (p_data->>'short_break_minutes')::integer not between 1 and 60 or
    (p_data->>'long_break_minutes')::integer not between 1 and 120 or
    (p_data->>'sessions_before_long')::integer not between 1 and 12 then
    raise exception 'Invalid timer preferences' using errcode='PT400';
  end if;
  insert into public.focus_preferences(user_id,focus_minutes,short_break_minutes,long_break_minutes,sessions_before_long,auto_start,sound)
  values(v_user,(p_data->>'focus_minutes')::integer,(p_data->>'short_break_minutes')::integer,
    (p_data->>'long_break_minutes')::integer,(p_data->>'sessions_before_long')::integer,
    (p_data->>'auto_start')::boolean,(p_data->>'sound')::boolean)
  on conflict(user_id) do update set focus_minutes=excluded.focus_minutes,short_break_minutes=excluded.short_break_minutes,
    long_break_minutes=excluded.long_break_minutes,sessions_before_long=excluded.sessions_before_long,
    auto_start=excluded.auto_start,sound=excluded.sound,updated_at=clock_timestamp();
  return jsonb_build_object('prefs',public.mannsathi_focus_prefs());
end; $$;

create function public.mannsathi_focus_projection(p_id uuid, p_now timestamptz)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$ declare v_user uuid:=public.mannsathi_focus_require_student(); v_row jsonb; begin
  select to_jsonb(f)||jsonb_build_object('subject_name',s.name,'color',s.color,
    'remaining_seconds',ceil(greatest(0,f.planned_seconds-f.focused_seconds-
      case when f.status='running' then greatest(0,extract(epoch from p_now-f.last_started_at)) else 0 end)),
    'deadline_at',case when f.status='running' then f.last_started_at+(f.planned_seconds-f.focused_seconds)*interval '1 second' else null end)
    into v_row from public.focus_sessions f join public.study_subjects s on s.user_id=f.user_id and s.id=f.subject_id
    where f.user_id=v_user and f.id=p_id;
  if v_row is null then raise exception 'Focus session not found' using errcode='PT404'; end if;
  return v_row;
end; $$;

-- Caller holds the per-user advisory lock. Complete exactly at the deadline,
-- even when the tab is closed and the next request arrives hours later.
create function public.mannsathi_focus_reconcile(p_id uuid, p_now timestamptz)
returns public.focus_sessions language plpgsql security definer set search_path=pg_catalog,public
as $$ declare v_user uuid:=public.mannsathi_focus_require_student(); v_row public.focus_sessions; v_deadline timestamptz; begin
  select * into v_row from public.focus_sessions where id=p_id and user_id=v_user for update;
  if not found then raise exception 'Focus session not found' using errcode='PT404'; end if;
  if v_row.status='running' then
    v_deadline:=v_row.last_started_at+(v_row.planned_seconds-v_row.focused_seconds)*interval '1 second';
    if p_now>=v_deadline then
      update public.focus_segments set ended_at=v_deadline where session_id=p_id and user_id=v_user and ended_at is null;
      update public.focus_sessions set status='completed',focused_seconds=planned_seconds,
        last_started_at=null,paused_at=null,finished_at=v_deadline where id=p_id returning * into v_row;
    end if;
  end if;
  return v_row;
end; $$;

create function public.mannsathi_focus_state()
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$ declare v_user uuid:=public.mannsathi_focus_require_student(); v_id uuid; v_row public.focus_sessions;
  v_now timestamptz; v_active jsonb; v_finished jsonb; begin
  perform pg_advisory_xact_lock(hashtextextended(v_user::text,0));
  v_now:=clock_timestamp();
  select id into v_id from public.focus_sessions where user_id=v_user and status in ('running','paused');
  if v_id is not null then
    v_row:=public.mannsathi_focus_reconcile(v_id,v_now);
    if v_row.status='completed' then v_finished:=public.mannsathi_focus_projection(v_id,v_now);
    else v_active:=public.mannsathi_focus_projection(v_id,v_now); end if;
  end if;
  return jsonb_build_object('active',v_active,'finished',v_finished,'server_now',v_now,'prefs',public.mannsathi_focus_prefs());
end; $$;

create function public.mannsathi_focus_edit_subject(p_id uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$ declare v_user uuid:=public.mannsathi_focus_require_student(); v_data jsonb; v_row public.study_subjects; begin
  v_data:=public.mannsathi_focus_subject_fields(p_data,true);
  perform pg_advisory_xact_lock(hashtextextended(v_user::text,0));
  perform public.mannsathi_focus_state();
  select * into v_row from public.study_subjects where id=p_id and user_id=v_user for update;
  if not found then raise exception 'Subject not found' using errcode='PT404'; end if;
  if (v_data->>'archived')::boolean and exists(select 1 from public.focus_sessions
      where user_id=v_user and subject_id=p_id and status in ('running','paused')) then
    raise exception 'End the active session before archiving its subject' using errcode='PT409';
  end if;
  if v_row.archived and not (v_data->>'archived')::boolean and
      (select count(*) from public.study_subjects where user_id=v_user and not archived)>=100 then
    raise exception 'You can keep up to 100 active subjects' using errcode='PT409';
  end if;
  update public.study_subjects set name=v_data->>'name',color=v_data->>'color',
    weekly_goal_minutes=(v_data->>'weekly_goal_minutes')::integer,archived=(v_data->>'archived')::boolean,
    updated_at=clock_timestamp() where id=p_id returning * into v_row;
  return jsonb_build_object('subject',to_jsonb(v_row));
exception when unique_violation then raise exception 'An active subject already has that name' using errcode='PT409';
end; $$;

create function public.mannsathi_focus_start(p_session_id uuid, p_subject_id uuid, p_task_id uuid,
  p_planned_minutes integer, p_time_zone text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$ declare v_user uuid:=public.mannsathi_focus_require_student(); v_now timestamptz:=clock_timestamp();
  v_existing public.focus_sessions; begin
  if p_session_id is null or p_subject_id is null or p_planned_minutes is null or p_planned_minutes not between 1 and 180 then
    raise exception 'Invalid focus start fields' using errcode='PT400';
  end if;
  perform public.mannsathi_focus_zone(p_time_zone);
  perform pg_advisory_xact_lock(hashtextextended(v_user::text,0));
  v_now:=clock_timestamp();
  select * into v_existing from public.focus_sessions where id=p_session_id;
  if found then
    if v_existing.user_id<>v_user then raise exception 'Focus session not found' using errcode='PT404'; end if;
    if v_existing.subject_id<>p_subject_id or v_existing.task_id is distinct from p_task_id or
      v_existing.planned_seconds<>p_planned_minutes*60 or v_existing.time_zone<>p_time_zone then
      raise exception 'This session ID was already used for a different session' using errcode='PT409';
    end if;
    perform public.mannsathi_focus_reconcile(p_session_id,v_now);
    return jsonb_build_object('session',public.mannsathi_focus_projection(p_session_id,v_now),'server_now',v_now);
  end if;
  perform public.mannsathi_focus_state();
  if exists(select 1 from public.focus_sessions where user_id=v_user and status in ('running','paused')) then
    raise exception 'A focus session is already active' using errcode='PT409';
  end if;
  if not exists(select 1 from public.study_subjects where id=p_subject_id and user_id=v_user and not archived) then
    raise exception 'Subject not found' using errcode='PT404';
  end if;
  if p_task_id is not null and not public.mannsathi_task_can_read(p_task_id) then
    raise exception 'Task not found' using errcode='PT404';
  end if;
  -- Set the timestamp after any lock wait; waiting for a competing request is
  -- never counted as study time.
  v_now:=clock_timestamp();
  insert into public.focus_sessions(id,user_id,subject_id,task_id,status,planned_seconds,started_at,last_started_at,time_zone)
    values(p_session_id,v_user,p_subject_id,p_task_id,'running',p_planned_minutes*60,v_now,v_now,p_time_zone);
  insert into public.focus_segments(user_id,session_id,started_at) values(v_user,p_session_id,v_now);
  return jsonb_build_object('session',public.mannsathi_focus_projection(p_session_id,v_now),'server_now',v_now);
end; $$;

create function public.mannsathi_focus_transition(p_id uuid, p_action text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$ declare v_user uuid:=public.mannsathi_focus_require_student(); v_now timestamptz; v_row public.focus_sessions;
  v_seconds numeric; begin
  if p_action is null or p_action not in ('pause','resume','finish','interrupt','cancel') then
    raise exception 'Invalid focus action' using errcode='PT400';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text,0));
  v_now:=clock_timestamp();
  v_row:=public.mannsathi_focus_reconcile(p_id,v_now);
  if v_row.status in ('completed','interrupted','cancelled') then
    return jsonb_build_object('session',public.mannsathi_focus_projection(p_id,v_now),'server_now',v_now);
  end if;
  if p_action='finish' then raise exception 'The focus interval is not finished yet' using errcode='PT409'; end if;
  if p_action='pause' and v_row.status='running' then
    v_seconds:=least(v_row.planned_seconds,v_row.focused_seconds+greatest(0,extract(epoch from v_now-v_row.last_started_at)));
    update public.focus_segments set ended_at=v_now where session_id=p_id and user_id=v_user and ended_at is null;
    update public.focus_sessions set status='paused',focused_seconds=v_seconds,last_started_at=null,paused_at=v_now where id=p_id;
  elsif p_action='resume' and v_row.status='paused' then
    update public.focus_sessions set status='running',last_started_at=v_now,paused_at=null where id=p_id;
    insert into public.focus_segments(user_id,session_id,started_at) values(v_user,p_id,v_now);
  elsif p_action in ('interrupt','cancel') then
    v_seconds:=least(v_row.planned_seconds,v_row.focused_seconds+
      case when v_row.status='running' then greatest(0,extract(epoch from v_now-v_row.last_started_at)) else 0 end);
    update public.focus_segments set ended_at=v_now where session_id=p_id and user_id=v_user and ended_at is null;
    update public.focus_sessions set status=case when p_action='cancel' then 'cancelled' else 'interrupted' end,
      focused_seconds=case when p_action='cancel' then 0 else v_seconds end,
      last_started_at=null,paused_at=null,finished_at=v_now where id=p_id;
  end if;
  return jsonb_build_object('session',public.mannsathi_focus_projection(p_id,v_now),'server_now',v_now);
end; $$;

create function public.mannsathi_focus_range_seconds(p_start timestamptz, p_end timestamptz, p_subject uuid default null)
returns numeric language sql stable security definer set search_path=pg_catalog,public
as $$ select coalesce(sum(greatest(0,extract(epoch from least(g.ended_at,p_end)-greatest(g.started_at,p_start)))),0)
  from public.focus_segments g join public.focus_sessions f on f.id=g.session_id and f.user_id=g.user_id
  where g.user_id=auth.uid() and public.mannsathi_focus_is_student() and f.status in ('completed','interrupted')
    and g.ended_at is not null and g.started_at<p_end and g.ended_at>p_start
    and (p_subject is null or f.subject_id=p_subject) $$;

create function public.mannsathi_focus_summary(p_time_zone text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$ declare v_user uuid:=public.mannsathi_focus_require_student(); v_now timestamptz; v_date date; v_week date;
  v_subjects jsonb; v_daily jsonb; v_history jsonb; v_total numeric; v_count bigint; begin
  perform public.mannsathi_focus_zone(p_time_zone);
  perform public.mannsathi_focus_state();
  v_now:=clock_timestamp(); v_date:=(v_now at time zone p_time_zone)::date;
  v_week:=date_trunc('week',v_now at time zone p_time_zone)::date;
  select coalesce(sum(focused_seconds),0),count(*) filter(where status='completed') into v_total,v_count
    from public.focus_sessions where user_id=v_user and status in ('completed','interrupted');
  select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'color',s.color,'archived',s.archived,
    'weekly_goal_minutes',s.weekly_goal_minutes,
    'total_seconds',coalesce((select sum(f.focused_seconds) from public.focus_sessions f
      where f.user_id=v_user and f.subject_id=s.id and f.status in ('completed','interrupted')),0),
    'week_seconds',public.mannsathi_focus_range_seconds(v_week::timestamp at time zone p_time_zone,
      (v_week+7)::timestamp at time zone p_time_zone,s.id)) order by s.archived,lower(s.name),s.id),'[]'::jsonb)
    into v_subjects from public.study_subjects s where s.user_id=v_user;
  select jsonb_agg(jsonb_build_object('date',v_date-i,'seconds',public.mannsathi_focus_range_seconds(
    (v_date-i)::timestamp at time zone p_time_zone,(v_date-i+1)::timestamp at time zone p_time_zone)) order by i desc)
    into v_daily from generate_series(0,13) i;
  select coalesce(jsonb_agg(public.mannsathi_focus_projection(q.id,v_now) order by q.finished_at desc,q.id),'[]'::jsonb)
    into v_history from (select id,finished_at from public.focus_sessions where user_id=v_user
      and status in ('completed','interrupted','cancelled') order by finished_at desc,id limit 20) q;
  return jsonb_build_object('total_seconds',v_total,'completed_sessions',v_count,'subjects',v_subjects,'daily',v_daily,
    'today_seconds',public.mannsathi_focus_range_seconds(v_date::timestamp at time zone p_time_zone,
      (v_date+1)::timestamp at time zone p_time_zone),
    'week_seconds',public.mannsathi_focus_range_seconds(v_week::timestamp at time zone p_time_zone,
      (v_week+7)::timestamp at time zone p_time_zone),'history',v_history,'server_now',v_now);
end; $$;

create function public.mannsathi_focus_history(p_start date, p_end date, p_time_zone text, p_offset integer default 0, p_limit integer default 500)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$ declare v_user uuid:=public.mannsathi_focus_require_student(); v_rows jsonb; v_now timestamptz; begin
  perform public.mannsathi_focus_zone(p_time_zone);
  if p_start is null or p_end is null or not isfinite(p_start) or not isfinite(p_end) or p_end<p_start or p_end-p_start>365 or
    p_offset is null or p_offset<0 or p_offset>10000 or p_limit is null or p_limit not between 1 and 500 then
    raise exception 'Choose a history range of at most 366 days' using errcode='PT400';
  end if;
  perform public.mannsathi_focus_state(); v_now:=clock_timestamp();
  select coalesce(jsonb_agg(public.mannsathi_focus_projection(q.id,v_now) order by q.finished_at desc,q.id),'[]'::jsonb)
    into v_rows from (select id,finished_at from public.focus_sessions where user_id=v_user
      and status in ('completed','interrupted','cancelled') and started_at<(p_end+1)::timestamp at time zone p_time_zone
      and finished_at>=p_start::timestamp at time zone p_time_zone
      order by finished_at desc,id offset p_offset limit p_limit) q;
  return v_rows;
end; $$;

-- Keep mutating helpers private. RPCs verify the authenticated identity again;
-- table grants expose only the student's own rows through FORCE RLS.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'mannsathi_focus_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  end loop;
end; $$;
grant execute on function public.mannsathi_focus_is_student(),public.mannsathi_focus_subjects(),
  public.mannsathi_focus_create_subject(jsonb),public.mannsathi_focus_edit_subject(uuid,jsonb),
  public.mannsathi_focus_state(),public.mannsathi_focus_save_prefs(jsonb),
  public.mannsathi_focus_start(uuid,uuid,uuid,integer,text),public.mannsathi_focus_transition(uuid,text),
  public.mannsathi_focus_summary(text),public.mannsathi_focus_history(date,date,text,integer,integer) to authenticated;
notify pgrst,'reload schema';
commit;
