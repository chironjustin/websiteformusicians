-- Event-scoped temporary chat identities.
-- Safe to rerun. Run after supabase/schema.sql and supabase/chat-schema.sql.

create table if not exists public.event_chat_participants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  session_id uuid not null,
  display_name text not null,
  normalized_name text not null,
  avatar_id text not null,
  created_at timestamptz not null default now(),
  constraint event_chat_participants_display_name_length check (char_length(display_name) between 1 and 16),
  constraint event_chat_participants_normalized_name_length check (char_length(normalized_name) between 1 and 16),
  constraint event_chat_participants_avatar_id_check check (avatar_id in ('retro-1', 'retro-2', 'retro-3', 'retro-4', 'retro-5', 'retro-6', 'retro-7', 'retro-8'))
);

create unique index if not exists event_chat_participants_event_normalized_name_idx
on public.event_chat_participants(event_id, normalized_name);

alter table public.event_chat_participants
add column if not exists session_id uuid;

create unique index if not exists event_chat_participants_event_session_idx
on public.event_chat_participants(event_id, session_id)
where session_id is not null;

create index if not exists event_chat_participants_event_created_idx
on public.event_chat_participants(event_id, created_at);

alter table public.chat_messages
add column if not exists participant_id uuid references public.event_chat_participants(id) on delete set null;

alter table public.chat_messages
add column if not exists avatar_id text;

alter table public.chat_messages
drop constraint if exists chat_messages_avatar_id_check;

alter table public.chat_messages
add constraint chat_messages_avatar_id_check
check (
  avatar_id is null
  or avatar_id in ('retro-1', 'retro-2', 'retro-3', 'retro-4', 'retro-5', 'retro-6', 'retro-7', 'retro-8')
);

create index if not exists chat_messages_event_participant_idx
on public.chat_messages(event_id, participant_id)
where participant_id is not null;

alter table public.event_chat_participants enable row level security;

grant select on public.event_chat_participants to anon, authenticated;
revoke insert, update, delete on public.event_chat_participants from anon, authenticated;

drop policy if exists "Public can read live event chat participants" on public.event_chat_participants;
create policy "Public can read live event chat participants"
on public.event_chat_participants
for select
using (
  exists (
    select 1
    from public.events
    where events.id = event_chat_participants.event_id
      and events.status in ('live', 'finished')
  )
);

create or replace function public.normalize_chat_name(p_value text)
returns text
language sql
immutable
set search_path = public
as $$
  select lower(btrim(regexp_replace(coalesce(p_value, ''), '[[:space:]]+', ' ', 'g')));
$$;

drop function if exists public.reserve_event_chat_identity(uuid, text, text, text);

create or replace function public.reserve_event_chat_identity(
  p_event_id uuid,
  p_session_id uuid,
  p_display_name text,
  p_normalized_name text,
  p_avatar_id text
)
returns public.event_chat_participants
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_display_name text;
  clean_normalized_name text;
  event_artist_name text;
  existing_participant public.event_chat_participants;
  inserted_participant public.event_chat_participants;
begin
  clean_display_name := btrim(regexp_replace(coalesce(p_display_name, ''), '[[:space:]]+', ' ', 'g'));
  clean_normalized_name := public.normalize_chat_name(clean_display_name);

  if p_event_id is null then
    raise exception 'chat_event_required';
  end if;

  if p_session_id is null then
    raise exception 'chat_session_required';
  end if;

  if clean_display_name = '' or char_length(clean_display_name) > 16 then
    raise exception 'chat_name_length';
  end if;

  if clean_normalized_name <> public.normalize_chat_name(p_normalized_name) then
    raise exception 'chat_name_invalid';
  end if;

  if p_avatar_id not in ('retro-1', 'retro-2', 'retro-3', 'retro-4', 'retro-5', 'retro-6', 'retro-7', 'retro-8') then
    raise exception 'chat_avatar_invalid';
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

  select *
  into existing_participant
  from public.event_chat_participants
  where event_id = p_event_id
    and session_id = p_session_id
  limit 1;

  if existing_participant.id is not null then
    if existing_participant.normalized_name = public.normalize_chat_name(event_artist_name) then
      raise exception 'chat_name_taken';
    end if;
    return existing_participant;
  end if;

  if clean_normalized_name = public.normalize_chat_name(event_artist_name) then
    raise exception 'chat_name_taken';
  end if;

  insert into public.event_chat_participants (
    event_id,
    session_id,
    display_name,
    normalized_name,
    avatar_id
  )
  values (
    p_event_id,
    p_session_id,
    clean_display_name,
    clean_normalized_name,
    p_avatar_id
  )
  returning * into inserted_participant;

  return inserted_participant;
exception
  when unique_violation then
    raise exception 'chat_name_taken';
end;
$$;

revoke all on function public.reserve_event_chat_identity(uuid, uuid, text, text, text) from public;
grant execute on function public.reserve_event_chat_identity(uuid, uuid, text, text, text) to anon, authenticated;

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
