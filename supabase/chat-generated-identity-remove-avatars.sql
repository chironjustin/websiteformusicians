-- Remove avatar requirements from the server-generated one-click chat identity flow.
-- This is forward-only and safe to run after chat-generated-identity-migration.sql.

alter table public.event_chat_participants
alter column avatar_id drop not null;

alter table public.event_chat_participants
drop constraint if exists event_chat_participants_avatar_id_check;

alter table public.chat_messages
drop constraint if exists chat_messages_avatar_id_check;

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
  names text[];
  base_name text;
  candidate_name text;
  normalized_candidate text;
  suffix text;
  attempt integer;
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

  names := public.chat_generated_first_names();
  base_name := names[1 + floor(random() * array_length(names, 1))::int];

  for attempt in 0..8 loop
    if attempt = 0 then
      candidate_name := left(base_name, 16);
    else
      suffix := (10 + floor(random() * 990)::int)::text;
      candidate_name := left(base_name, greatest(1, 16 - char_length(suffix))) || suffix;
    end if;

    normalized_candidate := public.normalize_chat_name(candidate_name);

    if normalized_candidate in ('admin', 'artist', 'moderator', 'system', 'support') then
      continue;
    end if;

    if normalized_candidate = public.normalize_chat_name(event_artist_name) then
      continue;
    end if;

    begin
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

        if existing_participant.id is not null then
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

  candidate_name := 'Aiko' || (1000 + floor(random() * 9000)::int)::text;
  normalized_candidate := public.normalize_chat_name(candidate_name);

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
end;
$$;

revoke all on function public.join_event_chat(uuid, uuid) from public;
grant execute on function public.join_event_chat(uuid, uuid) to anon, authenticated;

drop function if exists public.submit_chat_message(uuid, uuid, text, text, text, uuid);

create or replace function public.submit_chat_message(
  p_event_id uuid,
  p_participant_id uuid,
  p_body text,
  p_client_token uuid
)
returns public.chat_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_body text;
  participant public.event_chat_participants;
  inserted_message public.chat_messages;
begin
  normalized_body := btrim(regexp_replace(coalesce(p_body, ''), '[[:space:]]+', ' ', 'g'));

  if p_event_id is null then
    raise exception 'A current live event is required.';
  end if;

  if p_participant_id is null then
    raise exception 'A reserved chat identity is required.';
  end if;

  if p_client_token is null then
    raise exception 'A client token is required.';
  end if;

  if normalized_body = '' or char_length(normalized_body) > 500 then
    raise exception 'Message must be between 1 and 500 characters.';
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
    raise exception 'Chat is open only during a live event.';
  end if;

  select *
  into participant
  from public.event_chat_participants
  where event_chat_participants.id = p_participant_id
    and event_chat_participants.event_id = p_event_id;

  if participant.id is null then
    raise exception 'A reserved chat identity is required.';
  end if;

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

  return inserted_message;
end;
$$;

revoke all on function public.submit_chat_message(uuid, uuid, text, uuid) from public;
grant execute on function public.submit_chat_message(uuid, uuid, text, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
