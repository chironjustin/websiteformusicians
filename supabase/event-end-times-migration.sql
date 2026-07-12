-- Backfill explicit event end timestamps for older duration-based events.
-- Safe to rerun. Run after supabase/schema.sql on existing projects.

alter table public.events
add column if not exists ends_at timestamptz;

update public.events
set ends_at = starts_at + (duration_hours::double precision * interval '1 hour')
where ends_at is null
  and starts_at is not null
  and duration_hours is not null
  and duration_hours > 0;

alter table public.events
drop constraint if exists events_end_after_start;

alter table public.events
add constraint events_end_after_start
check (
  starts_at is null
  or ends_at is null
  or ends_at > starts_at
);
