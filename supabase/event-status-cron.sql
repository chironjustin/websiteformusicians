-- Automatic event status transitions.
-- Run after supabase/schema.sql.
--
-- This uses Supabase Cron/pg_cron to run once per minute. If pg_cron is not
-- available in your project, enable Supabase Cron in the dashboard and rerun.

create extension if not exists pg_cron with schema extensions;

create or replace function public.update_scheduled_event_statuses()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.events
  set status = 'finished'
  where status in ('upcoming', 'live')
    and ends_at is not null
    and ends_at <= now();

  update public.events
  set status = 'live'
  where status = 'upcoming'
    and starts_at is not null
    and starts_at <= now()
    and (ends_at is null or ends_at > now());
end;
$$;

select cron.unschedule(jobid)
from cron.job
where jobname = 'update-event-statuses';

select cron.schedule(
  'update-event-statuses',
  '* * * * *',
  $$select public.update_scheduled_event_statuses();$$
);

-- Realtime setup reminder:
-- public.events should be included in the supabase_realtime publication so
-- open public/admin clients receive cron-driven upcoming -> live -> finished
-- updates without a page refresh.
-- alter publication supabase_realtime add table public.events;
