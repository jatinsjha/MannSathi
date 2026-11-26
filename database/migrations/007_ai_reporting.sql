-- Manual migration after 006. All reporting runs under a verified admin identity.
begin;

-- Class and division reflect a teacher-approved enrollment. Auth metadata is
-- used only for a display name, never to decide permissions or class membership.
create view public.ai_student_directory as
  select u.id as user_id,
    left(coalesce(nullif(p.full_name,''), nullif(u.raw_user_meta_data->>'full_name',''), u.email, u.id::text),120) as name,
    u.email, b.batch_code as class_code, b.division
  from auth.users u
  left join public.profiles p on p.id=u.id
  left join public.batch_permissions b on b.user_id=u.id and b.status='approved'
  where not coalesce(u.is_anonymous,false)
    and not exists (select 1 from public.teacher_permissions t where t.user_id=u.id)
    and not exists (select 1 from public.ai_admins a where a.user_id=u.id);
revoke all on public.ai_student_directory from public, anon, authenticated, service_role;

-- Group directly in PostgreSQL. The empty group represents the selected period.
-- Known subtotals are accompanied by coverage counts, including pending calls.
create function public.mannsathi_ai_rollup(p_start date,p_end date,p_user uuid)
returns table (
  kind text, bucket text, requests bigint, input_tokens numeric, output_tokens numeric, total_tokens numeric,
  estimated_cost numeric, unknown_tokens bigint, unknown_total bigint, unknown_input bigint, unknown_output bigint, unknown_cost bigint,
  succeeded bigint, failed bigint, blocked bigint, pending bigint, active_users bigint, guest_requests bigint,
  average_tokens numeric, measured_requests bigint, last_active timestamptz
)
language sql stable set search_path=pg_catalog,public as $$
  with observations as (
    select u.*, (u.created_at at time zone 'UTC')::date as day,
      date_trunc('month',u.created_at at time zone 'UTC')::date as month,
      coalesce(u.reported_model,u.model) as used_model,
      u.status<>'blocked' and u.generation_attempted is distinct from false as may_have_usage
    from public.ai_usage u
    where u.created_at>=p_start::timestamp at time zone 'UTC'
      and u.created_at<(p_end+1)::timestamp at time zone 'UTC'
      and (p_user is null or u.user_id=p_user)
  )
  select case when grouping(day)=0 then 'day' when grouping(month)=0 then 'month'
           when grouping(used_model)=0 then 'model' when grouping(user_id)=0 then 'user' else 'summary' end,
    case when grouping(day)=0 then day::text when grouping(month)=0 then month::text
           when grouping(used_model)=0 then used_model when grouping(user_id)=0 then user_id::text end,
    count(*),
    case when count(*) filter(where may_have_usage)=0 then 0 else sum(input_tokens) filter(where may_have_usage) end,
    case when count(*) filter(where may_have_usage)=0 then 0 else sum(output_tokens) filter(where may_have_usage) end,
    case when count(*) filter(where may_have_usage)=0 then 0 else sum(total_tokens) filter(where may_have_usage) end,
    case when count(*) filter(where may_have_usage)=0 then 0 else sum(estimated_cost) filter(where may_have_usage) end,
    count(*) filter(where may_have_usage and (total_tokens is null or input_tokens is null or output_tokens is null)),
    count(*) filter(where may_have_usage and total_tokens is null),
    count(*) filter(where may_have_usage and input_tokens is null),
    count(*) filter(where may_have_usage and output_tokens is null),
    count(*) filter(where may_have_usage and estimated_cost is null),
    count(*) filter(where status='success'),count(*) filter(where status='failed'),
    count(*) filter(where status='blocked'),count(*) filter(where status='pending'),
    count(distinct user_id) filter(where status<>'blocked'), count(*) filter(where user_id is null),
    round(avg(total_tokens) filter(where may_have_usage),2),count(total_tokens) filter(where may_have_usage),max(created_at)
  from observations group by grouping sets((),(day),(month),(used_model),(user_id))
$$;

