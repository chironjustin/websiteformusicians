-- Moderated live chat schema.
-- Run after supabase/schema.sql so public.events and public.set_updated_at exist.

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

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete cascade,
  participant_id uuid references public.event_chat_participants(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  display_name text not null,
  avatar_id text,
  body text not null,
  status text not null default 'pending',
  client_token uuid,
  is_admin boolean not null default false,
  is_pinned boolean not null default false,
  is_highlighted boolean not null default false,
  is_liked boolean not null default false,
  legacy_assignment_confirmed_at timestamptz,
  legacy_assignment_confirmed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_messages_status_check check (status in ('pending', 'approved', 'rejected')),
  constraint chat_messages_avatar_id_check check (avatar_id is null or avatar_id in ('retro-1', 'retro-2', 'retro-3', 'retro-4', 'retro-5', 'retro-6', 'retro-7', 'retro-8')),
  constraint chat_messages_display_name_length check (char_length(display_name) between 1 and 50),
  constraint chat_messages_body_length check (char_length(body) between 1 and 500)
);

create unique index if not exists event_chat_participants_event_normalized_name_idx on public.event_chat_participants(event_id, normalized_name);
create unique index if not exists event_chat_participants_event_session_idx on public.event_chat_participants(event_id, session_id) where session_id is not null;
create index if not exists event_chat_participants_event_created_idx on public.event_chat_participants(event_id, created_at);
create index if not exists chat_messages_event_status_created_idx on public.chat_messages(event_id, status, created_at);
create index if not exists chat_messages_event_pinned_created_idx on public.chat_messages(event_id, is_pinned desc, created_at);
create index if not exists chat_messages_event_client_token_idx on public.chat_messages(event_id, client_token) where client_token is not null;
create index if not exists chat_messages_event_participant_idx on public.chat_messages(event_id, participant_id) where participant_id is not null;
create index if not exists chat_messages_created_at_idx on public.chat_messages(created_at);

with ranked_pins as (
  select
    id,
    row_number() over (
      partition by event_id
      order by updated_at desc, created_at desc, id desc
    ) as row_number
  from public.chat_messages
  where event_id is not null
    and is_pinned = true
)
update public.chat_messages
set is_pinned = false
where id in (
  select id from ranked_pins where row_number > 1
);

with ranked_highlights as (
  select
    id,
    row_number() over (
      partition by event_id
      order by updated_at desc, created_at desc, id desc
    ) as row_number
  from public.chat_messages
  where event_id is not null
    and is_highlighted = true
)
update public.chat_messages
set is_highlighted = false
where id in (
  select id from ranked_highlights where row_number > 1
);

create unique index if not exists chat_messages_one_pinned_per_event_idx
on public.chat_messages(event_id)
where event_id is not null
  and is_pinned = true;

create unique index if not exists chat_messages_one_highlighted_per_event_idx
on public.chat_messages(event_id)
where event_id is not null
  and is_highlighted = true;

drop trigger if exists set_chat_messages_updated_at on public.chat_messages;
create trigger set_chat_messages_updated_at
before update on public.chat_messages
for each row
execute function public.set_updated_at();

alter table public.chat_messages enable row level security;
alter table public.event_chat_participants enable row level security;

grant insert on public.chat_messages to authenticated;
revoke insert on public.chat_messages from anon;
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

drop policy if exists "Public can read approved chat messages" on public.chat_messages;
create policy "Public can read approved chat messages"
on public.chat_messages
for select
using (
  status = 'approved'
  and exists (
    select 1 from public.events
    where events.id = chat_messages.event_id
      and events.status in ('live', 'finished')
  )
);

drop policy if exists "Visitors can submit pending chat messages" on public.chat_messages;

create or replace function public.get_visitor_chat_message_status(
  message_id uuid,
  message_event_id uuid,
  message_client_token uuid
)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select status
  from public.chat_messages
  where id = message_id
    and event_id = message_event_id
    and client_token = message_client_token
  limit 1;
$$;

revoke all on function public.get_visitor_chat_message_status(uuid, uuid, uuid) from public;
grant execute on function public.get_visitor_chat_message_status(uuid, uuid, uuid) to anon, authenticated;

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

