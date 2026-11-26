-- Private inbox read by the project's support operator in the Supabase SQL Editor.
begin;
create schema mannsathi_support_private;
revoke all on schema mannsathi_support_private from public, anon, authenticated;
create table mannsathi_support_private.requests (
  id uuid primary key,
  kind text not null check (kind in ('bug','privacy')),
  email text check (char_length(email) <= 254),
  detail text not null check (char_length(detail) between 10 and 2000),
  source_digest text,
  received_at timestamptz not null default now(),
  resolved_at timestamptz
);
alter table mannsathi_support_private.requests enable row level security;
revoke all on mannsathi_support_private.requests from public, anon, authenticated, service_role;
create index support_requests_received on mannsathi_support_private.requests(received_at);
create index support_requests_source on mannsathi_support_private.requests(source_digest,received_at);

create function mannsathi_support_private.prune() returns void language plpgsql
set search_path = '' as $$
begin
  delete from mannsathi_support_private.requests where received_at < now() - interval '90 days';
  update mannsathi_support_private.requests set source_digest=null
    where source_digest is not null and received_at < now() - interval '24 hours';
end $$;
revoke all on function mannsathi_support_private.prune() from public, anon, authenticated, service_role;

create function public.mannsathi_submit_support(p_id uuid,p_kind text,p_email text,p_detail text,p_source text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare existing mannsathi_support_private.requests%rowtype;
begin
  if p_id is null or p_kind is null or p_kind not in ('bug','privacy') or p_detail is null
     or char_length(btrim(p_detail)) not between 10 and 2000 or p_source is null or p_source !~ '^[0-9a-f]{64}$'
     or (p_kind='privacy' and nullif(p_email,'') is null) or (p_email is not null and char_length(p_email)>254) then
    raise exception 'Invalid support request' using errcode='PT400';
  end if;
  perform pg_advisory_xact_lock(107328920,11);
  select * into existing from mannsathi_support_private.requests where id=p_id;
  if found then
    if existing.kind=p_kind and existing.email is not distinct from p_email and existing.detail=p_detail then return p_id; end if;
    raise exception 'Request conflict' using errcode='PT409';
  end if;
  if (select count(*) from mannsathi_support_private.requests where received_at>=now()-interval '1 hour') >= 120
     or (select count(*) from mannsathi_support_private.requests where source_digest=p_source and received_at>=now()-interval '1 hour') >= 5 then
    raise exception 'Try later' using errcode='PT429';
  end if;
  insert into mannsathi_support_private.requests(id,kind,email,detail,source_digest)
    values(p_id,p_kind,p_email,p_detail,p_source);
  return p_id;
end $$;
revoke all on function public.mannsathi_submit_support(uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.mannsathi_submit_support(uuid,text,text,text,text) to service_role;
-- If pg_cron is installed, schedule retention here. Otherwise schedule the same
-- call with an existing trusted database scheduler as described in the launch guide.
do $$ begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('mannsathi-support-retention','17 * * * *','select mannsathi_support_private.prune()');
  end if;
end $$;
notify pgrst, 'reload schema';
commit;
