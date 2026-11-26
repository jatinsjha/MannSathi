-- Manual after 009. Existing AI chat callers must deploy the pilot-aware backend.
begin;
do $$
begin
  if (select provolatile from pg_proc where oid='public.mannsathi_ai_report(uuid,text,jsonb)'::regprocedure) <> 'v' then
    raise exception 'Apply the AI report fix (009) before launch controls';
  end if;
end $$;

update public.ai_global_policy set requests_per_minute=coalesce(requests_per_minute,20),
  daily_token_limit=coalesce(daily_token_limit,200000),monthly_token_limit=coalesce(monthly_token_limit,2000000),
  guest_request_limit=0,guest_token_limit=0,updated_at=now() where singleton;
alter table public.ai_global_policy
  alter requests_per_minute set default 20, alter requests_per_minute set not null,
  alter daily_token_limit set default 200000, alter daily_token_limit set not null,
  alter monthly_token_limit set default 2000000, alter monthly_token_limit set not null,
  alter guest_request_limit set not null, alter guest_token_limit set not null,
  add constraint ai_no_guest_pilot check (guest_request_limit=0 and guest_token_limit=0);

create table public.ai_adult_pilot (
  user_id uuid primary key references auth.users(id) on delete cascade,
  reviewed_by uuid not null,
  reviewed_at timestamptz not null,
  expires_at timestamptz not null check (expires_at>reviewed_at and expires_at<=reviewed_at+interval '90 days')
);
create index ai_pilot_expiry on public.ai_adult_pilot(expires_at);
alter table public.ai_adult_pilot enable row level security;
alter table public.ai_adult_pilot force row level security;
revoke all on public.ai_adult_pilot from public,anon,authenticated,service_role;

-- Existing paginated student reporting projects d.* from this private view.
create or replace view public.ai_student_directory as
  select u.id as user_id,
    left(coalesce(nullif(p.full_name,''),nullif(u.raw_user_meta_data->>'full_name',''),u.email,u.id::text),120) as name,
    u.email,b.batch_code as class_code,b.division,
    exists(select from public.ai_adult_pilot a where a.user_id=u.id and a.expires_at>statement_timestamp()) as pilot_approved
  from auth.users u left join public.profiles p on p.id=u.id
  left join public.batch_permissions b on b.user_id=u.id and b.status='approved'
  where not coalesce(u.is_anonymous,false)
    and not exists(select from public.teacher_permissions t where t.user_id=u.id)
    and not exists(select from public.ai_admins a where a.user_id=u.id);

-- SQL-editor operation only. Verify age outside the product. No birth date,
-- ID document, document number or image belongs in these records or the audit.
create function public.mannsathi_ai_review_pilot(p_reviewer uuid,p_user_id uuid,p_allow boolean)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare old_expiry timestamptz; at_time timestamptz:=clock_timestamp(); expiry timestamptz; prior_limits jsonb; new_limits jsonb;
begin
  perform public.mannsathi_ai_assert_admin(p_reviewer);
  if p_allow is null or not exists(select from auth.users where id=p_user_id and not coalesce(is_anonymous,false)) then
    raise exception 'Choose an existing non-anonymous pilot account and decision' using errcode='PT400';
  end if;
  perform 1 from public.ai_global_policy where singleton for update;
  select expires_at into old_expiry from public.ai_adult_pilot where user_id=p_user_id;
  if p_allow then
    expiry:=at_time+interval '90 days';
    insert into public.ai_adult_pilot(user_id,reviewed_by,reviewed_at,expires_at)
      values(p_user_id,p_reviewer,at_time,expiry) on conflict(user_id) do update
      set reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at,expires_at=excluded.expires_at;
    select to_jsonb(s) into prior_limits from public.ai_student_policies s where s.user_id=p_user_id;
    insert into public.ai_student_policies as existing(user_id,request_limit,daily_token_limit,monthly_token_limit)
      values(p_user_id,30,20000,200000) on conflict(user_id) do update
      set request_limit=coalesce(existing.request_limit,excluded.request_limit),
          daily_token_limit=coalesce(existing.daily_token_limit,excluded.daily_token_limit),
          monthly_token_limit=coalesce(existing.monthly_token_limit,excluded.monthly_token_limit)
      returning to_jsonb(existing) into new_limits;
    if new_limits is distinct from prior_limits then
      insert into public.ai_audit(admin_id,action,target_user_id,previous_value,new_value,reason)
        values(p_reviewer,'student_changed',p_user_id,prior_limits,new_limits,'Pilot enrollment defaults');
    end if;
  else
    delete from public.ai_adult_pilot where user_id=p_user_id;
    if not found then return; end if;
  end if;
  insert into public.ai_audit(admin_id,action,target_user_id,previous_value,new_value)
    values(p_reviewer,case when p_allow then 'pilot_approved' else 'pilot_revoked' end,p_user_id,
      jsonb_build_object('expires_at',old_expiry),jsonb_build_object('expires_at',expiry));
