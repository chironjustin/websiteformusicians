-- Server-generated one-click live chat identities.
-- Safe to rerun after supabase/chat-participants-migration.sql.

alter table public.event_chat_participants
add column if not exists session_id uuid;

alter table public.event_chat_participants

alter table public.event_chat_participants
alter column avatar_id drop not null;

alter table public.event_chat_participants
drop constraint if exists event_chat_participants_avatar_id_check;

alter table public.chat_messages
drop constraint if exists chat_messages_avatar_id_check;

create unique index if not exists event_chat_participants_event_session_idx
on public.event_chat_participants(event_id, session_id)
where session_id is not null;

revoke select, insert, update, delete on public.event_chat_participants from anon, authenticated;

drop policy if exists "Public can read live event chat participants" on public.event_chat_participants;

do $$
begin
  if to_regprocedure('public.reserve_event_chat_identity(uuid, text, text, text)') is not null then
    revoke all on function public.reserve_event_chat_identity(uuid, text, text, text) from public, anon, authenticated;
  end if;

  if to_regprocedure('public.reserve_event_chat_identity(uuid, uuid, text, text, text)') is not null then
    revoke all on function public.reserve_event_chat_identity(uuid, uuid, text, text, text) from public, anon, authenticated;
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
  created_at timestamptz
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
      return query
        select
          existing_participant.id,
          existing_participant.event_id,
          existing_participant.session_id,
          existing_participant.display_name,
          existing_participant.normalized_name,
          existing_participant.created_at;
      return;
    end if;

    should_reassign_existing := true;
  end if;

  if existing_participant.id is not null and should_reassign_existing = false then
    return query
      select
        existing_participant.id,
        existing_participant.event_id,
        existing_participant.session_id,
        existing_participant.display_name,
        existing_participant.normalized_name,
        existing_participant.created_at;
    return;
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
        raise log 'chat_name_suffix base_name=% suffix_number=% suffix_added=%', base_name, suffix_number, true;
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
              normalized_name = normalized_candidate
          where event_chat_participants.id = existing_participant.id
          returning * into inserted_participant;
        else
          insert into public.event_chat_participants (
            event_id,
            session_id,
            display_name,
            normalized_name
          )
          values (
            p_event_id,
            p_session_id,
            candidate_name,
            normalized_candidate
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
            inserted_participant.created_at;
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
                existing_participant.created_at;
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

drop function if exists public.submit_chat_message(uuid, text, text, uuid);
drop function if exists public.submit_chat_message(uuid, uuid, text, text, text, uuid);
drop function if exists public.submit_chat_message(uuid, uuid, text, uuid);

create or replace function public.submit_chat_message(
  p_event_id uuid,
  p_participant_id uuid,
  p_body text,
  p_client_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_body text;
  participant public.event_chat_participants;
  inserted_message public.chat_messages;
  existing_message public.chat_messages;
  recent_count integer;
  oldest_recent_at timestamptz;
  retry_after_seconds integer;
begin
  normalized_body := btrim(coalesce(p_body, ''));

  if p_event_id is null then
    return jsonb_build_object('ok', false, 'code', 'EVENT_NOT_LIVE', 'message', 'Chat is open only during a live event.');
  end if;

  if p_client_token is null then
    return jsonb_build_object('ok', false, 'code', 'MESSAGE_ALREADY_SUBMITTED', 'message', 'Message could not be submitted.');
  end if;

  if p_participant_id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PARTICIPANT', 'message', 'A reserved chat identity is required.');
  end if;

  if coalesce(p_body, '') ~ '[[:cntrl:]]' then
    return jsonb_build_object('ok', false, 'code', 'MESSAGE_INVALID_CHARACTERS', 'message', 'Message contains unsupported characters.');
  end if;

  if normalized_body = '' then
    return jsonb_build_object('ok', false, 'code', 'MESSAGE_EMPTY', 'message', 'Message cannot be empty.');
  end if;

  if char_length(normalized_body) > 400 then
    return jsonb_build_object('ok', false, 'code', 'MESSAGE_TOO_LONG', 'message', 'Message must be 400 characters or fewer.');
  end if;

  if not exists (
    select 1
    from public.events
    where events.id = p_event_id
      and events.status in ('upcoming', 'live')
      and events.starts_at is not null
      and events.ends_at is not null
      and events.starts_at <= now()
      and events.ends_at > now()
  ) then
    return jsonb_build_object('ok', false, 'code', 'EVENT_NOT_LIVE', 'message', 'Chat is open only during a live event.');
  end if;

  select *
  into participant
  from public.event_chat_participants
  where event_chat_participants.id = p_participant_id
    and event_chat_participants.event_id = p_event_id;

  if participant.id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PARTICIPANT', 'message', 'A reserved chat identity is required.');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_event_id::text || ':' || p_participant_id::text));

  select *
  into existing_message
  from public.chat_messages
  where chat_messages.event_id = p_event_id
    and chat_messages.participant_id = p_participant_id
    and chat_messages.client_token = p_client_token
  limit 1;

  if existing_message.id is not null then
    return jsonb_build_object('ok', true, 'duplicate', true, 'message', to_jsonb(existing_message));
  end if;

  select count(*)::integer, min(created_at)
  into recent_count, oldest_recent_at
  from public.chat_messages
  where chat_messages.event_id = p_event_id
    and chat_messages.participant_id = p_participant_id
    and chat_messages.is_admin = false
    and chat_messages.created_at > now() - interval '2 minutes';

  if recent_count >= 3 then
    retry_after_seconds := greatest(
      1,
      ceiling(extract(epoch from ((oldest_recent_at + interval '2 minutes') - now())))::integer
    );

    return jsonb_build_object(
      'ok', false,
      'code', 'MESSAGE_RATE_LIMITED',
      'message', 'Wait a little till sending again.',
      'retryAfterSeconds', retry_after_seconds
    );
  end if;

  begin
    insert into public.chat_messages (
      event_id,
      participant_id,
      user_id,
      display_name,
      body,
      status,
      client_token,
      is_admin,
      is_pinned,
      is_highlighted,
      is_liked,
      legacy_assignment_confirmed_at,
      legacy_assignment_confirmed_by
    )
    values (
      p_event_id,
      participant.id,
      null,
      participant.display_name,
      normalized_body,
      'pending',
      p_client_token,
      false,
      false,
      false,
      false,
      null,
      null
    )
    returning * into inserted_message;
  exception
    when unique_violation then
      select *
      into existing_message
      from public.chat_messages
      where chat_messages.event_id = p_event_id
        and chat_messages.participant_id = p_participant_id
        and chat_messages.client_token = p_client_token
      limit 1;

      if existing_message.id is not null then
        return jsonb_build_object('ok', true, 'duplicate', true, 'message', to_jsonb(existing_message));
      end if;

      raise;
  end;

  return jsonb_build_object('ok', true, 'duplicate', false, 'message', to_jsonb(inserted_message));
end;
$$;

revoke all on function public.submit_chat_message(uuid, uuid, text, uuid) from public;
grant execute on function public.submit_chat_message(uuid, uuid, text, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
