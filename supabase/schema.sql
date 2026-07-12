-- Music event schema for Supabase.
-- Run this in the Supabase SQL editor for the target project.

create extension if not exists "pgcrypto";

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade,
  title text not null,
  artist_name text,
  status text not null default 'draft',
  starts_at timestamptz,
  ends_at timestamptz,
  duration_hours numeric(8, 2),
  audio_path text,
  artwork_path text,
  artist_image_path text,
  merch_image_path text,
  support_url text,
  merch_url text,
  event_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint events_status_check check (status in ('draft', 'upcoming', 'live', 'finished')),
  constraint events_duration_positive check (duration_hours is null or duration_hours > 0),
  constraint events_end_after_start check (starts_at is null or ends_at is null or ends_at > starts_at)
);

create index if not exists events_owner_id_idx on public.events(owner_id);
create index if not exists events_status_starts_at_idx on public.events(status, starts_at desc);
create index if not exists events_updated_at_idx on public.events(updated_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_events_updated_at on public.events;
create trigger set_events_updated_at
before update on public.events
for each row
execute function public.set_updated_at();

alter table public.events enable row level security;

drop policy if exists "Public can read published events" on public.events;
create policy "Public can read published events"
on public.events
for select
using (status in ('upcoming', 'live', 'finished'));

drop policy if exists "Owners can read their own events" on public.events;
create policy "Owners can read their own events"
on public.events
for select
to authenticated
using (owner_id = auth.uid());

drop policy if exists "Owners can insert events" on public.events;
create policy "Owners can insert events"
on public.events
for insert
to authenticated
with check (owner_id = auth.uid());

drop policy if exists "Owners can update events" on public.events;
create policy "Owners can update events"
on public.events
for update
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

drop policy if exists "Owners can delete events" on public.events;
create policy "Owners can delete events"
on public.events
for delete
to authenticated
using (owner_id = auth.uid());

-- Optional but recommended for realtime subscriptions:
-- alter publication supabase_realtime add table public.events;
