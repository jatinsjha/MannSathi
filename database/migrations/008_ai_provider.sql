-- Apply manually after 007. Snapshots are written only by the trusted Google sync.
begin;

create table public.ai_quota_snapshots (
  project text not null check (project ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$'),
  model text not null check (model ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,149}$'),
  metric text not null check (metric in ('RPM','TPM','RPD')),
  metric_id text not null check (metric_id ~ '^generativelanguage[.]googleapis[.]com/quota/(generate_content_(free_tier|paid_tier(_[1-9][0-9]*)?)_(requests|input_token_count)|generate_requests_per_model)$'),
  limit_name text not null check (limit_name ~ '^[A-Za-z0-9_-]{1,200}$'),
  window_start timestamptz not null,
  window_end timestamptz not null check (window_end > window_start),
  reported_limit bigint not null check (reported_limit >= 0),
  consumption bigint check (consumption >= 0),
  synced_at timestamptz not null default now(),
  check ((metric='TPM') = (right(metric_id,17)='input_token_count')),
  check (strpos(limit_name,'PerModel')>0 and ((metric='RPD' and strpos(limit_name,'PerDay')>0 and strpos(limit_name,'PerMinute')=0)
    or (metric in ('RPM','TPM') and strpos(limit_name,'PerMinute')>0 and strpos(limit_name,'PerDay')=0))),
  check (isfinite(window_start) and isfinite(window_end) and window_end<=synced_at
    and window_end=date_trunc('minute',window_end)
    and ((metric in ('RPM','TPM') and window_start=window_end-interval '1 minute')
      or (metric='RPD' and (window_start at time zone 'America/Los_Angeles')::time=time '00:00'
        and ((window_end-interval '1 microsecond') at time zone 'America/Los_Angeles')::date=(window_start at time zone 'America/Los_Angeles')::date))),
  primary key(project,model,metric_id,limit_name,window_end)
);
create table public.ai_billing_snapshots (
  project text not null check (project ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$'),
  month_start date not null check (extract(day from month_start)=1),
  amount_usd numeric not null check (amount_usd >= 0 and amount_usd < 1e18),
  billing_through timestamptz not null,
  synced_at timestamptz not null default now(),
  check (isfinite(month_start) and isfinite(billing_through) and billing_through<=synced_at
    and billing_through>=month_start::timestamp at time zone 'UTC'),
  primary key(project,month_start)
);
alter table public.ai_quota_snapshots enable row level security;
alter table public.ai_quota_snapshots force row level security;
alter table public.ai_billing_snapshots enable row level security;
alter table public.ai_billing_snapshots force row level security;
revoke all on public.ai_quota_snapshots,public.ai_billing_snapshots from public,anon,authenticated,service_role;

create function public.mannsathi_ai_import_quota(p_project text,p_model text,p_metric text,p_metric_id text,
  p_limit_name text,p_start timestamptz,p_end timestamptz,p_limit bigint,p_usage bigint) returns void
language sql security definer set search_path=pg_catalog,public as $$
  insert into public.ai_quota_snapshots(project,model,metric,metric_id,limit_name,window_start,window_end,reported_limit,consumption)
  values(p_project,p_model,p_metric,p_metric_id,p_limit_name,p_start,p_end,p_limit,p_usage)
  on conflict (project,model,metric_id,limit_name,window_end) do update set
    reported_limit=excluded.reported_limit,consumption=excluded.consumption,synced_at=now();
$$;
create function public.mannsathi_ai_import_billing(p_project text,p_month date,p_amount numeric,p_through timestamptz) returns void
language sql security definer set search_path=pg_catalog,public as $$
  insert into public.ai_billing_snapshots(project,month_start,amount_usd,billing_through)
  values(p_project,p_month,p_amount,p_through)
  on conflict(project,month_start) do update set amount_usd=excluded.amount_usd,billing_through=excluded.billing_through,synced_at=now()
  where excluded.billing_through >= ai_billing_snapshots.billing_through;
$$;
create function public.mannsathi_ai_provider_snapshot(p_admin_id uuid,p_action text,p_project text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb;
begin
  perform public.mannsathi_ai_assert_admin(p_admin_id);
  if p_action='provider' then
    with latest as (
      select distinct on (model,metric_id,limit_name) * from public.ai_quota_snapshots where project=p_project
      order by model,metric_id,limit_name,window_end desc
    ), measured as (
      select *,100.0*consumption/nullif(reported_limit,0) as used from latest
    )
    select jsonb_build_object('project',p_project,'last_sync',max(synced_at),'metrics',coalesce(jsonb_agg(
      jsonb_build_object('project',project,'model',model,'metric',metric,'metric_id',metric_id,'limit_name',limit_name,
        'window_start',window_start,'window_end',window_end,'reported_limit',reported_limit,'consumption',consumption,
        'remaining',case when consumption is not null then greatest(0,reported_limit-consumption) end,
        'used_pct',round(used,2),'remaining_pct',round(100-used,2),
        'reset_at',null,'synced_at',synced_at) order by model,metric,limit_name),'[]'::jsonb)) into result from measured;
  elsif p_action='billing' then
    select jsonb_build_object('actual_spend',amount_usd,'billing_through',billing_through,
      'last_billing_update',synced_at,'project',project) into result from public.ai_billing_snapshots
      where project=p_project and month_start=date_trunc('month',timezone('UTC',now()))::date;
    result:=coalesce(result,jsonb_build_object('actual_spend',null,'billing_through',null,'last_billing_update',null,'project',p_project));
  elsif p_action='settings' then
    select jsonb_build_object('provider_monitoring',case when exists(select from public.ai_quota_snapshots where project=p_project)
      then 'Snapshots available' when p_project is null then 'Project not configured' else 'Awaiting first quota snapshot' end) into result;
  else raise exception 'Unsupported snapshot report' using errcode='PT400';
  end if;
  return result;
end $$;
revoke all on function public.mannsathi_ai_import_quota(text,text,text,text,text,timestamptz,timestamptz,bigint,bigint),
  public.mannsathi_ai_import_billing(text,date,numeric,timestamptz),public.mannsathi_ai_provider_snapshot(uuid,text,text) from public,anon,authenticated;
grant execute on function public.mannsathi_ai_import_quota(text,text,text,text,text,timestamptz,timestamptz,bigint,bigint),
  public.mannsathi_ai_import_billing(text,date,numeric,timestamptz),public.mannsathi_ai_provider_snapshot(uuid,text,text) to service_role;
notify pgrst,'reload schema';
commit;
