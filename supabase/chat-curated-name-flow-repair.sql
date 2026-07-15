-- Repair generated chat identity allocation after the legacy synthetic-name flow.
-- Run after supabase/chat-name-pool-migration.sql.

do $$
begin
  if to_regclass('public.chat_name_pool') is null then
    raise exception 'chat_name_pool_missing';
  end if;

  if to_regprocedure('public.pick_chat_base_name(text)') is null then
    raise exception 'pick_chat_base_name_missing';
  end if;
end;
$$;

drop function if exists public.chat_generated_first_names();
drop function if exists public.join_event_chat(uuid, uuid);

create or replace function public.join_event_chat(
  p_event_id uuid,
  p_session_id uuid
)
returns table (
  id uuid,
  event_id uuid,
  session_id uuid,
  display_name text,
  normalized_name text,
  created_at timestamptz,
  last_seen_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  event_artist_name text;
  existing_participant public.event_chat_participants;
  inserted_participant public.event_chat_participants;
  base_name text;
  base_normalized text;
  candidate_name text;
  normalized_candidate text;
  existing_base_name text;
  should_reassign_existing boolean := false;
  attempt integer;
  suffix_number integer;
begin
  if p_event_id is null then
    raise exception 'chat_event_required';
  end if;

  if p_session_id is null then
    raise exception 'chat_session_required';
  end if;

  select events.artist_name
  into event_artist_name
  from public.events
  where events.id = p_event_id
    and events.status in ('upcoming', 'live')
    and events.starts_at is not null
    and events.ends_at is not null
    and events.starts_at <= now()
    and events.ends_at > now();

  if event_artist_name is null then
    raise exception 'chat_event_not_live';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_event_id::text || ':' || p_session_id::text));

  select *
  into existing_participant
  from public.event_chat_participants
  where event_chat_participants.event_id = p_event_id
    and event_chat_participants.session_id = p_session_id
  limit 1;

  if existing_participant.id is not null then
    existing_base_name := regexp_replace(existing_participant.display_name, '[0-9]+$', '');

    if exists (
      select 1
      from public.chat_name_pool pool
      where pool.is_active = true
        and pool.normalized_name = public.normalize_chat_name(existing_base_name)
    ) then
      update public.event_chat_participants
      set last_seen_at = now()
      where event_chat_participants.id = existing_participant.id
      returning * into existing_participant;

      return query
        select
          existing_participant.id,
          existing_participant.event_id,
          existing_participant.session_id,
          existing_participant.display_name,
          existing_participant.normalized_name,
          existing_participant.created_at,
          existing_participant.last_seen_at;
      return;
    end if;

    should_reassign_existing := true;
  end if;

  for attempt in 1..25 loop
    select picked.base_name, picked.normalized_name
    into base_name, base_normalized
    from public.pick_chat_base_name(event_artist_name) picked
    limit 1;

    if base_name is null then
      raise exception 'chat_name_pool_empty';
    end if;

    perform pg_advisory_xact_lock(hashtext(p_event_id::text || ':' || base_normalized));

    for suffix_number in 1..50 loop
      if suffix_number = 1 then
        candidate_name := left(base_name, 16);
      else
        candidate_name := left(base_name, greatest(1, 16 - char_length(suffix_number::text))) || suffix_number::text;
      end if;

      normalized_candidate := public.normalize_chat_name(candidate_name);

      if normalized_candidate in ('admin', 'administrator', 'artist', 'moderator', 'mod', 'official', 'system', 'support') then
        continue;
      end if;

      if normalized_candidate = public.normalize_chat_name(event_artist_name) then
        continue;
      end if;

      begin
        if should_reassign_existing then
          update public.event_chat_participants
          set display_name = candidate_name,
              normalized_name = normalized_candidate,
              last_seen_at = now()
          where event_chat_participants.id = existing_participant.id
          returning * into inserted_participant;
        else
          insert into public.event_chat_participants (
            event_id,
            session_id,
            display_name,
            normalized_name,
            last_seen_at
          )
          values (
            p_event_id,
            p_session_id,
            candidate_name,
            normalized_candidate,
            now()
          )
          returning * into inserted_participant;
        end if;

        return query
          select
            inserted_participant.id,
            inserted_participant.event_id,
            inserted_participant.session_id,
            inserted_participant.display_name,
            inserted_participant.normalized_name,
            inserted_participant.created_at,
            inserted_participant.last_seen_at;
        return;
      exception
        when unique_violation then
          select *
          into existing_participant
          from public.event_chat_participants
          where event_chat_participants.event_id = p_event_id
            and event_chat_participants.session_id = p_session_id
          limit 1;

          if existing_participant.id is not null and should_reassign_existing = false then
            return query
              select
                existing_participant.id,
                existing_participant.event_id,
                existing_participant.session_id,
                existing_participant.display_name,
                existing_participant.normalized_name,
                existing_participant.created_at,
                existing_participant.last_seen_at;
            return;
          end if;
      end;
    end loop;
  end loop;

  raise exception 'chat_name_allocation_failed';
end;
$$;

revoke all on function public.join_event_chat(uuid, uuid) from public;
grant execute on function public.join_event_chat(uuid, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
