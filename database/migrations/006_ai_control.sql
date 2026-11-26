-- Manual migration after 005. Run as the trusted Supabase SQL editor administrator.
begin;

do $$
begin
  if not exists (select from pg_roles where rolname=current_user and (rolsuper or rolbypassrls))
     or to_regclass('public.teacher_permissions') is null or to_regclass('public.calendar_exams') is null then
    raise exception 'Review migrations 000–005 and run 006 as the trusted SQL administrator';
  end if;
end $$;

create table public.ai_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  recent_admin_requests timestamptz[] not null default '{}'
);

create table public.ai_global_policy (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default true,
  requests_per_minute bigint check (requests_per_minute between 0 and 1000000000000),
  daily_token_limit bigint check (daily_token_limit between 0 and 1000000000000),
  monthly_token_limit bigint check (monthly_token_limit between 0 and 1000000000000),
  guest_request_limit bigint default 0 check (guest_request_limit between 0 and 1000000000000),
  guest_token_limit bigint default 0 check (guest_token_limit between 0 and 1000000000000),
  warning_thresholds integer[] not null default '{50,75,90,100}',
  monthly_budget numeric check (monthly_budget between 0 and 1000000000),
  updated_at timestamptz not null default now()
);
insert into public.ai_global_policy default values;

create table public.ai_student_policies (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default true,
  daily_token_limit bigint check (daily_token_limit between 0 and 1000000000000),
  monthly_token_limit bigint check (monthly_token_limit between 0 and 1000000000000),
  request_limit bigint check (request_limit between 0 and 1000000000000),
  restricted boolean not null default false,
  restriction_reason text check (length(restriction_reason) <= 500),
  restricted_until timestamptz check (isfinite(restricted_until)),
  updated_at timestamptz not null default now()
);

create table public.ai_model_pricing (
  model text primary key check (model ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,149}$'),
  input_per_million numeric not null check (input_per_million between 0 and 1000000),
  output_per_million numeric not null check (output_per_million between 0 and 1000000),
  updated_at timestamptz not null default now()
);

create table public.ai_usage (
  request_id uuid primary key,
  -- Keep a historical account distinct from guests even after account deletion.
  -- The admission RPC checks the verified account against auth.users.
  user_id uuid,
  retry_of uuid references public.ai_usage(request_id),
  model text not null,
  reported_model text,
  feature text not null,
  created_at timestamptz not null,
  finished_at timestamptz,
  status text not null check (status in ('pending','success','failed','blocked')),
  admitted boolean not null,
  generation_attempted boolean,
  error_category text,
  reserved_tokens integer not null check (reserved_tokens >= 0),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  total_tokens integer check (total_tokens >= 0),
  thought_tokens integer check (thought_tokens >= 0),
  duration_ms integer check (duration_ms >= 0),
  input_per_million numeric,
  output_per_million numeric,
  estimated_cost numeric check (estimated_cost >= 0)
);
create index ai_usage_date on public.ai_usage(created_at desc,request_id desc);
create index ai_usage_user_date on public.ai_usage(user_id,created_at desc,request_id desc);
create index ai_usage_model_date on public.ai_usage(model,created_at desc);
create index ai_usage_status_date on public.ai_usage(status,created_at desc);
create index ai_usage_feature_date on public.ai_usage(feature,created_at desc);
create index ai_usage_admission_rate on public.ai_usage(created_at desc) where admitted;

-- Transactional counters for enforcement only. Reporting aggregates the original records.
create table public.ai_daily_counters (
  scope_key text not null,
  usage_date date not null,
  requests bigint not null check (requests >= 0),
  charged_tokens bigint not null check (charged_tokens >= 0),
  primary key(scope_key,usage_date)
);

create table public.ai_audit (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null,
  action text not null,
  target_user_id uuid,
  previous_value jsonb,
  new_value jsonb,
  reason text,
  created_at timestamptz not null default now()
);
create index ai_audit_date on public.ai_audit(created_at desc,id desc);
create index ai_audit_target_date on public.ai_audit(target_user_id,created_at desc);

