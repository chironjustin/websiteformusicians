-- Listener count and visitor join-time chat history cutoff.
-- Run after chat-natural-publication-timing.sql.

alter table public.event_chat_participants
add column if not exists joined_at timestamptz;

update public.event_chat_participants
set joined_at = created_at
where joined_at is null;

alter table public.event_chat_participants
alter column joined_at set default now();

alter table public.event_chat_participants
alter column joined_at set not null;

create unique index if not exists event_chat_participants_event_session_idx
on public.event_chat_participants(event_id, session_id)
where session_id is not null;

create index if not exists event_chat_participants_event_joined_idx
on public.event_chat_participants(event_id, joined_at);

create index if not exists chat_messages_event_approved_published_cutoff_idx
on public.chat_messages(event_id, published_at, id)
where status = 'approved';

drop policy if exists "Public can read approved chat messages" on public.chat_messages;
revoke select on public.chat_messages from anon;
grant select on public.chat_messages to authenticated;

create or replace function public.get_event_listener_count(p_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'count',
    coalesce((
      select count(*)::integer
      from public.event_chat_participants
      where event_chat_participants.event_id = p_event_id
    ), 0)
  );
$$;

revoke all on function public.get_event_listener_count(uuid) from public;
grant execute on function public.get_event_listener_count(uuid) to anon, authenticated;

drop function if exists public.get_visitor_visible_chat_messages(uuid, uuid, uuid);

create or replace function public.get_visitor_visible_chat_messages(
  p_event_id uuid,
  p_participant_id uuid,
  p_session_id uuid
)
returns table (
  id uuid,
  event_id uuid,
  participant_id uuid,
  display_name text,
  body text,
  status text,
  client_token uuid,
  is_admin boolean,
  is_pinned boolean,
  is_highlighted boolean,
  is_liked boolean,
  created_at timestamptz,
  updated_at timestamptz,
  published_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with verified_participant as (
    select *
    from public.event_chat_participants
    where event_chat_participants.id = p_participant_id
      and event_chat_participants.event_id = p_event_id
      and event_chat_participants.session_id = p_session_id
    limit 1
  )
  select
    chat_messages.id,
    chat_messages.event_id,
    chat_messages.participant_id,
    chat_messages.display_name,
    chat_messages.body,
    chat_messages.status,
    case
      when chat_messages.participant_id = p_participant_id then chat_messages.client_token
      else null
    end as client_token,
    chat_messages.is_admin,
    chat_messages.is_pinned,
    chat_messages.is_highlighted,
    chat_messages.is_liked,
    chat_messages.created_at,
    chat_messages.updated_at,
    chat_messages.published_at
  from public.chat_messages
  cross join verified_participant
  where chat_messages.event_id = p_event_id
    and exists (
      select 1
      from public.events
      where events.id = chat_messages.event_id
        and events.status in ('live', 'finished')
    )
    and (
      (
        chat_messages.status = 'approved'
        and (
          chat_messages.published_at >= verified_participant.joined_at
          or chat_messages.is_pinned = true
        )
      )
      or chat_messages.participant_id = p_participant_id
    )
  order by
    chat_messages.is_pinned desc,
    case
      when chat_messages.participant_id = p_participant_id then chat_messages.created_at
      else chat_messages.published_at
    end asc nulls last,
    chat_messages.id asc;
$$;

revoke all on function public.get_visitor_visible_chat_messages(uuid, uuid, uuid) from public;
grant execute on function public.get_visitor_visible_chat_messages(uuid, uuid, uuid) to anon, authenticated;

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
  joined_at timestamptz,
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
          existing_participant.joined_at,
          existing_participant.last_seen_at;
      return;
    end if;

    should_reassign_existing := true;
  end if;

  if existing_participant.id is not null and should_reassign_existing = false then
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
        existing_participant.joined_at,
        existing_participant.last_seen_at;
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
            joined_at,
            last_seen_at
          )
          values (
            p_event_id,
            p_session_id,
            candidate_name,
            normalized_candidate,
            now(),
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
            inserted_participant.joined_at,
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
                existing_participant.joined_at,
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

-- Verification after applying:
-- select event_id, count(*) as listener_count
-- from public.event_chat_participants
-- group by event_id
-- order by event_id;
--
-- select id, event_id, display_name, joined_at, created_at
-- from public.event_chat_participants
-- where event_id = '<EVENT_ID>'
-- order by joined_at;