end $$;

create function public.mannsathi_ai_pilot_eligible(p_user_id uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select from public.ai_adult_pilot a join public.ai_global_policy g on g.singleton
    left join public.ai_student_policies s on s.user_id=a.user_id
    where a.user_id=p_user_id and a.expires_at>statement_timestamp() and g.enabled and coalesce(s.enabled,true)
      and not (coalesce(s.restricted,false) and (s.restricted_until is null or s.restricted_until>statement_timestamp())))
$$;

-- The pre-pilot RPCs stay internal. New server code cannot inadvertently admit
-- users on a database that is still running migration 009.
revoke execute on function public.mannsathi_ai_reserve(uuid,uuid,uuid,text,text,integer),
  public.mannsathi_ai_resize(uuid,integer),public.mannsathi_ai_admin_gate(uuid)
  from public,anon,authenticated,service_role;
-- The MFA-aware backend uses this entry point. Earlier deployed admin handlers
-- can no longer pass their first gate with a password-only access token.
create function public.mannsathi_ai_admin_session(p_admin_id uuid) returns boolean
language sql volatile security definer set search_path=pg_catalog,public as $$
  select public.mannsathi_ai_admin_gate(p_admin_id)
$$;
create function public.mannsathi_ai_pilot_reserve(p_request_id uuid,p_user_id uuid,p_retry_of uuid,p_model text,
  p_feature text,p_reserved_tokens integer) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform 1 from public.ai_global_policy where singleton for update;
  if not exists(select from public.ai_adult_pilot where user_id=p_user_id and expires_at>clock_timestamp()) then
    return jsonb_build_object('allowed',false,'code','ai_unavailable');
  end if;
  return public.mannsathi_ai_reserve(p_request_id,p_user_id,p_retry_of,p_model,p_feature,p_reserved_tokens);
end $$;
create function public.mannsathi_ai_pilot_resize(p_request_id uuid,p_reserved_tokens integer) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare u public.ai_usage;
begin
  perform 1 from public.ai_global_policy where singleton for update;
  select * into u from public.ai_usage where request_id=p_request_id;
  if not found or u.status<>'pending' then return jsonb_build_object('allowed',false,'code','duplicate'); end if;
  if not exists(select from public.ai_adult_pilot where user_id=u.user_id and expires_at>clock_timestamp()) then
    perform public.mannsathi_ai_charge(u.user_id,(u.created_at at time zone 'UTC')::date,-u.reserved_tokens,0);
    update public.ai_usage set status='blocked',generation_attempted=false,error_category='ai_unavailable',
      reserved_tokens=0,finished_at=clock_timestamp() where request_id=p_request_id;
    return jsonb_build_object('allowed',false,'code','ai_unavailable');
  end if;
  return public.mannsathi_ai_resize(p_request_id,p_reserved_tokens);
end $$;

-- Detailed billing/reporting windows remain intact for 366 UTC calendar days.
-- Only aggregate, anonymous measures are retained beyond the detail window.
create table public.ai_archived_months (
  month_start date primary key,
  requests bigint not null,
  metered_requests bigint not null,
  unknown_totals bigint not null,
  known_tokens numeric not null,
  unpriced_requests bigint not null,
  known_estimated_usd numeric not null
);
alter table public.ai_archived_months enable row level security;
alter table public.ai_archived_months force row level security;
revoke all on public.ai_archived_months from public,anon,authenticated,service_role;
alter table public.ai_usage drop constraint ai_usage_retry_of_fkey,
  add constraint ai_usage_retry_of_fkey foreign key(retry_of) references public.ai_usage(request_id) on delete set null;
