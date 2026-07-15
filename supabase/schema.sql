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
  auto_publish_enabled boolean not null default false,
  queue_paused boolean not null default false,
  next_auto_publish_at timestamptz,
  last_auto_published_at timestamptz,
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

create or replace function public.validate_event_public_readiness()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  missing_fields text[] := array[]::text[];
  field_errors jsonb := '{}'::jsonb;
  clean_merch_url text := nullif(btrim(coalesce(new.merch_url, '')), '');
  has_merch_image boolean := nullif(btrim(coalesce(new.merch_image_path, '')), '') is not null;
  has_merch_url boolean := clean_merch_url is not null;
begin
  if new.status not in ('upcoming', 'live', 'finished') then
    return new;
  end if;

  if nullif(btrim(coalesce(new.audio_path, '')), '') is null then
    missing_fields := array_append(missing_fields, 'song');
    field_errors := field_errors || jsonb_build_object('song', 'Upload a song file before starting the event.');
  end if;

  if nullif(btrim(coalesce(new.artist_image_path, '')), '') is null then
    missing_fields := array_append(missing_fields, 'artistImage');
    field_errors := field_errors || jsonb_build_object('artistImage', 'Upload an artist image before starting the event.');
  end if;

  if nullif(btrim(coalesce(new.artist_name, '')), '') is null then
    missing_fields := array_append(missing_fields, 'artistName');
    field_errors := field_errors || jsonb_build_object('artistName', 'Add an artist name before starting the event.');
  end if;

  if new.starts_at is null then
    missing_fields := array_append(missing_fields, 'startsAt');
    field_errors := field_errors || jsonb_build_object('startsAt', 'Add the event start date and time.');
  end if;

  if new.ends_at is null then
    missing_fields := array_append(missing_fields, 'endsAt');
    field_errors := field_errors || jsonb_build_object('endsAt', 'Add the event end date and time.');
  elsif new.starts_at is not null and new.ends_at <= new.starts_at then
    missing_fields := array_append(missing_fields, 'endsAt');
    field_errors := field_errors || jsonb_build_object('endsAt', 'The event end time must be later than the start time.');
  end if;

  if has_merch_image and not has_merch_url then
    missing_fields := array_append(missing_fields, 'merchUrl');
    field_errors := field_errors || jsonb_build_object('merchUrl', 'Add a merch link or remove the merch image.');
  elsif has_merch_url and not has_merch_image then
    missing_fields := array_append(missing_fields, 'merchImage');
    field_errors := field_errors || jsonb_build_object('merchImage', 'Add a merch image or remove the merch link.');
  end if;

  if has_merch_url and clean_merch_url !~* '^https://[^[:space:]/?#]+([/?#].*)?$' then
    missing_fields := array_append(missing_fields, 'merchUrl');
    field_errors := field_errors || jsonb_build_object('merchUrl', 'Enter a valid HTTPS merch link.');
  end if;

  if coalesce(array_length(missing_fields, 1), 0) > 0 then
    raise exception 'EVENT_NOT_READY'
      using detail = jsonb_build_object(
        'message', 'Complete the required event details before starting the event.',
        'missingFields', missing_fields,
        'fieldErrors', field_errors
      )::text;
  end if;

  return new;
end;
$$;

drop trigger if exists validate_event_public_readiness on public.events;
create trigger validate_event_public_readiness
before insert or update of status, artist_name, starts_at, ends_at, audio_path, artist_image_path, merch_image_path, merch_url
on public.events
for each row
execute function public.validate_event_public_readiness();

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
