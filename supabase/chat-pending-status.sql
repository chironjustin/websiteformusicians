-- Adds per-submission visitor status lookup for pending chat messages.
-- Safe to rerun. Run after supabase/chat-schema.sql on existing projects.

alter table public.chat_messages
add column if not exists client_token uuid;

create index if not exists chat_messages_event_client_token_idx
on public.chat_messages(event_id, client_token)
where client_token is not null;

drop policy if exists "Visitors can submit pending chat messages" on public.chat_messages;
create policy "Visitors can submit pending chat messages"
on public.chat_messages
for insert
to anon, authenticated
with check (
  event_id is not null
  and user_id is null
  and status = 'pending'
  and is_admin = false
  and is_pinned = false
  and is_highlighted = false
  and is_liked = false
  and client_token is not null
  and legacy_assignment_confirmed_at is null
  and legacy_assignment_confirmed_by is null
  and char_length(btrim(display_name)) between 1 and 50
  and char_length(btrim(body)) between 1 and 500
  and exists (
    select 1 from public.events
    where events.id = chat_messages.event_id
      and events.status in ('upcoming', 'live')
      and events.starts_at is not null
      and events.ends_at is not null
      and events.starts_at <= now()
      and events.ends_at > now()
  )
);

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

notify pgrst, 'reload schema';