create index ai_usage_retry_link on public.ai_usage(retry_of) where retry_of is not null;
create index ai_quota_retention on public.ai_quota_snapshots(synced_at);
create index ai_counter_retention on public.ai_daily_counters(usage_date);

create function public.mannsathi_ai_prune() returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  today_utc date:=(now() at time zone 'UTC')::date;
  keep_detail date:=today_utc-365;
  keep_finance date:=(date_trunc('month',today_utc::timestamp)-interval '23 months')::date;
  detail_boundary timestamptz:=keep_detail::timestamp at time zone 'UTC';
  n_usage integer; n_audit integer; n_counters integer; n_quota integer; n_billing integer; n_pilot integer;
begin
  if not pg_try_advisory_xact_lock(617523911) then return jsonb_build_object('busy',true); end if;
  with removed as (
    delete from public.ai_usage where request_id in (select request_id from public.ai_usage
      where created_at<detail_boundary order by created_at,request_id limit 2000) returning *
  ), grouped as (
    select date_trunc('month',created_at at time zone 'UTC')::date as month_start,count(*) as requests,
      count(total_tokens) filter(where status<>'blocked' and generation_attempted is distinct from false) as metered,
      count(*) filter(where status<>'blocked' and generation_attempted is distinct from false and total_tokens is null) as unknown_count,
      coalesce(sum(total_tokens),0) as known_tokens,
      count(*) filter(where status<>'blocked' and generation_attempted is distinct from false and estimated_cost is null) as unpriced,
      coalesce(sum(estimated_cost),0) as cost from removed group by 1
  ), archived as (
    insert into public.ai_archived_months as a select * from grouped where month_start>=keep_finance
      on conflict(month_start) do update set requests=a.requests+excluded.requests,metered_requests=a.metered_requests+excluded.metered_requests,
      unknown_totals=a.unknown_totals+excluded.unknown_totals,known_tokens=a.known_tokens+excluded.known_tokens,
      unpriced_requests=a.unpriced_requests+excluded.unpriced_requests,known_estimated_usd=a.known_estimated_usd+excluded.known_estimated_usd
  ) select count(*) into n_usage from removed;
  delete from public.ai_audit where id in (select id from public.ai_audit where created_at<detail_boundary order by created_at limit 2000);
  get diagnostics n_audit=row_count;
  delete from public.ai_daily_counters where ctid in (select ctid from public.ai_daily_counters where usage_date<keep_detail limit 2000);
  get diagnostics n_counters=row_count;
  delete from public.ai_quota_snapshots where ctid in (select ctid from public.ai_quota_snapshots
    where synced_at<(today_utc-29)::timestamp at time zone 'UTC' order by synced_at limit 2000);
  get diagnostics n_quota=row_count;
  delete from public.ai_billing_snapshots where ctid in (select ctid from public.ai_billing_snapshots where month_start<keep_finance limit 2000);
  get diagnostics n_billing=row_count;
  delete from public.ai_archived_months where month_start<keep_finance;
  delete from public.ai_adult_pilot where user_id in (select user_id from public.ai_adult_pilot where expires_at<=clock_timestamp() limit 2000)
    and expires_at<=clock_timestamp();
  get diagnostics n_pilot=row_count;
  return jsonb_build_object('requests',n_usage,'audit',n_audit,'counters',n_counters,'quota',n_quota,'billing',n_billing,'expired_pilot',n_pilot);
end $$;
revoke all on function public.mannsathi_ai_admin_session(uuid),public.mannsathi_ai_review_pilot(uuid,uuid,boolean),public.mannsathi_ai_pilot_eligible(uuid),
  public.mannsathi_ai_pilot_reserve(uuid,uuid,uuid,text,text,integer),public.mannsathi_ai_pilot_resize(uuid,integer),
  public.mannsathi_ai_prune() from public,anon,authenticated,service_role;
grant execute on function public.mannsathi_ai_admin_session(uuid),public.mannsathi_ai_pilot_eligible(uuid),
  public.mannsathi_ai_pilot_reserve(uuid,uuid,uuid,text,text,integer),public.mannsathi_ai_pilot_resize(uuid,integer) to service_role;
notify pgrst,'reload schema';
-- Install the cleanup on projects which already have Supabase Cron enabled.
do $$ begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('mannsathi-ai-retention','*/10 * * * *','select public.mannsathi_ai_prune()');
  end if;
end $$;
commit;