create or replace function public.submit_chat_message(
  p_event_id uuid,
  p_participant_id uuid,
  p_display_name text,
  p_avatar_id text,
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

  if p_client_token is null then
    raise exception 'A client token is required.';
  end if;

  if p_participant_id is null then
    raise exception 'A reserved chat identity is required.';
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
  where id = p_participant_id
    and event_id = p_event_id
    and display_name = btrim(regexp_replace(coalesce(p_display_name, ''), '[[:space:]]+', ' ', 'g'))
    and avatar_id = p_avatar_id;

  if participant.id is null then
    raise exception 'A reserved chat identity is required.';
  end if;

  insert into public.chat_messages (
    event_id,
    participant_id,
    user_id,
    display_name,
    avatar_id,
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
    participant.avatar_id,
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

revoke all on function public.submit_chat_message(uuid, uuid, text, text, text, uuid) from public;
grant execute on function public.submit_chat_message(uuid, uuid, text, text, text, uuid) to anon, authenticated;

create or replace function public.set_chat_message_pin(
  p_message_id uuid,
  p_pinned boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_event_id uuid;
begin
  select chat_messages.event_id
  into target_event_id
  from public.chat_messages
  join public.events on events.id = chat_messages.event_id
  where chat_messages.id = p_message_id
    and events.owner_id = auth.uid();

  if target_event_id is null then
    raise exception 'Chat message not found or not owned by current user.';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_event_id::text));

  if p_pinned then
    update public.chat_messages
    set is_pinned = false
    where event_id = target_event_id
      and id <> p_message_id
      and is_pinned = true;
  end if;

  update public.chat_messages
  set is_pinned = p_pinned
  where id = p_message_id
    and event_id = target_event_id;
end;
$$;

revoke all on function public.set_chat_message_pin(uuid, boolean) from public;
grant execute on function public.set_chat_message_pin(uuid, boolean) to authenticated;

create or replace function public.set_chat_message_highlight(
  p_message_id uuid,
  p_highlighted boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_event_id uuid;
begin
  select chat_messages.event_id
  into target_event_id
  from public.chat_messages
  join public.events on events.id = chat_messages.event_id
  where chat_messages.id = p_message_id
    and events.owner_id = auth.uid();

  if target_event_id is null then
    raise exception 'Chat message not found or not owned by current user.';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_event_id::text));

  if p_highlighted then
    update public.chat_messages
    set is_highlighted = false
    where event_id = target_event_id
      and id <> p_message_id
      and is_highlighted = true;
  end if;

  update public.chat_messages
  set is_highlighted = p_highlighted
  where id = p_message_id
    and event_id = target_event_id;
end;
$$;

revoke all on function public.set_chat_message_highlight(uuid, boolean) from public;
grant execute on function public.set_chat_message_highlight(uuid, boolean) to authenticated;

drop policy if exists "Owners can read all chat messages" on public.chat_messages;
create policy "Owners can read all chat messages"
on public.chat_messages
for select
to authenticated
using (
  exists (
    select 1 from public.events
    where events.id = chat_messages.event_id
      and events.owner_id = auth.uid()
  )
);

drop policy if exists "Authenticated admins can read unassigned legacy chat messages" on public.chat_messages;
create policy "Authenticated admins can read unassigned legacy chat messages"
on public.chat_messages
for select
to authenticated
using (event_id is null);

drop policy if exists "Owners can insert admin chat messages" on public.chat_messages;
create policy "Owners can insert admin chat messages"
on public.chat_messages
for insert
to authenticated
with check (
  user_id = auth.uid()
  and status = 'approved'
  and is_admin = true
  and exists (
    select 1 from public.events
    where events.id = chat_messages.event_id
      and events.owner_id = auth.uid()
  )
);

drop policy if exists "Owners can moderate chat messages" on public.chat_messages;
create policy "Owners can moderate chat messages"
on public.chat_messages
for update
to authenticated
using (
  exists (
    select 1 from public.events
    where events.id = chat_messages.event_id
      and events.owner_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.events
    where events.id = chat_messages.event_id
      and events.owner_id = auth.uid()
  )
);

drop policy if exists "Authenticated admins can assign unassigned legacy chat messages" on public.chat_messages;
create policy "Authenticated admins can assign unassigned legacy chat messages"
on public.chat_messages
for update
to authenticated
using (event_id is null)
with check (
  exists (
    select 1 from public.events
    where events.id = chat_messages.event_id
      and events.owner_id = auth.uid()
  )
);

drop policy if exists "Owners can delete chat messages" on public.chat_messages;
create policy "Owners can delete chat messages"
on public.chat_messages
for delete
to authenticated
using (
  exists (
    select 1 from public.events
    where events.id = chat_messages.event_id
      and events.owner_id = auth.uid()
  )
);

-- Optional but recommended for realtime subscriptions:
-- alter publication supabase_realtime add table public.chat_messages;

notify pgrst, 'reload schema';
