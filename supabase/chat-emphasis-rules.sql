-- Event-scoped chat emphasis rules.
-- Run after supabase/chat-schema.sql.
--
-- Likes remain unlimited. Pinning and highlighting are each limited to one
-- message per event through these atomic RPC helpers.

create or replace function public.set_chat_message_pin(
  message_id uuid,
  pinned boolean
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
  where chat_messages.id = message_id
    and events.owner_id = auth.uid();

  if target_event_id is null then
    raise exception 'Chat message not found or not owned by current user.';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_event_id::text));

  if pinned then
    update public.chat_messages
    set is_pinned = false
    where event_id = target_event_id
      and id <> message_id
      and is_pinned = true;
  end if;

  update public.chat_messages
  set is_pinned = pinned
  where id = message_id
    and event_id = target_event_id;
end;
$$;

revoke all on function public.set_chat_message_pin(uuid, boolean) from public;
grant execute on function public.set_chat_message_pin(uuid, boolean) to authenticated;

create or replace function public.set_chat_message_highlight(
  message_id uuid,
  highlighted boolean
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
  where chat_messages.id = message_id
    and events.owner_id = auth.uid();

  if target_event_id is null then
    raise exception 'Chat message not found or not owned by current user.';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_event_id::text));

  if highlighted then
    update public.chat_messages
    set is_highlighted = false
    where event_id = target_event_id
      and id <> message_id
      and is_highlighted = true;
  end if;

  update public.chat_messages
  set is_highlighted = highlighted
  where id = message_id
    and event_id = target_event_id;
end;
$$;

revoke all on function public.set_chat_message_highlight(uuid, boolean) from public;
grant execute on function public.set_chat_message_highlight(uuid, boolean) to authenticated;