-- Read a request page from one MVCC snapshot. Empty and out-of-range pages
-- still return the filtered total. Only the named accounting fields leave SQL.
create function public.mannsathi_ai_log_page(p_start date,p_end date,p_filters jsonb,p_page int,p_size int)
returns jsonb language sql stable set search_path=pg_catalog,public as $$
  with matching as not materialized (
    select request_id,user_id,retry_of,created_at,model,reported_model,feature,input_tokens,output_tokens,
      thought_tokens,total_tokens,duration_ms,status,generation_attempted,error_category
    from public.ai_usage u
    where created_at>=p_start::timestamp at time zone 'UTC' and created_at<(p_end+1)::timestamp at time zone 'UTC'
      and (p_filters->>'user_id' is null or user_id=(p_filters->>'user_id')::uuid)
      and (p_filters->>'model' is null or model=p_filters->>'model' or reported_model=p_filters->>'model')
      and (p_filters->>'feature' is null or feature=p_filters->>'feature')
      and (p_filters->>'status' is null or status=p_filters->>'status')
  ), page_rows as (
    select * from matching order by created_at desc, request_id desc limit p_size offset (p_page-1)*p_size
  )
  select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc,r.request_id desc) from page_rows r),'[]'::jsonb),
    'total',(select count(*) from matching),'page',p_page,'page_size',p_size)
$$;

-- Current limit utilization follows the enforcement counters, independently
-- of the date range selected for the student's historical measured tokens.
create function public.mannsathi_ai_students(p_start date,p_end date,p_filters jsonb,p_page int,p_size int)
returns jsonb language sql stable set search_path=pg_catalog,public as $$
  with period as (select (now() at time zone 'UTC')::date as today),
  history as (
    select * from public.mannsathi_ai_rollup(p_start,p_end,(p_filters->>'user_id')::uuid) where kind='user'
  ), current_counters as (
    select c.scope_key, sum(c.charged_tokens) as month_tokens,
      sum(c.charged_tokens) filter(where c.usage_date=d.today) as day_tokens,
      sum(c.requests) filter(where c.usage_date=d.today) as day_requests
    from public.ai_daily_counters c cross join period d
    where c.usage_date between date_trunc('month',d.today)::date and d.today
      and (p_filters->>'user_id' is null or c.scope_key=p_filters->>'user_id')
    group by c.scope_key
  ), roster as (
    select d.*, coalesce(h.requests,0) as requests,
      case when h.bucket is null then 0 else h.input_tokens end as input_tokens,
      case when h.bucket is null then 0 else h.output_tokens end as output_tokens,
      case when h.bucket is null then 0 else h.total_tokens end as total_tokens,
      case when h.bucket is null then 0 else h.estimated_cost end as estimated_cost,
      coalesce(h.unknown_tokens,0) as unknown_tokens,coalesce(h.unknown_total,0) as unknown_total,
      coalesce(h.unknown_input,0) as unknown_input,coalesce(h.unknown_output,0) as unknown_output,
      coalesce(h.unknown_cost,0) as unknown_cost,h.last_active,
      (select max(round(100*x.used/nullif(x.lim,0),2))
       from (values (s.daily_token_limit,coalesce(c.day_tokens,0)),(s.monthly_token_limit,coalesce(c.month_tokens,0)),
         (s.request_limit,coalesce(c.day_requests,0))) as x(lim,used) where x.lim is not null) as usage_pct,
      case when not g.enabled or not coalesce(s.enabled,true)
        or (s.restricted and (s.restricted_until is null or s.restricted_until>now())) then 'restricted'
        when coalesce(c.day_tokens,0)>=s.daily_token_limit or coalesce(c.month_tokens,0)>=s.monthly_token_limit
          or coalesce(c.day_requests,0)>=s.request_limit then 'limit reached'
        else 'enabled' end as access_status,
      g.warning_thresholds
    from public.ai_student_directory d cross join public.ai_global_policy g
    left join history h on h.bucket=d.user_id::text
    left join public.ai_student_policies s on s.user_id=d.user_id
    left join current_counters c on c.scope_key=d.user_id::text
    where (p_filters->>'user_id' is null or d.user_id=(p_filters->>'user_id')::uuid)
      and (p_filters->>'q' is null or strpos(lower(concat_ws(' ',d.name,d.email)),lower(p_filters->>'q'))>0)
      and (p_filters->>'class_code' is null or d.class_code=p_filters->>'class_code')
      and (p_filters->>'division' is null or d.division=p_filters->>'division')
  ), thresholds as (
    select r.*, (select max(t) from unnest(warning_thresholds) t where usage_pct>=t) as warning_pct from roster r
  ), filtered as (
    select * from thresholds where case p_filters->>'status' when 'active' then requests>0 when 'idle' then requests=0
      when 'restricted' then access_status<>'enabled' when 'warning' then warning_pct is not null else true end
  ), ordered as (
    select f.*,row_number() over(order by
        case coalesce(p_filters->>'sort','tokens') when 'tokens' then total_tokens when 'cost' then estimated_cost when 'requests' then requests end desc nulls last,
        case when p_filters->>'sort'='recent' then last_active end desc nulls last, user_id) as ordinal
    from filtered f
  ), page_rows as (select * from ordered order by ordinal limit p_size offset (p_page-1)*p_size)
  select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(r)-'ordinal'-'warning_thresholds' order by ordinal) from page_rows r),'[]'::jsonb),
    'total',(select count(*) from filtered),'page',p_page,'page_size',p_size)
