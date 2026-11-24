-- PROPOSED migration. Apply only after reviewing inspect_calendar_schema.sql.
-- For a project without an existing calendar/event table. No existing tables,
-- profiles, batch permissions, or policies are modified. Fails if this table exists.
begin;

create table public.calendar_events (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    title text not null check (char_length(btrim(title)) between 1 and 200),
    description text not null default '' check (char_length(description) <= 5000),
    category text not null default 'other' check (category in (
        'lecture', 'assignment', 'examination', 'practical', 'personal',
        'study_session', 'college_event', 'other'
    )),
    location text not null default '' check (char_length(location) <= 300),
    all_day boolean not null default false,
    starts_at timestamptz,
    ends_at timestamptz,
    start_date date,
    end_date date,
    time_zone text not null check (char_length(time_zone) between 1 and 100),
    reminder_minutes integer check (reminder_minutes in (0, 5, 10, 15, 30, 60, 1440)),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint calendar_event_range check (
        (all_day and starts_at is null and ends_at is null
         and start_date is not null and end_date is not null
         and isfinite(start_date) and isfinite(end_date) and end_date > start_date
         and start_date >= date '1000-01-01' and end_date <= date '9999-12-31')
        or
        (not all_day and start_date is null and end_date is null
         and starts_at is not null and ends_at is not null
         and isfinite(starts_at) and isfinite(ends_at) and ends_at > starts_at
         and starts_at >= timestamptz '1000-01-01 00:00:00+00'
         and ends_at < timestamptz '10000-01-01 00:00:00+00')
    )
);

comment on column public.calendar_events.end_date is 'Exclusive end date for all-day events. The UI shows the inclusive last day.';
comment on column public.calendar_events.time_zone is 'IANA timezone in which the event was created or last edited; timed instants are stored in UTC.';
comment on column public.calendar_events.reminder_minutes is 'Saved reminder preference only. No notification delivery is implemented in this module.';

create index calendar_events_owner_timed on public.calendar_events (user_id, starts_at, ends_at) where not all_day;
create index calendar_events_owner_dates on public.calendar_events (user_id, start_date, end_date) where all_day;

create function public.mannsathi_calendar_guard()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public
as $$
begin
    if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.time_zone) then
        raise exception 'Invalid event timezone' using errcode = '23514';
    end if;
    if tg_op = 'UPDATE' then
        if new.user_id is distinct from old.user_id
           or new.id is distinct from old.id
           or new.created_at is distinct from old.created_at then
            raise exception 'Event identity and ownership are immutable' using errcode = '23514';
        end if;
    end if;
    new.title := btrim(new.title);
    new.updated_at := now();
    return new;
end;
$$;

create trigger calendar_events_guard before insert or update on public.calendar_events
for each row execute function public.mannsathi_calendar_guard();
revoke all on function public.mannsathi_calendar_guard() from public, anon, authenticated;

alter table public.calendar_events enable row level security;
alter table public.calendar_events force row level security;

-- The restrictive policy also blocks broader future permissive policies from
-- accidentally sharing private records. There is no batch-permission bypass.
create policy calendar_owner_boundary on public.calendar_events
as restrictive for all to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy calendar_select_own on public.calendar_events for select to authenticated
using (user_id = (select auth.uid()));
create policy calendar_insert_own on public.calendar_events for insert to authenticated
with check (user_id = (select auth.uid()));
create policy calendar_update_own on public.calendar_events for update to authenticated
using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy calendar_delete_own on public.calendar_events for delete to authenticated
using (user_id = (select auth.uid()));

revoke all on public.calendar_events from public, anon, authenticated;
grant select, delete on public.calendar_events to authenticated;
grant insert (user_id, title, description, category, location, all_day,
              starts_at, ends_at, start_date, end_date, time_zone, reminder_minutes)
on public.calendar_events to authenticated;
grant update (title, description, category, location, all_day,
              starts_at, ends_at, start_date, end_date, time_zone, reminder_minutes)
on public.calendar_events to authenticated;

notify pgrst, 'reload schema';
commit;
