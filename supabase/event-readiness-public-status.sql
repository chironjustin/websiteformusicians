-- Prevent incomplete events from being made public.

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

  if nullif(btrim(coalesce(new.title, '')), '') is null then
    missing_fields := array_append(missing_fields, 'title');
    field_errors := field_errors || jsonb_build_object('title', 'Add an event title before starting the event.');
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
before insert or update of status, title, artist_name, starts_at, ends_at, audio_path, artist_image_path, merch_image_path, merch_url
on public.events
for each row
execute function public.validate_event_public_readiness();

do $$
declare
  invalid_public_count integer;
begin
  select count(*)
  into invalid_public_count
  from public.events
  where status in ('upcoming', 'live', 'finished')
    and (
      nullif(btrim(coalesce(audio_path, '')), '') is null
      or nullif(btrim(coalesce(artist_image_path, '')), '') is null
      or nullif(btrim(coalesce(artist_name, '')), '') is null
      or nullif(btrim(coalesce(title, '')), '') is null
      or starts_at is null
      or ends_at is null
      or ends_at <= starts_at
      or (
        (nullif(btrim(coalesce(merch_image_path, '')), '') is not null)
        <>
        (nullif(btrim(coalesce(merch_url, '')), '') is not null)
      )
      or (
        nullif(btrim(coalesce(merch_url, '')), '') is not null
        and btrim(merch_url) !~* '^https://[^[:space:]/?#]+([/?#].*)?$'
      )
    );

  raise notice 'event_readiness_invalid_public_count=%', invalid_public_count;
end;
$$;

notify pgrst, 'reload schema';