-- No browser role has any policy. Supabase's default service_role table grants are
-- removed too: backend writes are possible only through the narrower RPCs below.
do $$
declare t text;
begin
  foreach t in array array['ai_admins','ai_global_policy','ai_student_policies','ai_model_pricing',
    'ai_usage','ai_daily_counters','ai_audit'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('alter table public.%I force row level security',t);
    execute format('revoke all on table public.%I from public,anon,authenticated,service_role',t);
  end loop;
end $$;

create function public.mannsathi_ai_assert_admin(p_admin_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform 1 from public.ai_admins where user_id=p_admin_id for share;
  if not found then raise exception 'Administrator access required' using errcode='PT403'; end if;
end $$;

-- Exact rolling 60-second window, at most 120 instants per administrator.
create function public.mannsathi_ai_admin_gate(p_admin_id uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare recent timestamptz[]; at_time timestamptz;
begin
  select recent_admin_requests into recent from public.ai_admins where user_id=p_admin_id for update;
  if not found then raise exception 'Administrator access required' using errcode='PT403'; end if;
  at_time:=clock_timestamp();
  recent:=array(select t from unnest(recent) t where t > at_time-interval '1 minute');
  if cardinality(recent)>=120 then raise exception 'Admin request limit reached' using errcode='PT429'; end if;
  update public.ai_admins set recent_admin_requests=array_append(recent,at_time) where user_id=p_admin_id;
  return true;
end $$;

-- Called under the singleton policy row lock. Dates use the admission instant in UTC,
-- including settlement of a request that crosses a day/month boundary.
create function public.mannsathi_ai_charge(p_user_id uuid,p_day date,p_tokens bigint,p_requests integer)
returns void language plpgsql set search_path=pg_catalog,public as $$
declare k text;
begin
  foreach k in array array['global',coalesce(p_user_id::text,'guest')] loop
    update public.ai_daily_counters set charged_tokens=charged_tokens+p_tokens,requests=requests+p_requests
      where scope_key=k and usage_date=p_day;
    if not found then
      insert into public.ai_daily_counters(scope_key,usage_date,requests,charged_tokens)
        values(k,p_day,p_requests,p_tokens);
    end if;
  end loop;
end $$;

create function public.mannsathi_ai_denial(
  g public.ai_global_policy,p_user_id uuid,p_day date,p_delta bigint,p_admission boolean,p_now timestamptz
) returns text language plpgsql set search_path=pg_catalog,public as $$
declare
  s public.ai_student_policies;
  global_day bigint; global_month numeric; actor_day bigint; actor_month numeric; actor_requests bigint;
  actor_key text:=coalesce(p_user_id::text,'guest');
begin
  if not g.enabled then return 'global_disabled'; end if;
  if p_user_id is not null then
    select * into s from public.ai_student_policies where user_id=p_user_id;
    if s.enabled is false then return 'student_disabled'; end if;
    if s.restricted and (s.restricted_until is null or s.restricted_until>p_now) then return 'student_restricted'; end if;
  end if;
  if p_admission and g.requests_per_minute is not null and
      (select count(*) from public.ai_usage where admitted and created_at > p_now-interval '1 minute') >= g.requests_per_minute
      then return 'global_rpm'; end if;
  select coalesce(sum(charged_tokens) filter (where scope_key='global' and usage_date=p_day),0),
         coalesce(sum(charged_tokens) filter (where scope_key='global'),0),
         coalesce(sum(charged_tokens) filter (where scope_key=actor_key and usage_date=p_day),0),
         coalesce(sum(charged_tokens) filter (where scope_key=actor_key),0),
         coalesce(sum(requests) filter (where scope_key=actor_key and usage_date=p_day),0)
    into global_day,global_month,actor_day,actor_month,actor_requests
    from public.ai_daily_counters where scope_key in ('global',actor_key)
      and usage_date between date_trunc('month',p_day::timestamp)::date and p_day;
  if global_day+p_delta>g.daily_token_limit then return 'global_daily'; end if;
  if global_month+p_delta>g.monthly_token_limit then return 'global_monthly'; end if;
  if p_user_id is null then
    if p_admission and actor_requests>=g.guest_request_limit then return 'guest_requests'; end if;
    if actor_day+p_delta>g.guest_token_limit then return 'guest_tokens'; end if;
  else
    if p_admission and actor_requests>=s.request_limit then return 'student_requests'; end if;
    if actor_day+p_delta>s.daily_token_limit then return 'student_daily'; end if;
    if actor_month+p_delta>s.monthly_token_limit then return 'student_monthly'; end if;
  end if;
  return null;
end $$;

create function public.mannsathi_ai_reserve(p_request_id uuid,p_user_id uuid,p_retry_of uuid,p_model text,
  p_feature text,p_reserved_tokens integer) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare g public.ai_global_policy; price public.ai_model_pricing; at_time timestamptz; day_utc date; denial text;
begin
  if p_request_id is null or p_model is null or p_model !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,149}$'
    or p_feature is null or p_feature !~ '^[a-z][a-z0-9_]{0,63}$' or p_reserved_tokens is null or p_reserved_tokens<1 then
    raise exception 'Invalid AI reservation' using errcode='PT400';
  end if;
  -- All paths changing capacity or policies acquire this short-lived lock first.
  -- No network/Gemini call takes place inside the transaction.
  select * into strict g from public.ai_global_policy where singleton for update;
  at_time:=clock_timestamp();
  day_utc:=(at_time at time zone 'UTC')::date;
  if p_user_id is not null and not exists (select from auth.users where id=p_user_id and not coalesce(is_anonymous,false)) then
    raise exception 'Account unavailable' using errcode='PT401';
  end if;
  if exists (select from public.ai_usage where request_id=p_request_id) then
    return jsonb_build_object('allowed',false,'code','duplicate');
  end if;
  if p_retry_of is not null and not exists (select from public.ai_usage where request_id=p_retry_of
      and user_id is not distinct from p_user_id and status in ('success','failed','blocked')) then
    return jsonb_build_object('allowed',false,'code','invalid_retry');
  end if;
  denial:=public.mannsathi_ai_denial(g,p_user_id,day_utc,p_reserved_tokens,true,at_time);
  select * into price from public.ai_model_pricing where model=p_model;
  insert into public.ai_usage(request_id,user_id,retry_of,model,feature,created_at,status,admitted,generation_attempted,error_category,
      finished_at,reserved_tokens,input_per_million,output_per_million)
    values(p_request_id,p_user_id,p_retry_of,p_model,p_feature,at_time,case when denial is null then 'pending' else 'blocked' end,
      denial is null,case when denial is not null then false end,denial,case when denial is not null then at_time end,
      case when denial is null then p_reserved_tokens else 0 end,
      price.input_per_million,price.output_per_million);
  if denial is not null then return jsonb_build_object('allowed',false,'code',denial); end if;
  perform public.mannsathi_ai_charge(p_user_id,day_utc,p_reserved_tokens,1);
  return jsonb_build_object('allowed',true);
end $$;

create function public.mannsathi_ai_resize(p_request_id uuid,p_reserved_tokens integer) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare g public.ai_global_policy; u public.ai_usage; day_utc date; delta bigint; denial text; at_time timestamptz;
begin
  if p_reserved_tokens is null or p_reserved_tokens<1 then raise exception 'Invalid AI reservation' using errcode='PT400'; end if;
  select * into strict g from public.ai_global_policy where singleton for update;
  select * into u from public.ai_usage where request_id=p_request_id;
  if not found or u.status<>'pending' then return jsonb_build_object('allowed',false,'code','duplicate'); end if;
  at_time:=clock_timestamp();
  day_utc:=(u.created_at at time zone 'UTC')::date;
  delta:=p_reserved_tokens::bigint-u.reserved_tokens;
  -- A countTokens call can cross midnight. Re-admit the generation in the new
  -- UTC window via a fresh request so old-window capacity cannot fund new work.
  if day_utc<>(at_time at time zone 'UTC')::date then denial:='window_changed';
  else denial:=public.mannsathi_ai_denial(g,u.user_id,day_utc,delta,false,at_time); end if;
  if denial is not null then
    perform public.mannsathi_ai_charge(u.user_id,day_utc,-u.reserved_tokens,0);
    update public.ai_usage set status='blocked',generation_attempted=false,error_category=denial,reserved_tokens=0,finished_at=at_time
      where request_id=p_request_id;
    return jsonb_build_object('allowed',false,'code',denial);
  end if;
  perform public.mannsathi_ai_charge(u.user_id,day_utc,delta,0);
  update public.ai_usage set reserved_tokens=p_reserved_tokens where request_id=p_request_id;
  return jsonb_build_object('allowed',true);
end $$;

create function public.mannsathi_ai_finish(p_request_id uuid,p_status text,p_input_tokens integer,p_output_tokens integer,
    p_total_tokens integer,p_thought_tokens integer,p_duration_ms integer,p_error_category text,p_reported_model text,
    p_generation_attempted boolean default true)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare u public.ai_usage; cost numeric; output_charge bigint; settled_tokens bigint; day_utc date;
begin
  if p_status is null or p_status not in ('success','failed') or p_duration_ms is null or p_duration_ms<0
    or p_input_tokens<0 or p_output_tokens<0 or p_total_tokens<0 or p_thought_tokens<0
    or coalesce(p_input_tokens,0)::bigint+coalesce(p_output_tokens,0)+coalesce(p_thought_tokens,0)>p_total_tokens
    or p_generation_attempted is null or (not p_generation_attempted and (
      p_status<>'failed' or p_input_tokens is not null or p_output_tokens is not null
      or p_total_tokens is not null or p_thought_tokens is not null))
    or (p_status='failed')<>(p_error_category is not null)
    or p_error_category !~ '^[a-z][a-z0-9_]{0,63}$' or length(p_reported_model)>150 then
    raise exception 'Invalid generation metadata' using errcode='PT400';
  end if;
  perform 1 from public.ai_global_policy where singleton for update;
  select * into u from public.ai_usage where request_id=p_request_id;
  if not found or u.status='blocked' then raise exception 'No such admitted request' using errcode='PT404'; end if;
  if u.status<>'pending' then return jsonb_build_object('recorded',true); end if;
  day_utc:=(u.created_at at time zone 'UTC')::date;
  -- A verified pre-generation failure may release its hold. Once generation
  -- started, missing totals keep at least the reservation and any known components.
  settled_tokens:=case when not p_generation_attempted then 0 when p_total_tokens is not null then p_total_tokens
    else greatest(u.reserved_tokens,coalesce(p_input_tokens,0)::bigint+coalesce(p_output_tokens,0)+coalesce(p_thought_tokens,0)) end;
  perform public.mannsathi_ai_charge(u.user_id,day_utc,settled_tokens-u.reserved_tokens,0);
  -- This chat sends only text, without tools. Unclassified tokens, partial metadata
  -- and absent pricing cannot produce a complete estimate. Pricing was captured at admission.
  output_charge:=p_output_tokens::bigint+coalesce(p_thought_tokens,0);
  if p_input_tokens::bigint+output_charge=p_total_tokens then
    cost:=(p_input_tokens*u.input_per_million+output_charge*u.output_per_million)/1000000;
  end if;
  update public.ai_usage set status=p_status,generation_attempted=p_generation_attempted,input_tokens=p_input_tokens,output_tokens=p_output_tokens,
    total_tokens=p_total_tokens,thought_tokens=p_thought_tokens,duration_ms=p_duration_ms,error_category=p_error_category,
    reported_model=p_reported_model,estimated_cost=cost,finished_at=clock_timestamp() where request_id=p_request_id;
  return jsonb_build_object('recorded',true);
end $$;

create function public.mannsathi_ai_admin_change(p_admin_id uuid,p_scope text,p_target uuid,p_values jsonb,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  g public.ai_global_policy; s public.ai_student_policies; price public.ai_model_pricing;
  allowed text[]; field text; val jsonb; prior jsonb; result jsonb; thresholds integer[];
begin
  perform public.mannsathi_ai_assert_admin(p_admin_id);
  if p_scope is null or p_scope not in ('global','student','pricing') or (p_scope='student')<>(p_target is not null)
    or jsonb_typeof(p_values) is distinct from 'object' or p_values='{}'::jsonb or length(p_reason)>500 then
    raise exception 'Invalid policy change' using errcode='PT400';
  end if;
  allowed:=case p_scope
    when 'global' then array['enabled','requests_per_minute','daily_token_limit','monthly_token_limit',
      'guest_request_limit','guest_token_limit','warning_thresholds','monthly_budget']
    when 'student' then array['enabled','daily_token_limit','monthly_token_limit','request_limit','restricted','restriction_reason','restricted_until']
    else array['model','input_per_million','output_per_million'] end;
  for field,val in select key,value from jsonb_each(p_values) loop
    if field<>all(allowed) then raise exception 'Unsupported policy field' using errcode='PT400'; end if;
    if field in ('enabled','restricted') then
      if jsonb_typeof(val)<>'boolean' then raise exception 'Expected true or false' using errcode='PT400'; end if;
    elsif field in ('input_per_million','output_per_million','monthly_budget') then
      if not (field='monthly_budget' and val='null') and jsonb_typeof(val)<>'number' then
        raise exception 'Expected a nonnegative amount' using errcode='PT400';
      end if;
    elsif field in ('model','restriction_reason','restricted_until') then
      if not (field<>'model' and val='null') and jsonb_typeof(val)<>'string' then
        raise exception 'Invalid policy text' using errcode='PT400';
      end if;
      if field='restricted_until' and val<>'null' and
         (p_values->>field) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$' then
        raise exception 'Restriction expiry requires a date, time and time zone' using errcode='PT400';
      end if;
    elsif field='warning_thresholds' then
      if jsonb_typeof(val)<>'array' then raise exception 'Expected a list of warning percentages' using errcode='PT400'; end if;
      if jsonb_array_length(val) not between 1 and 100 or exists (select from jsonb_array_elements(val) as x(v)
          where jsonb_typeof(v)<>'number' or v::text !~ '^[1-9][0-9]?$|^100$') then
        raise exception 'Warning percentages must be whole numbers between 1 and 100' using errcode='PT400';
      end if;
      select array_agg(distinct v::integer order by v::integer) into thresholds from jsonb_array_elements_text(val) x(v);
      if cardinality(thresholds)<>jsonb_array_length(val) then raise exception 'Duplicate warning percentage' using errcode='PT400'; end if;
      p_values:=jsonb_set(p_values,'{warning_thresholds}',to_jsonb(thresholds));
    elsif val<>'null' and (jsonb_typeof(val)<>'number' or val::text !~ '^[0-9]{1,13}$') then
      raise exception 'Use a nonnegative whole limit or null' using errcode='PT400';
    end if;
  end loop;

  select * into strict g from public.ai_global_policy where singleton for update;
  if p_scope='global' then
    prior:=to_jsonb(g);
    g:=jsonb_populate_record(g,p_values);
    update public.ai_global_policy set enabled=g.enabled,requests_per_minute=g.requests_per_minute,
      daily_token_limit=g.daily_token_limit,monthly_token_limit=g.monthly_token_limit,guest_request_limit=g.guest_request_limit,
      guest_token_limit=g.guest_token_limit,warning_thresholds=g.warning_thresholds,monthly_budget=g.monthly_budget,
      updated_at=clock_timestamp() where singleton returning to_jsonb(ai_global_policy.*) into result;
  elsif p_scope='student' then
    if not exists (select from auth.users where id=p_target and not coalesce(is_anonymous,false)) or
      exists (select from public.teacher_permissions where user_id=p_target) or
      exists (select from public.ai_admins where user_id=p_target) then
      raise exception 'Student account unavailable' using errcode='PT404';
    end if;
    select * into s from public.ai_student_policies where user_id=p_target;
    if found then prior:=to_jsonb(s);
    else insert into public.ai_student_policies(user_id) values(p_target) returning * into s; end if;
    s:=jsonb_populate_record(s,p_values);
    if not s.restricted then s.restriction_reason:=null; s.restricted_until:=null; end if;
    update public.ai_student_policies set enabled=s.enabled,daily_token_limit=s.daily_token_limit,
      monthly_token_limit=s.monthly_token_limit,request_limit=s.request_limit,restricted=s.restricted,
      restriction_reason=nullif(btrim(s.restriction_reason),''),restricted_until=s.restricted_until,
      updated_at=clock_timestamp() where user_id=p_target returning to_jsonb(ai_student_policies.*) into result;
  else
    if not p_values ? 'model' then raise exception 'Choose a model' using errcode='PT400'; end if;
    select * into price from public.ai_model_pricing where model=p_values->>'model';
    if found then prior:=to_jsonb(price); end if;
    price:=jsonb_populate_record(price,p_values);
    insert into public.ai_model_pricing(model,input_per_million,output_per_million,updated_at)
      values(price.model,price.input_per_million,price.output_per_million,clock_timestamp())
      on conflict(model) do update set input_per_million=excluded.input_per_million,
        output_per_million=excluded.output_per_million,updated_at=excluded.updated_at
      returning to_jsonb(ai_model_pricing.*) into result;
  end if;
  if (result-'updated_at') is distinct from (prior-'updated_at') then
    insert into public.ai_audit(admin_id,action,target_user_id,previous_value,new_value,reason)
      values(p_admin_id,p_scope||'_changed',p_target,prior,result,nullif(btrim(p_reason),''));
  end if;
  return result;
exception when check_violation or numeric_value_out_of_range or not_null_violation or
  invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
  raise exception 'Invalid policy value or range' using errcode='PT400';
end $$;

-- Supabase projects can have existing default EXECUTE grants on new functions.
revoke all on function
  public.mannsathi_ai_assert_admin(uuid),public.mannsathi_ai_admin_gate(uuid),
  public.mannsathi_ai_charge(uuid,date,bigint,integer),
  public.mannsathi_ai_denial(public.ai_global_policy,uuid,date,bigint,boolean,timestamptz),
  public.mannsathi_ai_reserve(uuid,uuid,uuid,text,text,integer),
  public.mannsathi_ai_resize(uuid,integer),
  public.mannsathi_ai_finish(uuid,text,integer,integer,integer,integer,integer,text,text,boolean),
  public.mannsathi_ai_admin_change(uuid,text,uuid,jsonb,text)
from public, anon, authenticated, service_role;
grant execute on function public.mannsathi_ai_admin_gate(uuid),
  public.mannsathi_ai_reserve(uuid,uuid,uuid,text,text,integer),
  public.mannsathi_ai_resize(uuid,integer),
  public.mannsathi_ai_finish(uuid,text,integer,integer,integer,integer,integer,text,text,boolean),
  public.mannsathi_ai_admin_change(uuid,text,uuid,jsonb,text)
to service_role;

comment on table public.ai_usage is 'Metadata only. Unknown token counts remain NULL. All durations in milliseconds and estimated costs in USD.';
comment on table public.ai_daily_counters is 'UTC admission periods. Pending requests and missing totals conservatively keep their reservation. Never use charged_tokens as a provider-reported measurement.';
notify pgrst,'reload schema';
commit;