$$;

create function public.mannsathi_ai_report(p_admin_id uuid,p_action text,p_filters jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare
  v_start date := (p_filters->>'start')::date;
  v_end date := (p_filters->>'end')::date;
  v_page int := coalesce((p_filters->>'page')::int,1);
  v_size int := coalesce((p_filters->>'page_size')::int,25);
  v_user uuid := (p_filters->>'user_id')::uuid;
  v_today date := (now() at time zone 'UTC')::date;
  v_result jsonb; v_student jsonb; v_policy jsonb; v_budget numeric; v_cost numeric; v_complete boolean;
begin
  perform public.mannsathi_ai_assert_admin(p_admin_id);
  if p_filters is null or jsonb_typeof(p_filters)<>'object' or v_page not between 1 and 100000
     or v_size not between 1 and 100 then raise exception 'Invalid page' using errcode='PT400'; end if;
  if p_action='settings' then
    return jsonb_build_object('global',(select to_jsonb(g)-'singleton' from public.ai_global_policy g),
      'pricing',coalesce((select jsonb_agg(to_jsonb(r) order by r.model) from public.ai_model_pricing r),'[]'::jsonb));
  elsif p_action='provider' then
    select jsonb_build_object('last_success',max(finished_at) filter(where status='success'),
      'last_failure',max(finished_at) filter(where status='failed' and left(error_category,9)='provider_'),
      'rate_limits',count(*) filter(where error_category='provider_rate_limit' and finished_at>=now()-interval '24 hours'),
      'errors',coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at desc) from (
        select finished_at as created_at,model,error_category from public.ai_usage
        where model=p_filters->>'model' and status='failed' and left(error_category,9)='provider_'
          and finished_at>=now()-interval '24 hours' order by finished_at desc,request_id limit 20
      ) e),'[]'::jsonb)) into v_result from public.ai_usage where model=p_filters->>'model';
    return v_result;
  elsif p_action='billing' then
    v_start:=date_trunc('month',v_today)::date; v_end:=v_today;
  end if;
  if v_start is null or v_end is null or v_end<v_start or v_end-v_start>=366 then
    raise exception 'Invalid date range' using errcode='PT400'; end if;

  if p_action in ('logs','export') then
    v_result:=public.mannsathi_ai_log_page(v_start,v_end,p_filters,
      case when p_action='export' then 1 else v_page end,case when p_action='export' then 10000 else v_size end);
    if p_action='export' and (v_result->>'total')::bigint>10000 then
      raise exception 'Narrow the export date range' using errcode='PT413'; end if;
    return v_result;
  elsif p_action='audit' then
    with matching as not materialized (
      select id,admin_id,action,target_user_id,previous_value,new_value,reason,created_at from public.ai_audit
      where created_at>=v_start::timestamp at time zone 'UTC' and created_at<(v_end+1)::timestamp at time zone 'UTC'
      union all
      select request_id,null::uuid,'request_blocked',user_id,null::jsonb,
        jsonb_build_object('request_id',request_id,'model',model),error_category,created_at
      from public.ai_usage where status='blocked'
        and created_at>=v_start::timestamp at time zone 'UTC' and created_at<(v_end+1)::timestamp at time zone 'UTC'
    ), page_rows as (select * from matching order by created_at desc,id desc limit v_size offset (v_page-1)*v_size)
    select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(a) order by created_at desc,id desc) from page_rows a),'[]'::jsonb),
      'total',(select count(*) from matching),'page',v_page,'page_size',v_size) into v_result;
    return v_result;
  elsif p_action='students' then
    return public.mannsathi_ai_students(v_start,v_end,p_filters,v_page,v_size);
  elsif p_action='student' then
    if v_user is null then raise exception 'Student required' using errcode='PT400'; end if;
    v_student:=public.mannsathi_ai_students(v_start,v_end,jsonb_build_object('user_id',v_user),1,1)->'rows'->0;
    if v_student is null then raise exception 'Student unavailable' using errcode='PT404'; end if;
  elsif p_action not in ('overview','billing') then
    raise exception 'Unknown report' using errcode='PT400';
  end if;

  with groups as materialized (select * from public.mannsathi_ai_rollup(v_start,v_end,v_user)),
  students as (
    select d.name,d.user_id,g.requests,g.total_tokens,g.estimated_cost,g.unknown_tokens,g.unknown_total,g.unknown_cost,g.measured_requests
    from groups g join public.ai_student_directory d on d.user_id::text=g.bucket where g.kind='user'
  ), top_students as (
    select * from students order by case when p_action='billing' then estimated_cost else total_tokens end desc nulls last,user_id limit 10
  )
  select jsonb_build_object('summary',(select to_jsonb(g)-'kind'-'bucket' from groups g where g.kind='summary'),
    'daily',coalesce((select jsonb_agg((to_jsonb(g)-'kind'-'bucket')||jsonb_build_object('day',bucket) order by bucket) from groups g where kind='day'),'[]'::jsonb),
    'monthly',coalesce((select jsonb_agg((to_jsonb(g)-'kind'-'bucket')||jsonb_build_object('month',bucket) order by bucket) from groups g where kind='month'),'[]'::jsonb),
    'models',coalesce((select jsonb_agg((to_jsonb(g)-'kind'-'bucket')||jsonb_build_object('model',bucket) order by total_tokens desc nulls last,bucket) from groups g where kind='model'),'[]'::jsonb),
    'students',coalesce((select jsonb_agg(to_jsonb(t) order by case when p_action='billing' then t.estimated_cost else t.total_tokens end desc nulls last,t.user_id) from top_students t),'[]'::jsonb),
    'student_summary',(select jsonb_build_object('requests',coalesce(sum(requests),0),'unknown_total',coalesce(sum(unknown_total),0),
      'total_tokens',case when sum(unknown_total)>0 and sum(measured_requests)=0 then null else coalesce(sum(total_tokens),0) end) from students),
    'start',v_start,'end',v_end) into v_result;
  if p_action='student' then
    select to_jsonb(p)-'user_id' into v_policy from public.ai_student_policies p where user_id=v_user;
    return (v_result-'students'-'student_summary')||jsonb_build_object('student',v_student,'policy',coalesce(v_policy,
      jsonb_build_object('enabled',true,'restricted',false,'restricted_until',null,'restriction_reason',null,
        'daily_token_limit',null,'monthly_token_limit',null,'request_limit',null)),
      'logs',public.mannsathi_ai_log_page(v_start,v_end,p_filters,v_page,v_size));
  elsif p_action='billing' then
    select monthly_budget into v_budget from public.ai_global_policy;
    v_cost:=(v_result#>>'{summary,estimated_cost}')::numeric;
    v_complete:=(v_result#>>'{summary,unknown_cost}')::bigint=0;
    return (v_result-'summary'-'monthly'-'student_summary')||jsonb_build_object('budget',v_budget,'estimated_cost',v_cost,
      'unknown_cost',(v_result#>>'{summary,unknown_cost}')::bigint,'currency','USD',
      'actual_spend',null,'last_billing_update',null,'budget_basis','estimated_application_cost',
      'remaining_budget',case when v_complete then v_budget-v_cost end,
      'budget_pct',case when v_complete then round(100*v_cost/nullif(v_budget,0),2) end,
      'projection',case when v_complete then v_cost*extract(day from (v_start+interval '1 month'-interval '1 day'))/extract(day from v_today) end,
      'estimated_as_of',now());
  end if;
  return v_result-'monthly';
end;
$$;

revoke all on function public.mannsathi_ai_rollup(date,date,uuid),public.mannsathi_ai_log_page(date,date,jsonb,int,int),
  public.mannsathi_ai_students(date,date,jsonb,int,int), public.mannsathi_ai_report(uuid,text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.mannsathi_ai_report(uuid,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
