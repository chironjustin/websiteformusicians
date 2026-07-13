-- Moderated live chat schema.
-- Run after supabase/schema.sql so public.events and public.set_updated_at exist.

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  display_name text not null,
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
  constraint chat_messages_display_name_length check (char_length(display_name) between 1 and 50),
  constraint chat_messages_body_length check (char_length(body) between 1 and 500)
);

create index if not exists chat_messages_event_status_created_idx on public.chat_messages(event_id, status, created_at);
create index if not exists chat_messages_event_pinned_created_idx on public.chat_messages(event_id, is_pinned desc, created_at);
create index if not exists chat_messages_event_client_token_idx on public.chat_messages(event_id, client_token) where client_token is not null;
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

grant insert on public.chat_messages to authenticated;
revoke insert on public.chat_messages from anon;

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

create or replace function public.submit_chat_message(
  p_event_id uuid,
  p_display_name text,
  p_body text,
  p_client_token uuid
)
returns public.chat_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_display_name text;
  normalized_body text;
  inserted_message public.chat_messages;
begin
  normalized_display_name := btrim(regexp_replace(coalesce(p_display_name, ''), '[[:space:]]+', ' ', 'g'));
  normalized_body := btrim(regexp_replace(coalesce(p_body, ''), '[[:space:]]+', ' ', 'g'));

  if p_event_id is null then
    raise exception 'A current live event is required.';
  end if;

  if p_client_token is null then
    raise exception 'A client token is required.';
  end if;

  if normalized_display_name = '' or char_length(normalized_display_name) > 50 then
    raise exception 'Display name must be between 1 and 50 characters.';
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

  insert into public.chat_messages (
    event_id,
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
    null,
    normalized_display_name,
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

revoke all on function public.submit_chat_message(uuid, text, text, uuid) from public;
grant execute on function public.submit_chat_message(uuid, text, text, uuid) to anon, authenticated;

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
